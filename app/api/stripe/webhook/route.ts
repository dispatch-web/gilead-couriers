export const runtime = 'nodejs'; // ensure Node runtime, not Edge

// Helper: send message to Telegram (optional)
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }),
  });
}

export async function POST(req: Request) {
  let event: any;

  try {
    const bodyText = await req.text();
    event = JSON.parse(bodyText);
  } catch (err: any) {
    console.error('Failed to parse JSON body:', err.message);
    // Even if parsing fails, we don't want Stripe retry storms during testing
    return new Response('Invalid JSON', { status: 200 });
  }

  const modeLabel = event?.livemode ? 'LIVE' : 'TEST';

  try {
    if (event?.type === 'checkout.session.completed') {
      const session = event.data?.object ?? {};

      const amount = (session.amount_total ?? 0) / 100;
      const currency = (session.currency ?? 'gbp').toUpperCase();
      const customerEmail = session.customer_details?.email ?? 'Unknown email';

      const pickup = session.metadata?.pickup_address ?? 'Pickup address not provided';
      const dropoff = session.metadata?.dropoff_address ?? 'Drop-off address not provided';

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
    } else {
      console.log(`Received event type ${event?.type}, no Telegram logic attached.`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('Error handling webhook event:', err.message);
    // Still return 200 so Stripe doesn’t keep retrying while we debug
    return new Response('OK', { status: 200 });
  }
}
