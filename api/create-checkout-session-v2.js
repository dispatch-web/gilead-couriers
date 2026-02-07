const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  try {
    // Only allow POST
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

    const {
      company = '',
      industry = '',
      pickup = '',
      dropoff = '',
      miles = '',
      email = '',
      whenDate = '',
      whenTime = '',
      notes = ''
    } = req.body || {};

    // ---------- Basic validation ----------
    if (!company || !industry || !pickup || !dropoff || !miles || !email || !whenDate || !whenTime) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const milesNum = Number(miles);
    if (!Number.isFinite(milesNum) || milesNum <= 0) {
      return res.status(400).json({ error: 'Invalid miles' });
    }

    // ---------- Helpers for uplift logic ----------
    // NOTE: This treats whenDate as "YYYY-MM-DD" and whenTime as "HH:MM".
    // We use UTC ("Z") to keep behaviour consistent with your existing scheduleStart/End logic.
    function parseDateTimeUTC(dateStr, timeStr) {
      const dt = new Date(`${dateStr}T${timeStr}:00.000Z`);
      return Number.isFinite(dt.getTime()) ? dt : null;
    }

    function startOfTodayUTC() {
      const now = new Date();
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    }

    // ---------- Pricing (Gilead PR-V1.1 with uplift stacking) ----------
    // Base pricing (PR-V1.0)
    // ≤ 20 miles: £90 fixed fee
    // > 20 miles: £90 + (£1.80 per mile over 20)
    // Rounding: nearest £5
    // Minimum charge: never below £90
    const baseWithin20 = 90;
    const perMileOver20 = 1.8;

    let baseCalculated =
      milesNum <= 20
        ? baseWithin20
        : baseWithin20 + ((milesNum - 20) * perMileOver20);

    // Round base to nearest £5
    baseCalculated = Math.round(baseCalculated / 5) * 5;

    // Enforce absolute minimum base
    baseCalculated = Math.max(baseCalculated, baseWithin20);

    // ---------- Uplifts (stacking) ----------
    // After 17:00 → +£15
    // Weekend (Sat/Sun) → +£20
    // Urgent (same day or next day) → +£25
    const UPLIFT_AFTER_1700 = 15;
    const UPLIFT_WEEKEND = 20;
    const UPLIFT_URGENT = 25;

    const jobDT = parseDateTimeUTC(whenDate, whenTime);
    if (!jobDT) {
      return res.status(400).json({ error: 'Invalid whenDate/whenTime' });
    }

    const jobHourUTC = jobDT.getUTCHours();
    const dayOfWeekUTC = jobDT.getUTCDay(); // 0=Sun, 6=Sat

    const isAfter1700 = jobHourUTC >= 17;
    const isWeekend = (dayOfWeekUTC === 0 || dayOfWeekUTC === 6);

    // Urgent: same day or next day (UTC)
    const todayUTC = startOfTodayUTC();
    const jobDayUTC = new Date(Date.UTC(jobDT.getUTCFullYear(), jobDT.getUTCMonth(), jobDT.getUTCDate(), 0, 0, 0, 0));
    const diffDays = Math.round((jobDayUTC.getTime() - todayUTC.getTime()) / (24 * 60 * 60 * 1000));
    const isUrgent = diffDays <= 1;

    const plusUplift =
      (isAfter1700 ? UPLIFT_AFTER_1700 : 0) +
      (isWeekend ? UPLIFT_WEEKEND : 0) +
      (isUrgent ? UPLIFT_URGENT : 0);

    // Final charge is base + uplift (uplift is intentionally NOT rounded in PR-V1.1)
    const calculated = baseCalculated + plusUplift;

    const amountPence = Math.round(calculated * 100);

    // ---------- Schedule window computation ----------
    const AVG_MPH = 30;     // assumption
    const BUFFER_MIN = 20;  // buffer

    function toISO(dateStr, timeStr) {
      const dt = new Date(`${dateStr}T${timeStr}:00.000Z`);
      return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
    }

    const scheduleEnd = toISO(whenDate, whenTime);
    if (!scheduleEnd) {
      return res.status(400).json({ error: 'Invalid whenDate/whenTime' });
    }

    const driveMinutes = (milesNum / AVG_MPH) * 60;
    const totalMinutes = driveMinutes + BUFFER_MIN;
    const scheduleStart = new Date(new Date(scheduleEnd).getTime() - totalMinutes * 60 * 1000).toISOString();

    // ---------- URLs ----------
    const proto = (req.headers['x-forwarded-proto'] || 'https');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = `${proto}://${host}`;

    const success_url = `${origin}/?status=success`;
    const cancel_url = `${origin}/?status=cancel`;

    // ---------- Stripe metadata ----------
    const metadata = {
      company: String(company || ''),
      industry: String(industry || ''),
      pickup: String(pickup),
      dropoff: String(dropoff),
      miles: String(milesNum),
      email: String(email),
      whenDate: String(whenDate),
      whenTime: String(whenTime),
      notes: String(notes || ''),
      scheduleStart: String(scheduleStart),
      scheduleEnd: String(scheduleEnd),

      // Pricing audit
      pricingRuleVersion: 'PR-V1.1',
      baseCalculated: String(baseCalculated),
      plusUplift: String(plusUplift),
      after1700: String(isAfter1700),
      weekend: String(isWeekend),
      urgent: String(isUrgent),
      calculatedPrice: String(calculated)
    };

    // ---------- Stripe Checkout Session ----------
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      success_url,
      cancel_url,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'gbp',
            unit_amount: amountPence,
            product_data: {
              name: 'Gilead Courier Booking',
              description: `Pickup: ${pickup} → Dropoff: ${dropoff} (${milesNum} miles)`
            }
          }
        }
      ],
      metadata,
      payment_intent_data: {
        metadata
      }
    });

    return res.status(200).json({
      url: session.url,
      calculatedPrice: calculated,
      currency: 'GBP'
    });

  } catch (err) {
    console.error('create-checkout-session-v2 error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
