import Stripe from 'stripe';
import { headers } from 'next/headers';

export const runtime = 'nodejs';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: '2024-06-20',
});

// Helper: send message to Telegram (but don't fail webhook if it breaks)
async function sendTelegramMessage(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
    });
  } catch (err: any) {
    console.error('Telegram send error:', err.message);
  }
}

export async function POST(req: Request) {
  const sig = headers().get('stripe-signature');
  if (!sig) {
    console.error('Missing stripe-signature header');
    return new Response('Missing stripe-signature', { status: 400 });
  }

  // For now this uses the single STRIPE_WEBHOOK_SECRET (Test secret in your setup)
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('Missing STRIPE_WEBHOOK_SECRET env var');
    return new Response('Server misconfigured', { status: 500 });
  }

  const body = await req.text();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch (err: any) {
    console.error('Test webhook verification failed:', err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;

      const amount = (session.amount_total ?? 0) / 100;
      const currency = (session.currency ?? 'gbp').toUpperCase();
      const customerEmail = session.customer_details?.email ?? 'Unknown email';

      // Placeholder fields for now – we’ll wire real values later
      const pickup = session.metadata?.pickup_address ?? 'Pickup address not provided';
      const dropoff = session.metadata?.dropoff_address ?? 'Drop-off address not provided';

      // Simple job reference using part of the session ID
      const jobRef = session.id ? session.id.slice(-8).toUpperCase() : 'UNKNOWN';

      const message = [
        `🚚 <b>Gilead Courier – New Job (TEST)</b>`,
        `<b>Job ref:</b> ${jobRef}`,
        '',
        `<b>Amount:</b> ${currency} ${amount.toFixed(2)}`,
        `<b>Customer:</b> ${customerEmail}`,
        '',
        `<b>Pickup:</b> ${pickup}`,
        `<b>Drop-off:</b> ${dropoff}`,
      ].join('\n');

      await sendTelegramMessage(message);
    } else {
      console.log(`Received event type ${event.type} (no Telegram logic).`);
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
