/**
 * /api/availability
 * Purpose:
 * - Compute scheduleStart / scheduleEnd server-side
 * - Call Make Availability webhook
 * - ALWAYS return a clean, customer-friendly response
 *
 * Friendly behaviour:
 * - Any clash or uncertainty returns:
 *   "That time slot is no longer available. Please choose a different time."
 */

const AVG_MPH = 30;     // Assumed average speed
const BUFFER_MIN = 20;  // Buffer before job

function toIsoEnd(whenDate, whenTime) {
  if (!whenDate || !whenTime) return null;
  const dt = new Date(`${whenDate}T${whenTime}:00.000Z`);
  return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
}

function computeWindow({ whenDate, whenTime, miles }) {
  const scheduleEnd = toIsoEnd(whenDate, whenTime);
  if (!scheduleEnd) return { scheduleStart: null, scheduleEnd: null };

  const milesNum = Number(miles);
  const driveMinutes =
    Number.isFinite(milesNum) && milesNum > 0
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

  try {
    return JSON.parse(s);
  } catch (_) {}

  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;

  try {
    return JSON.parse(s.slice(first, last + 1));
  } catch (_) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({
        available: false,
        message: 'That time slot is no longer available. Please choose a different time.'
      });
    }

    const webhookUrl = process.env.MAKE_AVAILABILITY_WEBHOOK_URL;
    if (!webhookUrl) {
      console.error('MAKE_AVAILABILITY_WEBHOOK_URL missing');
      return res.status(200).json({
        available: false,
        message: 'That time slot is no longer available. Please choose a different time.'
      });
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
      return res.status(200).json({
        available: false,
        message: 'That time slot is no longer available. Please choose a different time.'
      });
    }

    const { scheduleStart, scheduleEnd } = computeWindow({ whenDate, whenTime, miles });

    if (!scheduleStart || !scheduleEnd) {
      return res.status(200).json({
        available: false,
        message: 'That time slot is no longer available. Please choose a different time.'
      });
    }

    const makeResponse = await fetch(webhookUrl, {
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

    const rawText = await makeResponse.text();
    const parsed = extractFirstJsonObject(rawText);

    if (!parsed || typeof parsed.available !== 'boolean') {
      console.error('Malformed Make response:', rawText);
      return res.status(200).json({
        available: false,
        message: 'That time slot is no longer available. Please choose a different time.'
      });
    }

    // Pass through Make result if valid
    if (parsed.available === false) {
      return res.status(200).json({
        available: false,
        message:
          parsed.message ||
          'That time slot is no longer available. Please choose a different time.'
      });
    }

    return res.status(200).json({ available: true });
  } catch (err) {
    console.error('Availability error:', err);
    return res.status(200).json({
      available: false,
      message: 'That time slot is no longer available. Please choose a different time.'
    });
  }
};
