const Stripe = require('stripe');
const getRawBody = require('raw-body');

module.exports.config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const buf = await getRawBody(req);
    event = stripe.webhooks.constructEvent(buf, sig, endpointSecret);
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        // Prefer session metadata; if missing, pull from PaymentIntent
        let md = session.metadata || {};
        if ((!md || Object.keys(md).length === 0) && session.payment_intent) {
          try {
            const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
            md = pi.metadata || {};
          } catch (e) {
            console.warn('Could not retrieve PI metadata', e?.message);
          }
        }

        const email =
          session.customer_details?.email ||
          session.customer_email ||
          md.email || 'unknown';
        const amount = ((session.amount_total ?? 0) / 100).toFixed(2);
        const currency = (session.currency || 'gbp').toUpperCase();

        const text =
`✅ Booking Paid
Amount: £${amount} ${currency}
Email: ${email}
Pickup: ${md.pickup || 'N/A'}
Dropoff: ${md.dropoff || 'N/A'}
Miles: ${md.miles || 'N/A'}
When: ${md.when || 'N/A'}
Session: ${session.id}`;

        await notifyTelegram(text);
        break;
      }

      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const md = pi.metadata || {};
        const amount = ((pi.amount_received ?? pi.amount ?? 0) / 100).toFixed(2);
        const currency = (pi.currency || 'gbp').toUpperCase();

        const text =
`✅ Payment Succeeded
Amount: £${amount} ${currency}
Pickup: ${md.pickup || 'N/A'}
Dropoff: ${md.dropoff || 'N/A'}
Miles: ${md.miles || 'N/A'}
When: ${md.when || 'N/A'}
PI: ${pi.id}`;

        await notifyTelegram(text);
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        const text =
`❌ Payment Failed
PI: ${pi.id}
Reason: ${pi.last_payment_error?.message || 'Unknown'}`;
        await notifyTelegram(text);
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        const amount = ((charge.amount_refunded ?? 0) / 100).toFixed(2);
        const currency = (charge.currency || 'gbp').toUpperCase();
        const text =
`↩️ Charge Refunded
Amount: £${amount} ${currency}
Charge: ${charge.id}`;
        await notifyTelegram(text);
        break;
      }

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).send('Server error');
  }
};

async function notifyTelegram(text) {
  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_DISPATCH_CHAT_ID;
  if (!bot || !chat) {
    console.warn('Telegram env vars missing; skipping notify.');
    return;
  }

  try {
    const resp = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: String(text),
        disable_web_page_preview: true
      }),
    });
    const data = await resp.text();
    console.log('Telegram sendMessage status:', resp.status, 'body:', data);
  } catch (e) {
    console.error('Telegram sendMessage error:', e);
  }
}
