const getRawBody = require('raw-body');
const fetch = require('node-fetch'); // Vercel supports this in Node18; if not, global fetch is available

module.exports.config = { api: { bodyParser: false } };

// Make.com webhook URL stored as env var in Vercel
// e.g. AVAILABILITY_WEBHOOK_URL = https://hook.eu1.make.com/xxxx
const MAKE_WEBHOOK_URL = process.env.AVAILABILITY_WEBHOOK_URL;

if (!MAKE_WEBHOOK_URL) {
  console.warn('AVAILABILITY_WEBHOOK_URL is not set. /api/availability will fail until it is configured.');
}

function computeScheduleWindow(whenDate, whenTime, miles) {
  // Very simple estimate:
  // - job "ends" at the requested time
  // - job "starts" earlier based on travel time + buffer
  const milesNum = miles ? parseFloat(miles) : 0;

  const end = new Date(`${whenDate}T${whenTime || '00:00'}:00`);
  if (Number.isNaN(end.getTime())) {
    return { start: null, end: null };
  }

  const speedMph = 30; // assumed average
  const travelHours = milesNum > 0 ? milesNum / speedMph : 1; // fallback 1h
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

  if (!pickup || !dropoff || !whenDate || !whenTime || !email) {
    return res.status(400).json({
      available: false,
      message: 'Missing required fields to check availability.',
    });
  }

  const { start, end } = computeScheduleWindow(whenDate, whenTime, miles);

  const payloadForMake = {
    pickup,
    dropoff,
    miles: miles || '',
    whenDate,
    whenTime,
    email,
    scheduleStart: start,
    scheduleEnd: end,
    // you can add more fields here if your Make scenario expects them
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
      return res.status(502).json({
        available: false,
        message: 'Unexpected response from scheduling system. Please try again.',
      });
    }

    // Expecting something like { available: true } or { available: false, message: '...' }
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
