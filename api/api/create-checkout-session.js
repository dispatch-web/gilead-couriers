const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const {
      pickup,
      dropoff,
      miles,
      when,
      email,
    } = req.body || {};

    if (!pickup || !dropoff || !email) {
      return res.status(400).json({
        error: 'Missing required fields: pickup, dropoff, email',
      });
    }

    // For now, keep this simple: flat £90 job price.
    // We can later add: £90 within 20 miles + per-mile beyond that.
    const amountPence = 9000; // £90.00

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
              description: `Pickup: ${pickup} → Drop-off: ${dropoff}`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        pickup,
        dropoff,
        miles: miles || '',
        when: when || '',
        email,
      },
      success_url: 'https://www.gileadcouriers.co.uk/?status=success',
      cancel_url: 'https://www.gileadcouriers.co.uk/?status=cancelled',
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Error creating checkout session:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
