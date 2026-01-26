const Stripe = require('stripe');
const getRawBody = require('raw-body');

module.exports.config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// ---------- Pricing constants (PR-V1.0) ----------
const BASE_DISTANCE = 20;        // first 20 miles
const BASE_PRICE = 90;           // £90 base
const PER_MILE_RATE = 1.80;      // £1.80 per mile beyond 20 miles

// Round to nearest £5 (default).
// If you truly want nearest £10 for higher values, keep that logic; otherwise set to £5 always.
// NOTE: This matches your original intent to sometimes round to £10 on larger jobs.
function roundPrice(value) {
  if (value < 100) {
    return Math.round(value / 5) * 5;   // nearest £5
  }
  return Math.round(value / 10) * 10;  // nearest £10
}

module.exports = async function (req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Parse raw JSON body
  let body;
  try {
    const raw = await getRawBody(req);
    const text = raw.toString('utf8') || '{}';
    body = JSON.parse(text);
  } catch (err) {
    console.error('Failed to parse request body in create-checkout-session:', err.message);
    return res.status(400).json({ error: 'Invalid request body' });
  }

  try {
    const {
      pickup = '',
      dropoff = '',
      miles = '',
      whenDate = '',
      whenTime = '',
      email = '',
      notes = ''
    } = body || {};

    // Basic validation
    if (!pickup || !dropoff || !email || !whenDate || !whenTime) {
      return res.status(400).json({
        error: 'Missing required fields: pickup, dropoff, whenDate, whenTime, email',
      });
    }

    // Convert miles to number
    const milesNum = miles ? parseFloat(miles) : NaN;
    if (!Number.isFinite(milesNum) || milesNum <= 0) {
      return res.status(400).json({ error: 'Invalid miles' });
    }

    // ---------- Pricing (PR-V1.0) ----------
    // ≤20 miles: £90 fixed
    // >20 miles: £90 + £1.80 per mile over 20
    let rawPrice = BASE_PRICE;

    if (milesNum > BASE_DISTANCE) {
      const extraMiles = milesNum - BASE_DISTANCE;
      rawPrice += extraMiles * PER_MILE_RATE;
    }

    let finalPrice = roundPrice(rawPrice);

    // Enforce absolute minimum charge
    finalPrice = Math.max(finalPrice, BASE_PRICE);

    const amountPence = Math.round(finalPrice * 100);

    console.log('GILEAD pricing (PR-V1.0):', {
      pickup,
      dropoff,
      miles: milesNum,
      rawPrice,
      finalPrice,
      amountPence,
    });

    // Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            unit_amount: amountPence,
            product_data: {
              name: 'Gilead Courier Job',
              description: `Pickup: ${pickup} → Drop-off: ${dropoff} (${milesNum} miles)`,
            },
          },
          quantity: 1,
        },
      ],
      // Metadata: keep consistent so webhooks/Make can rely on these keys
      metadata: {
        pickup: String(pickup),
        dropoff: String(dropoff),
        miles: String(milesNum),
        whenDate: String(whenDate),
        whenTime: String(whenTime),
        email: String(email),
        notes: String(notes || ''),
        calculatedPrice: String(finalPrice),
        pricingRuleVersion: 'PR-V1.0',
      },
      success_url: 'https://www.gileadcouriers.co.uk/?status=success',
      cancel_url: 'https://www.gileadcouriers.co.uk/?status=cancelled',
    });

    return res.status(200).json({ url: session.url, calculatedPrice: finalPrice, currency: 'GBP' });
  } catch (err) {
    console.error('Error creating checkout session:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
