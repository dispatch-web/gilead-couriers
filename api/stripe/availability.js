const getRawBody = require('raw-body');

module.exports.config = { api: { bodyParser: false } };

// Prefer MAKE_AVAILABILITY_WEBHOOK_URL (what you already created in Vercel),
// but also allow AVAILABILITY_WEBHOOK_URL as a fallback.
const MAKE_WEBHOOK_URL =
  process.env.MAKE_AVAILABILITY_WEBHOOK_URL || process.env.AVAILABILITY_WEBHOOK_URL;

if (!MAKE_WEBHOOK_URL) {
  console.warn(
    'No availability webhook URL set. Set MAKE_AVAILABILITY_WEBHOOK_URL or AVAILABILITY_WEBHOOK_URL in Vercel.'
  );
}

// Simple helper: estimate start/end of the job window from miles + requested end time
function computeScheduleWindow(whenDate, whenTime, miles) {
  const milesNum = miles ? parseFloat(miles) : 0;

  const end = new Date(`${whenDate}T${whenTime || '00:00'}:00`);
  if (Number.isNaN(end.getTime())) {
    return { start: null, end: null };
  }

  const speedMph = 30; // assumed average
  const travelHours = milesNum > 0 ? milesNum / speedMph : 1; // default 1h
  const travelMinutes = travelHours * 60;
  const bufferMinutes = 30; // loading/unloading buffer
  const totalMinutes = travelMinutes + bufferMinutes;

  const start = new Date(end.getTime() - totalMinutes * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  if (!MAKE_WEBHOOK_URL) {
    return res.status(500).json({
      available: false,
      message: 'Booking system configuration error. Please try again later.',
    });
  }

  let body;
  try {
    const raw = await getRawBody(req);
    const text = raw.toString('utf8') || '{}';
    body = JSON.parse(text);
  } catch (err) {
    console.error('Failed to parse request body in /api/availability:', err.message);
    return res.status(400).json({
      available: false,
      message: 'Invalid request body.',
    });
  }

  const {
    pickup,
    dropoff,
    miles,
    whenDate,
    whenTime,
    email,
  } = body || {};

  // Work out which fields look "missing"
  const missing = [];
  if (!pickup) missing.push('pickup');
  if (!dropoff) missing.push('dropoff');
  if (!whenDate) missing.push('whenDate');
  if (!whenTime) missing.push('whenTime');
  // email is useful, but not required for availability

  if (missing.length > 0) {
    return res.status(400).json({
      available: false,
      message: `Missing required fields to check availability: ${missing.join(', ')}`,
    });
  }

  const { start, end } = computeScheduleWindow(whenDate, whenTime, miles);

  const payloadForMake = {
    pickup,
    dropoff,
    miles: miles || '',
    whenDate,
    whenTime,
    email: email || '',
    scheduleStart: start,
    scheduleEnd: end,
  };

  try {
    const makeResp = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadForMake),
    });

    const text = await makeResp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error('Non-JSON response from Make availability webhook:', text);

      // If Make returns its default "Accepted" text, treat this as "available: true"
      if (text && text.trim() === 'Accepted') {
        return res.status(200).json({
          available: true,
        });
      }

      // Anything else non-JSON we still treat as an error
      return res.status(502).json({
        available: false,
        message: 'Unexpected response from scheduling system. Please try again.',
      });
    }

    // We expect { available: true } or { available: false, message: '...' }
    if (typeof data.available !== 'boolean') {
      console.warn('Make response missing "available" flag:', data);
      return res.status(502).json({
        available: false,
        message: 'Invalid response from scheduling system. Please try again.',
      });
    }

    // Pass through whatever Make responded with
    return res.status(200).json(data);
  } catch (err) {
    console.error('Error calling Make availability webhook:', err);
    return res.status(502).json({
      available: false,
      message: 'Unable to contact scheduling system. Please try again.',
    });
  }
};
