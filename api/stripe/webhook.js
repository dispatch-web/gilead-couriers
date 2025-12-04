const Stripe = require('stripe');
const getRawBody = require('raw-body');

module.exports.config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// OPTIONAL: later we can move this URL into an env var if you like
const MAKE_WEBHOOK_URL = 'https://hook.eu1.make.com/rnr8xtmiefpm7bmxohb21o676b9dbupe';

module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  const sig = req.headers['stripe-signature'];

  // Dual-secret: LIVE + TEST
  const liveSecret = process.env.STRIPE_WEBHOOK_SECRET_LIVE;
  const testSecret = process.env.STRIPE_WEBHOOK_SECRET; // TEST secret
  if (!liveSecret && !testSecret) {
    console.error('No webhook secrets configured');
    return res.status(500).send('Server misconfigured');
  }

  let event;
  let modeLabel = 'UNKNOWN';

  try {
    const buf = await getRawBody(req);

    // Try LIVE first
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

        const version = md._version || 'v2';

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

        // 1) Notify Telegram (as before)
        await notifyTelegram(text);

        // 2) Notify Make.com with structured job data for Airtable
        const jobPayload = {
          eventType: event.type,
          mode: modeLabel,
          version,
          sessionId: session.id,
          jobRef,
          amountPaid: Number(amount),
          currency,
          calculatedPrice: md.calculated_price ? Number(md.calculated_price) : Number(amount),
          pickup: md.pickup || null,
          dropoff: md.dropoff || null,
          miles: md.miles || null,
          whenDate: whenDate || null,
          whenTime: whenTime || null,
          email,
          createdAt: new Date().toISOString(),
        };

        await notifyMake(jobPayload);

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

async function notifyMake(payload) {
  if (!MAKE_WEBHOOK_URL) {
    console.warn('MAKE_WEBHOOK_URL not configured; skipping Make notification.');
    return;
  }

  try {
    const resp = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    console.log('Make.com webhook status:', resp.status, 'body:', text);
  } catch (e) {
    console.error('Make.com webhook error:', e);
  }
}
