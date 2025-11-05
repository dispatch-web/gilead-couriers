// Vercel serverless function (CommonJS)
// - POST body: { pickup, dropoff, pickupDate, pickupTime, name, email, phone, vehicle, notes, mode: 'quote'|'checkout' }
// - Uses Google Routes API to compute distance + ETA
// - Prices job per Gilead rules and optionally creates a Stripe Checkout session

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const {
      pickup, dropoff, pickupDate, pickupTime,
      name, email, phone, vehicle, notes,
      mode = 'quote'
    } = req.body || {};

    if (!pickup || !dropoff) return res.status(400).json({ error: 'Missing pickup/dropoff' });
    if (!pickupDate || !pickupTime) return res.status(400).json({ error: 'Missing pickup date/time' });
    if (!email || !name) return res.status(400).json({ error: 'Missing contact details' });

    // Build departure time in local UK time, then convert to ISO
    const depLocal = new Date(`${pickupDate}T${pickupTime}:00`);
    // If browser sent local already, still OK—Routes API wants ISO string:
    const departureTimeISO = depLocal.toISOString();

    // --- Get route from Google Routes API
    const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!mapsKey) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY missing' });

    const routesResp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': mapsKey,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration'
      },
      body: JSON.stringify({
        origin: { address: pickup },
        destination: { address: dropoff },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
        departureTime: departureTimeISO
      })
    });

    if (!routesResp.ok) {
      const txt = await routesResp.text();
      console.error('Routes API error:', txt);
      return res.status(502).json({ error: 'Routing failed' });
    }

    const routesJson = await routesResp.json();
    const route = routesJson.routes && routesJson.routes[0];
    if (!route) return res.status(404).json({ error: 'No route found' });

    const meters = Number(route.distanceMeters || 0);
    const seconds = toSeconds(route.duration || '0s');
    const miles = meters / 1609.344;

    const etaText = humanDuration(seconds);

    // --- Pricing rules (designer default for Gilead)
    // Base rules:
    // • Fixed £90 for 0–20 miles
    // • £1.80/mi baseline for miles > 20
    // Surcharges:
    // • Weekend (Sat/Sun): +25%
    // • Out-of-hours 18:00–23:59: +30%
    // • Overnight 00:00–08:59: +50% (supersedes OOH if applicable)
    // Rounding: round UP to nearest whole £
    const base = priceForMiles(miles);
    const surchargeFactor = timeSurchargeFactor(depLocal); // based on pickup date/time UK-local
    const weekendFactor = isWeekend(depLocal) ? 1.25 : 1.0;

    const totalRaw = base * surchargeFactor * weekendFactor;
    const total = roundUp(totalRaw, 1); // nearest £1 up

    const quotePayload = {
      miles,
      meters,
      seconds,
      etaText,
      base,
      factors: { surchargeFactor, weekendFactor },
      total
    };

    if (mode === 'quote') {
      return res.status(200).json(quotePayload);
    }

    // --- Create Stripe Checkout Session (one-off)
    const successUrl = `https://www.gileadcouriers.co.uk/?status=success`;
    const cancelUrl = `https://www.gileadcouriers.co.uk/book.html?status=cancel`;

    const unitAmount = Math.round(total * 100); // pence
    const description = `A-to-B ${pickup} → ${dropoff} · ~${miles.toFixed(1)} mi · ETA ${etaText}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            unit_amount: unitAmount,
            product_data: {
              name: 'Same-day A-to-B Courier',
              description
            }
          },
          quantity: 1
        }
      ],
      metadata: {
        pickup,
        dropoff,
        miles: miles.toFixed(2),
        when: `${pickupDate} ${pickupTime}`,
        name,
        email,
        phone: phone || '',
        vehicle: vehicle || 'transit',
        notes: notes || ''
      }
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-session error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---- helpers

function toSeconds(googleDuration) {
  // e.g. "8332s" or "1h23m45s"
  if (!googleDuration) return 0;
  // very simple parser
  const re = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/;
  const m = String(googleDuration).match(re);
  if (!m) return 0;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return h * 3600 + min * 60 + s;
}

function humanDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  if (h <= 0) return `${m} mins`;
  return `${h} hr ${m} min`;
}

function priceForMiles(miles) {
  const within = Math.max(0, Math.min(miles, 20));
  const over = Math.max(0, miles - 20);
  const fixedWithin = within > 0 ? 90 : 90; // fixed for any trip <= 20mi
  if (miles <= 20) return 90;
  const perMile = 1.80; // baseline (the “+” will be surcharges below)
  return 90 + (over * perMile);
}

function timeSurchargeFactor(dateLocal) {
  // Use pickup local time (assumed browser local; if server TZ diff, consider using Europe/London)
  const hour = dateLocal.getHours();
  // 00:00–08:59 → +50%
  if (hour >= 0 && hour < 9) return 1.50;
  // 18:00–23:59 → +30%
  if (hour >= 18) return 1.30;
  // else within 09:00–17:59
  return 1.00;
}

function isWeekend(d) {
  const day = d.getDay(); // Sun=0
  return day === 0 || day === 6;
}

function roundUp(value, step) {
  // round UP to nearest step (default £1)
  const s = step || 1;
  return Math.ceil(value / s) * s;
}
