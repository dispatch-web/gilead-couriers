const Stripe = require('stripe');
const getRawBody = require('raw-body');

module.exports.config = { api: { bodyParser: false } };

// Use your existing STRIPE_SECRET_KEY (live or test depending on your env setup)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

/**
 * If scheduleStart/scheduleEnd are not present in Stripe metadata, we compute a fallback window.
 * Tune these if you want:
 */
const AVG_MPH = 30;          // average driving speed assumption for scheduling fallback
const BUFFER_MIN = 20;       // operational buffer minutes (parking/loading/traffic tolerance)

function toISOOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function combineDateTimeToISO(dateStr, timeStr) {
  // Expecting whenDate: "YYYY-MM-DD" and whenTime: "HH:MM"
  if (!dateStr || !timeStr) return null;
  const dt = new Date(`${dateStr}T${timeStr}:00.000Z`);
  return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
}

function computeScheduleWindowFallback({ whenDate, whenTime, miles }) {
  const scheduleEnd = combineDateTimeToISO(whenDate, whenTime);
  if (!scheduleEnd) return { scheduleStart: null, scheduleEnd: null };

  const milesNum = Number(miles);
  const driveMinutes = Number.isFinite(milesNum) && milesNum > 0
    ? (milesNum / AVG_MPH) * 60
    : 60; // fallback 60 mins if miles missing

  const totalMinutes = driveMinutes + BUFFER_MIN;
  const endMs = new Date(scheduleEnd).getTime();
  const startMs = endMs - totalMinutes * 60 * 1000;

  return {
    scheduleStart: new Date(startMs).toISOString(),
    scheduleEnd
  };
}

function pickEndpointSecret(livemode) {
  // Prefer explicit LIVE/TEST env vars (what you have been using successfully)
  const live = process.env.STRIPE_WEBHOOK_SECRET_LIVE;
  const test = process.env.STRIPE_WEBHOOK_SECRET_TEST;

  if (livemode === true && live) return live;
  if (livemode === false && test) return test;

  // Backwards compatibility (if you ever used STRIPE_WEBHOOK_SECRET)
  return process.env.STRIPE_WEBHOOK_SECRET;
}

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
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }),
    });
    const data = await resp.text();
    console.log('Telegram sendMessage status:', resp.status, 'body:', data);
  } catch (e) {
    console.error('Telegram sendMessage error:', e);
  }
}

async function postToMakeCreateJob(payload) {
  const url = process.env.MAKE_CREATE_JOB_WEBHOOK_URL;
  if (!url) {
    console.warn('MAKE_CREATE_JOB_WEBHOOK_URL missing; skipping Make job creation.');
    return { ok: false, reason: 'missing_make_url' };
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    console.log('Make create-job webhook status:', resp.status, 'body:', text);
    return { ok: resp.ok, status: resp.status, body: text };
  } catch (e) {
    console.error('Make create-job webhook error:', e);
    return { ok: false, reason: 'exception', error: e?.message };
  }
}

module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  const sig = req.headers['stripe-signature'];

  let event;
  try {
    const buf = await getRawBody(req);

    // We can’t know livemode until the event is constructed; Stripe expects the correct secret.
    // So we try LIVE first then TEST (or vice versa) based on what you have set.
    // This avoids “key undefined” and supports both modes.
    const liveSecret = process.env.STRIPE_WEBHOOK_SECRET_LIVE;
    const testSecret = process.env.STRIPE_WEBHOOK_SECRET_TEST;
    const genericSecret = process.env.STRIPE_WEBHOOK_SECRET;

    // Attempt construct with LIVE secret if present
    if (liveSecret) {
      try {
        event = stripe.webhooks.constructEvent(buf, sig, liveSecret);
      } catch (_) {}
    }
    // Attempt construct with TEST secret if not already constructed
    if (!event && testSecret) {
      try {
        event = stripe.webhooks.constructEvent(buf, sig, testSecret);
      } catch (_) {}
    }
    // Final fallback
    if (!event && genericSecret) {
      event = stripe.webhooks.constructEvent(buf, sig, genericSecret);
    }

    if (!event) {
      throw new Error('Signature verification failed (no matching webhook secret).');
    }
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

        const amountNum = (session.amount_total ?? 0) / 100;
        const currency = (session.currency || 'gbp').toUpperCase();

        // Pull scheduleStart/End if present; otherwise compute fallback
        const scheduleStartFromMd = toISOOrNull(md.scheduleStart);
        const scheduleEndFromMd = toISOOrNull(md.scheduleEnd);

        const whenDate = md.whenDate || md.date || '';
        const whenTime = md.whenTime || md.time || '';
        const miles = md.miles || '';

        const fallbackWindow = computeScheduleWindowFallback({ whenDate, whenTime, miles });

        const scheduleStart = scheduleStartFromMd || fallbackWindow.scheduleStart;
        const scheduleEnd = scheduleEndFromMd || fallbackWindow.scheduleEnd;

        // --- Telegram message (unchanged in spirit) ---
        const text =
`✅ Booking Paid
Amount: £${amountNum.toFixed(2)} ${currency}
Email: ${email}
Pickup: ${md.pickup || 'N/A'}
Dropoff: ${md.dropoff || 'N/A'}
Miles: ${miles || 'N/A'}
When (date): ${whenDate || 'N/A'}
When (time): ${whenTime || 'N/A'}
Schedule Start: ${scheduleStart || 'N/A'}
Schedule End: ${scheduleEnd || 'N/A'}
Session: ${session.id}`;

        await notifyTelegram(text);

        // --- Make → Airtable create job record ---
        const payload = {
          source: 'stripe_webhook',
          mode: session.livemode ? 'live' : 'test',
          sessionId: session.id,
          paymentIntent: session.payment_intent || null,
          email,
          amountPaid: amountNum,
          currency,
          pickup: md.pickup || '',
          dropoff: md.dropoff || '',
          miles: miles || '',
          whenDate: whenDate || '',
          whenTime: whenTime || '',
          scheduleStart: scheduleStart || '',
          scheduleEnd: scheduleEnd || '',
          vehicle: 'Main Van',
          notes: md.notes || md.message || ''
        };

        await postToMakeCreateJob(payload);

        break;
      }

      // Optional: keep these if you want Telegram noise; otherwise you can remove them.
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const md = pi.metadata || {};
        const amount = ((pi.amount_received ?? pi.amount ?? 0) / 100).toFixed(2);
        const currency = (pi.currency || 'gbp').toUpperCase();

        const text =
`✅ Payment Succeeded
Amount: £${amount} ${currency}
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
