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

    // ---------- Helpers (UTC-based, consistent with your schedule logic) ----------
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

    function roundToNearest(amount, nearest) {
      const n = Number(nearest) || 1;
      return Math.round(amount / n) * n;
    }

    // --- ADDITION: Auto-generated Booking Reference (GC-YYYYMMDD-XXXX) ---
    function makeBookingRef() {
      const now = new Date();
      const y = now.getUTCFullYear();
      const m = String(now.getUTCMonth() + 1).padStart(2, "0");
      const d = String(now.getUTCDate()).padStart(2, "0");
      const rand = String(Math.floor(1000 + Math.random() * 9000));
      return `GC-${y}${m}${d}-${rand}`;
    }
    // --- END ADDITION ---

    // ---------- Premium Pricing (Gilead PR-PREMIUM-V1.0) ----------
    // Positioning: top-of-market dedicated A-to-B courier
    //
    // Base:
    //   - up to 20 miles: £120 minimum
    // Distance:
    //   - beyond 20 miles: £3.50 per mile (over-20 miles only)
    // Distance uplifts:
    //   - 80–119 miles: +£50
    //   - 120–179 miles: +£90
    //   - 180+ miles: manual quote (block checkout)
    // Urgency:
    //   - < 3 hours notice: +£40
    // Out-of-hours:
    //   - after 17:00: +£35
    // Weekend / Bank Holiday:
    //   - weekend: +£60
    //   - bank holiday: +£90 (not auto-detected here unless you add a UK BH calendar)
    // Rounding:
    //   - round final to nearest £5
    const PRICING_VERSION = 'PR-PREMIUM-V1.0';

    const BASE_WITHIN_20 = 120;
    const PER_MILE_OVER_20 = 3.5;
    const MANUAL_QUOTE_MILES = 180;

    const DIST_UPLIFT_80_119 = 50;
    const DIST_UPLIFT_120_179 = 90;

    const URGENCY_MINUTES = 180; // < 3 hours
    const UPLIFT_URGENCY = 40;

    const UPLIFT_AFTER_1700 = 35;
    const UPLIFT_WEEKEND = 60;
    const UPLIFT_BANK_HOLIDAY = 90;

    const ROUND_NEAREST = 5;

    if (milesNum >= MANUAL_QUOTE_MILES) {
      return res.status(400).json({
        error: 'Manual quote required for 180+ miles'
      });
    }

    const jobDT = parseDateTimeUTC(whenDate, whenTime);
    if (!jobDT) {
      return res.status(400).json({ error: 'Invalid whenDate/whenTime' });
    }

    const jobHourUTC = jobDT.getUTCHours();
    const dayOfWeekUTC = jobDT.getUTCDay(); // 0=Sun, 6=Sat

    const isAfter1700 = jobHourUTC >= 17;
    const isWeekend = (dayOfWeekUTC === 0 || dayOfWeekUTC === 6);

    // Bank Holiday detection: placeholder (always false).
    // If you later add a UK bank holiday calendar lookup, set isBankHoliday accordingly.
    const isBankHoliday = false;

    // Urgency: < 3 hours notice (UTC)
    const now = new Date();
    const diffMinutes = (jobDT.getTime() - now.getTime()) / 60000;
    const isUrgent = diffMinutes >= 0 && diffMinutes < URGENCY_MINUTES;

    // Base + distance component
    const over20 = Math.max(0, milesNum - 20);
    const pricingBase = BASE_WITHIN_20;
    const pricingDistance = over20 * PER_MILE_OVER_20;

    // Distance uplift bracket (based on TOTAL miles)
    let pricingDistanceUplift = 0;
    if (milesNum >= 80 && milesNum <= 119) pricingDistanceUplift = DIST_UPLIFT_80_119;
    else if (milesNum >= 120 && milesNum <= 179) pricingDistanceUplift = DIST_UPLIFT_120_179;

    // Time-based uplifts
    const pricingUrgency = isUrgent ? UPLIFT_URGENCY : 0;
    const pricingAfter1700 = isAfter1700 ? UPLIFT_AFTER_1700 : 0;

    // Weekend / Bank Holiday (bank holiday overrides weekend)
    const pricingWeekend = (!isBankHoliday && isWeekend) ? UPLIFT_WEEKEND : 0;
    const pricingBankHoliday = isBankHoliday ? UPLIFT_BANK_HOLIDAY : 0;

    const totalBeforeRounding =
      pricingBase +
      pricingDistance +
      pricingDistanceUplift +
      pricingUrgency +
      pricingAfter1700 +
      pricingWeekend +
      pricingBankHoliday;

    const calculated = roundToNearest(totalBeforeRounding, ROUND_NEAREST);
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

    // --- ADDITION: Generate Booking Reference (created once per checkout session) ---
    const bookingRef = makeBookingRef();
    // --- END ADDITION ---

    // ---------- Stripe metadata ----------
    // Keep your existing metadata keys, but expand pricing audit for Make/Airtable traceability.
    const metadata = {
      company: String(company || ''),
      industry: String(industry || ''),
      pickup: String(pickup),
      dropoff: String(dropoff),
      miles: String(Math.round(milesNum)),
      email: String(email),
      whenDate: String(whenDate),
      whenTime: String(whenTime),
      notes: String(notes || ''),
      scheduleStart: String(scheduleStart),
      scheduleEnd: String(scheduleEnd),

      // --- ADDITION: Booking Reference ---
      bookingRef: String(bookingRef),
      // --- END ADDITION ---

      // Pricing audit (premium, itemised)
      pricingRuleVersion: PRICING_VERSION,
      pricing_base: String(pricingBase),
      pricing_distance: String(Math.round(pricingDistance * 100) / 100),
      pricing_uplift_distance: String(pricingDistanceUplift),
      pricing_urgency: String(pricingUrgency),
      pricing_after1700: String(pricingAfter1700),
      pricing_weekend: String(pricingWeekend),
      pricing_bank_holiday: String(pricingBankHoliday),
      pricing_total_before_rounding: String(Math.round(totalBeforeRounding * 100) / 100),
      pricing_rounding_to: String(ROUND_NEAREST),
      calculatedPrice: String(calculated),

      // Flags
      after1700: String(isAfter1700),
      weekend: String(isWeekend),
      bankHoliday: String(isBankHoliday),
      urgent: String(isUrgent)
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
              description: `Pickup: ${pickup} → Dropoff: ${dropoff} (${Math.round(milesNum)} miles)`
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
      currency: 'GBP',
      pricingRuleVersion: PRICING_VERSION,
      // --- ADDITION: Return Booking Reference for optional UI confirmation ---
      bookingRef: bookingRef
      // --- END ADDITION ---
    });

  } catch (err) {
    console.error('create-checkout-session-v2 error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
