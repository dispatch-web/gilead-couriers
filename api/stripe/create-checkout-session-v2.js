const Stripe = require('stripe');
const getRawBody = require('raw-body');

module.exports.config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// TEMPORARY LIVE TEST VERSION — EVERYTHING IS £1.00
// After test, we will revert to full pricing formula.

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
    console.error('Failed to parse request body:', err.message);
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

    // Hard-coded £1 test price
    const finalPrice = 1;
    const amountPence = 100;

    console.log('⚠️ LIVE TEST MODE — forcing £1 price for this checkout');

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
              name: `Gilead Courier Job – TEST £1`,
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
    console.error('Error creating checkout session (LIVE £1 test):', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
