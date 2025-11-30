const Stripe = require('stripe');
const getRawBody = require('raw-body');

module.exports.config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// REAL PRICING LOGIC (LIVE + TEST)
// - First 20 miles: £90 flat
// - Beyond 20 miles: £90 + £1.80 per extra mile
// - Then rounded to nearest £5 (under £100) or nearest £10 (>= £100)

const BASE_DISTANCE = 20;       // first 20 miles
const BASE_PRICE = 90;          // £90 base
const PER_MILE_RATE = 1.80;     // £1.80 per mile beyond 20 miles

function roundPrice(value) {
  if (value < 100) {
    // Round to nearest £5 for normal jobs
    return Math.round(value / 5) * 5;
  } else {
    // Round to nearest £10 for larger jobs
    return Math.round(value / 10) * 10;
  }
}

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
    console.error('Failed to parse request body in create-checkout-session-v2:', err.message);
    return res.status(400).json({ error: 'Invalid request body' });
  }

  try {
    const {
      pickup,
      dropoff,
      miles,
      whenDate,
      whenTime,
      email,
    } = body || {};

    if (!pickup || !dropoff || !email || !whenDate || !whenTime) {
      return res.status(400).json({
        error: 'Missing required fields: pickup, dropoff, whenDate, whenTime, email',
      });
    }

    // Convert miles to number (0 if blank)
    const milesNum = miles ? parseFloat(miles) : 0;

    let rawPrice = BASE_PRICE;

    if (!Number.isNaN(milesNum) && milesNum > BASE_DISTANCE) {
      const extraMiles = milesNum - BASE_DISTANCE;
      rawPrice += extraMiles * PER_MILE_RATE;
    }

    const finalPrice = roundPrice(rawPrice);
    const amountPence = Math.round(finalPrice * 100);

    console.log('GILEAD V2 REAL pricing (LIVE):', {
      pickup,
      dropoff,
      miles: milesNum,
      rawPrice,
      finalPrice,
      amountPence,
    });

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
              name: `Gilead Courier Job – £${finalPrice.toFixed(2)}`,
              description: `Pickup: ${pickup} → Drop-off: ${dropoff}`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        _version: 'v2',
        pickup,
        dropoff,
        miles: miles || '',
        when_date: whenDate,
        when_time: whenTime,
        email,
        calculated_price: finalPrice.toString(),
      },
      success_url: 'https://www.gileadcouriers.co.uk/?status=success',
      cancel_url: 'https://www.gileadcouriers.co.uk/?status=cancelled',
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Error creating checkout session (v2):', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
