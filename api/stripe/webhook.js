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

  // Dual-secret: LIVE + TEST
  const liveSecret = process.env.STRIPE_WEBHOOK_SECRET_LIVE;
  const testSecret = process.env.STRIPE_WEBHOOK_SECRET; // TEST secret (existing)
  if (!liveSecret && !testSecret) {
    console.error('No webhook secrets configured');
    return res.status(500).send('Server misconfigured');
  }

  let event;
  let modeLabel = 'UNKNOWN';

  try {
    const buf = await getRawBody(req);

    // Try LIVE first (if configured)
    if (liveSecret) {
      try {
        event = stripe.webhooks.constructEvent(buf, sig, liveSecret);
        modeLabel = 'LIVE';
      } catch (errLive) {
        console.warn('Live webhook verification failed, trying TEST...', errLive.message);
      }
    }

    // If LIVE didn’t work, try TEST
    if (!event && testSecret) {
      try {
        event = stripe.webhooks.constructEvent(buf, sig, testSecret);
        modeLabel = 'TEST';
      } catch (errTest) {
        console.error('Test webhook verification failed:', errTest.message);
        return res.status(400).send(`Webhook Error: ${errTest.message}`);
      }
    }

    if (!event) {
      console.error('Webhook could not be verified with any secret');
      return res.status(400).send('Webhook Error: Unable to verify event');
    }
  } catch (err) {
    console.error('Error reading raw body or verifying signature:', err.message);
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
          md.email ||
          'unknown';
        const amount = ((session.amount_total ?? 0) / 100).toFixed(2);
        const currency = (session.currency || 'gbp').toUpperCase();

        const jobRef = session.id ? session.id.slice(-8).toUpperCase() : 'UNKNOWN';

        // Version & date/time
        const version = md._version || 'unknown';

        const whenDate = md.when_date || md.whenDate || '';
        const whenTime = md.when_time || md.whenTime || '';
        let whenLine = 'When: N/A';
        if (whenDate || whenTime) {
          if (whenDate && whenTime) {
            whenLine = `When: ${whenDate} at ${whenTime}`;
          } else if (whenDate) {
            whenLine = `When: ${whenDate}`;
          } else if (whenTime) {
            whenLine = `When: ${whenTime}`;
          }
        } else if (md.when) {
          whenLine = `When: ${md.when}`;
        }

        const text =
`🚚 GILEAD COURIER – NEW JOB (${modeLabel})
Job ref: ${jobRef}
Version: ${version}

Amount Paid: £${amount} ${currency}
Calculated Price: £${md.calculated_price || amount}

Customer: ${email}

Pickup: ${md.pickup || 'N/A'}
Drop-off: ${md.dropoff || 'N/A'}
Miles: ${md.miles || 'N/A'}
${whenLine}`;

        await notifyTelegram(text);
        break;
      }

      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const md = pi.metadata || {};
        const amount = ((pi.amount_received ?? pi.amount ?? 0) / 100).toFixed(2);
        const currency = (pi.currency || 'gbp').toUpperCase();

        const text =
`🚚 GILEAD COURIER – PAYMENT INTENT SUCCEEDED (${modeLabel})
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
`🚚 GILEAD COURIER – PAYMENT FAILED (${modeLabel})
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
`🚚 GILEAD COURIER – CHARGE REFUNDED (${modeLabel})
Amount: £${amount} ${currency}
Charge: ${charge.id}`;
        await notifyTelegram(text);
        break;
      }

      default:
        console.log('Unhandled event type:', event.type);
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
