/**
 * /api/availability
 * Server-side proxy to Make Availability webhook.
 * Fix: robust JSON extraction to handle malformed Make responses (e.g. leading/trailing junk).
 */

function extractFirstJsonObject(raw) {
  if (!raw || typeof raw !== 'string') return null;

  const s = raw.trim();

  // Fast path: already valid JSON
  try {
    return JSON.parse(s);
  } catch (_) {}

  // Robust path: extract substring from first "{" to last "}"
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;

  const candidate = s.slice(first, last + 1).trim();
  try {
    return JSON.parse(candidate);
  } catch (_) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const url = process.env.MAKE_AVAILABILITY_WEBHOOK_URL;
    if (!url) {
      console.error('Missing MAKE_AVAILABILITY_WEBHOOK_URL env var');
      return res.status(500).json({ error: 'Server misconfigured' });
    }

    const {
      pickup = '',
      dropoff = '',
      miles = '',
      email = '',
      whenDate = '',
      whenTime = ''
    } = req.body || {};

    if (!pickup || !dropoff || !miles || !email || !whenDate || !whenTime) {
      return res.status(400).json({
        error: 'Missing required fields',
        available: false,
        message: 'Missing required fields to check availability.'
      });
    }

    // Call Make (POST)
    const makeResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // IMPORTANT: send exactly what your Make scenario expects
      body: JSON.stringify({ pickup, dropoff, miles, email, whenDate, whenTime }),
    });

    const raw = await makeResp.text();

    // Parse (robust)
    const parsed = extractFirstJsonObject(raw);
    if (!parsed || typeof parsed.available !== 'boolean') {
      console.error('Non-JSON response from Make availability webhook:', raw);
      return res.status(502).json({
        error: 'Bad upstream response',
        available: false,
        message: 'Unexpected response from scheduling system. Please try again.'
      });
    }

    // Always return clean JSON to the frontend
    return res.status(200).json(parsed);

  } catch (err) {
    console.error('Availability handler error:', err);
    return res.status(502).json({
      error: 'Upstream error',
      available: false,
      message: 'Unexpected response from scheduling system. Please try again.'
    });
  }
};
