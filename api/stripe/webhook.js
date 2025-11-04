module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }
  // Minimal 200 to stop Stripe retries for now
  return res.status(200).json({ received: true });
};
