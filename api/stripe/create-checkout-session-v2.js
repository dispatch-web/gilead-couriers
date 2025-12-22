const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

    const {
      pickup = '',
      dropoff = '',
      miles = '',
      email = '',
      whenDate = '',
      whenTime = '',
      notes = ''
    } = req.body || {};

    // Basic validation
    if (!pickup || !dropoff || !miles || !email || !whenDate || !whenTime) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const milesNum = Number(miles);
    if (!Number.isFinite(milesNum) || milesNum <= 0) {
      return res.status(400).json({ error: 'Invalid miles' });
    }

    // ---------- Pricing (keep consistent with your rules; adjust if you want) ----------
    // Within 20 miles: £90 fixed
    // Beyond 20 miles: £1.80 per mile
    const baseWithin20 = 90;
    const perMile = 1.8;

    let calculated = milesNum <= 20 ? baseWithin20 : (milesNum * perMile);

    // Round to nearest £5 (you can change to 10 if preferred)
    calculated = Math.round(calculated / 5) * 5;

    // For safety, never charge less than £1 in test scenarios if you want:
    // calculated = Math.max(calculated, 1);

    const amountPence = Math.round(calculated * 100);

    // ---------- Schedule window computation ----------
    // We compute scheduleEnd from date+time, then scheduleStart from miles and buffer.
    // This ensures the availability logic and Airtable always have Schedule Start/End.
    const AVG_MPH = 30;     // assumption
    const BUFFER_MIN = 20;  // buffer

    function toISO(dateStr, timeStr) {
      // Expect dateStr "YYYY-MM-DD" and timeStr "HH:MM"
      const dt = new Date(`${dateStr}T${timeStr}:00.000Z`);
      return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
    }

    const scheduleEnd = toISO(whenDate, whenTime);
    if (!scheduleEnd) {
      return res.status(400).json({ error: 'Invalid whenDate/whenTime' });
    }

    const driveMinutes = (milesNum / AVG_MPH) * 60;
    const totalMinutes = driveMinutes + BUFFER_MIN;
    const scheduleStart = new Date(new Date(scheduleEnd).getTime() - totalMinutes * 60 * 1000).toISOString();

    // ---------- URLs ----------
    // Force absolute origin (works behind Vercel)
    const proto = (req.headers['x-forwarded-proto'] || 'https');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = `${proto}://${host}`;

    const success_url = `${origin}/?status=success`;
    const cancel_url = `${origin}/?status=cancel`;

    // ---------- Stripe Checkout Session ----------
    // IMPORTANT: put ALL fields into BOTH session.metadata and payment_intent_data.metadata
    // so your webhook can always retrieve them via session or PI.
    const metadata = {
      pickup: String(pickup),
      dropoff: String(dropoff),
      miles: String(milesNum),
      email: String(email),
      whenDate: String(whenDate),
      whenTime: String(whenTime),
      notes: String(notes || ''),
      scheduleStart: String(scheduleStart),
      scheduleEnd: String(scheduleEnd),
      calculatedPrice: String(calculated)
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      success_url,
      cancel_url,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'gbp',
            unit_amount: amountPence,
            product_data: {
              name: 'Gilead Courier Booking',
              description: `Pickup: ${pickup} → Dropoff: ${dropoff} (${milesNum} miles)`
            }
          }
        }
      ],
      metadata,
      payment_intent_data: {
        metadata
      }
    });

    return res.status(200).json({
      url: session.url,
      calculatedPrice: calculated,
      currency: 'GBP'
    });

  } catch (err) {
    console.error('create-checkout-session-v2 error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
