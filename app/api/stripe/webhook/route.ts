import Stripe from 'stripe';
import { headers } from 'next/headers';

export const runtime = 'nodejs'; // ensure we use Node, not Edge

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: '2024-06-20',
});

// Helper: send message to Telegram
async function sendTelegramMessage(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }),
  });
}

export async function POST(req: Request) {
  const sig = headers().get('stripe-signature');

  if (!sig) {
    console.error('Missing stripe-signature header');
    return new Response('Missing stripe-signature', { status: 400 });
  }

  const liveSecret = process.env.STRIPE_WEBHOOK_SECRET_LIVE;
  const testSecret = process.env.STRIPE_WEBHOOK_SECRET_TEST;

  if (!liveSecret || !testSecret) {
    console.error('Missing webhook secrets in env vars');
    return new Response('Server misconfigured', { status: 500 });
  }

  const body = await req.text();
  let event: Stripe.Event;

  // Try LIVE secret first, then TEST secret
  try {
    event = stripe.webhooks.constructEvent(body, sig, liveSecret);
  } catch (errLive) {
    try {
      event = stripe.webhooks.constructEvent(body, sig, testSecret);
    } catch (errTest) {
      console.error('Webhook verification failed for both LIVE and TEST secrets', {
        liveError: (errLive as Error).message,
        testError: (errTest as Error).message,
      });
      return new Response('Webhook verification failed', { status: 400 });
    }
  }

  // At this point, event is valid (either live or test)
  const isLive = event.livemode === true;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;

        const amount = (session.amount_total ?? 0) / 100;
        const currency = (session.currency ?? 'gbp').toUpperCase();
        const customerEmail = session.customer_details?.email ?? 'Unknown email';

        const pickup = session.metadata?.pickup_address ?? 'Pickup address not provided';
        const dropoff = session.metadata?.dropoff_address ?? 'Drop-off address not provided';

        const modeLabel = isLive ? 'LIVE' : 'TEST';

        const message = [
          `🚚 <b>Gilead Courier – New Job (${modeLabel})</b>`,
          '',
          `<b>Amount:</b> ${currency} ${amount.toFixed(2)}`,
          `<b>Customer:</b> ${customerEmail}`,
          '',
          `<b>Pickup:</b> ${pickup}`,
          `<b>Drop-off:</b> ${dropoff}`,
        ].join('\n');

        await sendTelegramMessage(message);
        break;
      }

      case 'payment_intent.succeeded': {
        console.log('PaymentIntent succeeded');
        break;
      }

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('Error handling webhook event:', err.message);
    return new Response('Webhook handler error', { status: 500 });
  }
}
