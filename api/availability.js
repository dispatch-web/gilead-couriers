/**
 * /api/availability
 * Computes scheduleStart/scheduleEnd from whenDate/whenTime + miles and calls Make availability webhook.
 */

const AVG_MPH = 30;     // scheduling assumption
const BUFFER_MIN = 20;  // buffer time

function toIsoEnd(whenDate, whenTime) {
  if (!whenDate || !whenTime) return null;
  const dt = new Date(`${whenDate}T${whenTime}:00.000Z`);
  return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
}

function computeWindow({ whenDate, whenTime, miles }) {
  const scheduleEnd = toIsoEnd(whenDate, whenTime);
  if (!scheduleEnd) return { scheduleStart: null, scheduleEnd: null };

  const milesNum = Number(miles);
  const driveMinutes = Number.isFinite(milesNum) && milesNum > 0
    ? (milesNum / AVG_MPH) * 60
    : 60;

  const totalMinutes = driveMinutes + BUFFER_MIN;
  const endMs = new Date(scheduleEnd).getTime();
  const startMs = endMs - totalMinutes * 60 * 1000;

  return {
    scheduleStart: new Date(startMs).toISOString(),
    scheduleEnd
  };
}

function extractFirstJsonObject(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  try { return JSON.parse(s); } catch (_) {}
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const candidate = s.slice(first, last + 1).trim();
  try { return JSON.parse(candidate); } catch (_) { return null; }
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const url = process.env.MAKE_AVAILABILITY_WEBHOOK_URL;
    if (!url) {
      console.error('Missing MAKE_AVAILABILITY_WEBHOOK_URL');
      return res.status(500).json({ error: 'Server misconfigured' });
    }

    const {
      pickup = '',
      dropoff = '',
      miles = '',
      email = '',
      whenDate = '',
      whenTime = '',
      vehicle = 'Main Van'
    } = req.body || {};

    if (!pickup || !dropoff || !miles || !email || !whenDate || !whenTime) {
      return res.status(400).json({
        available: false,
        message: 'Missing required fields to check availability.'
      });
    }

    const { scheduleStart, scheduleEnd } = computeWindow({ whenDate, whenTime, miles });

    if (!scheduleStart || !scheduleEnd) {
      return res.status(400).json({
        available: false,
        message: 'Invalid date/time supplied. Please choose a valid date and time.'
      });
    }

    // Send enriched payload to Make
    const makeResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pickup,
        dropoff,
        miles,
        email,
        whenDate,
        whenTime,
        vehicle,
        scheduleStart,
        scheduleEnd
      })
    });

    const raw = await makeResp.text();
    const parsed = extractFirstJsonObject(raw);

    if (!parsed || typeof parsed.available !== 'boolean') {
      console.error('Non-JSON response from Make availability webhook:', raw);
      return res.status(502).json({
        available: false,
        message: 'Unexpected response from scheduling system. Please try again.'
      });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Availability error:', err);
    return res.status(502).json({
      available: false,
      message: 'Unexpected response from scheduling system. Please try again.'
    });
  }
};
