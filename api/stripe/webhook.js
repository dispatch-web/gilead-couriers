const Stripe = require('stripe');
const getRawBody = require('raw-body');

module.exports.config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// 🔗 Make.com webhook URL (already created)
const MAKE_WEBHOOK_URL = 'https://hook.eu1.make.com/rnr8xtmiefpm7bmxohb21o676b9dbupe';

module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  const sig = req.headers['stripe-signature'];

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

    // Then TEST
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

        const amountNum = (session.amount_total ?? 0) / 100;
        const amountStr = amountNum.toFixed(2);
        const currency = (session.currency || 'gbp').toUpperCase();

        const jobRef = session.id ? session.id.slice(-8).toUpperCase() : 'UNKNOWN';
        const version = md._version || 'v2';

        // When fields
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

        // Miles
        const milesStr = md.miles || '';
        const milesNum = milesStr ? parseFloat(milesStr) : 0;

        // 🕒 Compute start/end times (simple model: 30mph + 30min buffer)
        let startDateTimeIso = null;
        let endDateTimeIso = null;
        try {
          if (whenDate && whenTime) {
            // Treat as local date/time; store as ISO
            const end = new Date(`${whenDate}T${whenTime}:00`);
            let travelMinutes = 60; // default 1h
            if (!Number.isNaN(milesNum) && milesNum > 0) {
              const hours = milesNum / 30; // 30 mph average
              travelMinutes = Math.round(hours * 60) + 30; // add 30min buffer
            }
            const start = new Date(end.getTime() - travelMinutes * 60000);
            startDateTimeIso = start.toISOString();
            endDateTimeIso = end.toISOString();
          }
        } catch (e) {
          console.warn('Could not compute start/end times', e?.message);
        }

        const text =
`🚚 GILEAD COURIER – NEW JOB (${modeLabel})
Job ref: ${jobRef}
Version: ${version}

Amount Paid: £${amountStr} ${currency}
Calculated Price: £${md.calculated_price || amountStr}

Customer: ${email}

Pickup: ${md.pickup || 'N/A'}
Drop-off: ${md.dropoff || 'N/A'}
Miles: ${milesStr || 'N/A'}
${whenLine}`;

        await notifyTelegram(text);

        // 📤 Send to Make → Airtable
        try {
          if (MAKE_WEBHOOK_URL) {
            const payload = {
              jobId: jobRef,
              stripeSessionId: session.id,
              mode: modeLabel,
              status: 'Paid',
              email,
              amount: amountNum,
              currency,
              pickup: md.pickup || '',
              dropoff: md.dropoff || '',
              miles: milesStr,
              whenDate,
              whenTime,
              startDateTime: startDateTimeIso,
              endDateTime: endDateTimeIso,
            };

            await fetch(MAKE_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
          }
        } catch (e) {
          console.error('Error posting to Make webhook:', e);
        }

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
        disable_web_page_preview: true,
      }),
    });
    const data = await resp.text();
    console.log('Telegram sendMessage status:', resp.status, 'body:', data);
  } catch (e) {
    console.error('Telegram sendMessage error:', e);
  }
}
