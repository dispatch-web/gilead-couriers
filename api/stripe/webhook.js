export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }
  // For now, just acknowledge so Stripe stops retrying.
  return res.status(200).json({ received: true });
}
