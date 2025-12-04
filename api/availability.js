const getRawBody = require('raw-body');

module.exports.config = { api: { bodyParser: false } };

// Your Make availability webhook URL
const MAKE_AVAILABILITY_WEBHOOK_URL = 'https://hook.eu1.make.com/rnr8xtmiefpm7bmxohb21o676b9dbupe';

module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let body;
  try {
    const raw = await getRawBody(req);
    const text = raw.toString('utf8') || '{}';
    body = JSON.parse(text);
  } catch (err) {
    console.error('Failed to parse request body in /api/availability:', err.message);
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const {
    pickup,
    dropoff,
    miles,
    whenDate,
    whenTime,
  } = body || {};

  if (!pickup || !dropoff || !whenDate || !whenTime) {
    return res.status(400).json({
      error: 'Missing required fields: pickup, dropoff, whenDate, whenTime',
    });
  }

  const payload = {
    pickup,
    dropoff,
    miles: miles || '',
    whenDate,
    whenTime,
  };

  try {
    const resp = await fetch(MAKE_AVAILABILITY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!resp.ok) {
      console.error('Make availability webhook returned non-OK:', resp.status, text);
      return res.status(500).json({
        error: 'Availability check failed',
        details: data,
      });
    }

    // Pass Make’s response back to the browser
    return res.status(200).json(data);
  } catch (err) {
    console.error('Error calling Make availability webhook:', err);
    return res.status(500).json({ error: 'Availability service unreachable' });
  }
};
