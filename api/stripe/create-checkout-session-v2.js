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
      serviceType = 'oneway',   // ADDED: aligns to book.html (oneway / return_same_day)
      pickup = '',
      dropoff = '',
      miles = '',
      email = '',
      poNumber = '',            // ADDED: aligns to book.html
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

    const serviceTypeSafe = String(serviceType || 'oneway').trim();
    const isReturnSameDay = serviceTypeSafe === 'return_same_day';

    // ---------- Helpers (UTC-based, consistent with your schedule logic) ----------
    // NOTE: This treats whenDate as "YYYY-MM-DD" and whenTime as "HH:MM".
    // We use UTC ("Z") to keep behaviour consistent with your existing scheduleStart/End logic.
    function parseDateTimeUTC(dateStr, timeStr) {
      const dt = new Date(`${dateStr}T${timeStr}:00.000Z`);
      return Number.isFinite(dt.getTime()) ? dt : null;
    }

    function roundToNearest(amount, nearest) {
      const n = Number(nearest) || 1;
      return Math.round(amount / n) * n;
    }

    function n2(v) {
      return Math.round(Number(v || 0) * 100) / 100;
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

    // ---------- Pricing (Aligned to book.html Industry Pricing Profiles) ----------
    // IMPORTANT: Miles in this API are "one-way" miles. For return_same_day we price as a round trip (effective miles = 2x).
    const PRICING_VERSION = 'PR-PROFILES-V2.0';

    // BASE PRICING (DEFAULT / OTHER) — PREMIUM RETAIL LOGIC
    const BASE_PRICING = {
      baseUpTo20: 120,
      perMileOver20: 3.5,
      uplift: [
        { min: 80, max: 119, add: 50 },
        { min: 120, max: 179, add: 90 }
      ],
      manualQuoteMiles: 180,

      urgencyMinutes: 180,
      urgencyAdd: 40,
      after17Add: 35,
      weekendAdd: 60,
      bankHolidayAdd: 90,

      rounding: 5
    };

    // INDUSTRY PRICING PROFILES (CONSISTENT RETURN-SAME-DAY BEHAVIOUR)
    const INDUSTRY_PRICING = {
      "Aerospace": {
        oneway: {
          baseUpTo20: 120,

          // Aeromet one-way anchor (190 miles -> £520 rounded to £10)
          perMileOver20: 2.25,

          // Minimal uplift (replaces old large uplift bands)
          uplift: [
            { min: 120, max: 210, add: 20 }
          ],

          manualQuoteMiles: 260,
          urgencyMinutes: 180,
          urgencyAdd: 25,
          after17Add: 25,
          weekendAdd: 50,
          bankHolidayAdd: 80,
          rounding: 10
        },
        return_same_day: {
          baseUpTo20: 120,

          // Return same day anchor (190 one-way => 380 effective => £650 rounded to £10)
          perMileOver20: 1.30,

          // Distance uplift for longer return shuttles (effective miles)
          uplift: [
            { min: 340, max: 520, add: 60 }
          ],

          manualQuoteMiles: 520, // effective miles
          urgencyMinutes: 180,
          urgencyAdd: 25,
          after17Add: 25,
          weekendAdd: 50,
          bankHolidayAdd: 80,
          rounding: 10
        }
      },

      "Defence": {
        oneway: {
          baseUpTo20: 120,
          perMileOver20: 2.35,
          uplift: [
            { min: 80, max: 119, add: 40 },
            { min: 120, max: 179, add: 70 }
          ],
          manualQuoteMiles: 240,
          urgencyMinutes: 180,
          urgencyAdd: 30,
          after17Add: 30,
          weekendAdd: 55,
          bankHolidayAdd: 85,
          rounding: 10
        },
        return_same_day: {
          baseUpTo20: 120,
          perMileOver20: 1.85,
          uplift: [
            { min: 260, max: 520, add: 40 }
          ],
          manualQuoteMiles: 480,
          urgencyMinutes: 180,
          urgencyAdd: 30,
          after17Add: 30,
          weekendAdd: 55,
          bankHolidayAdd: 85,
          rounding: 10
        }
      },

      "Engineering": {
        oneway: {
          baseUpTo20: 120,
          perMileOver20: 2.5,
          uplift: [
            { min: 80, max: 119, add: 45 },
            { min: 120, max: 179, add: 80 }
          ],
          manualQuoteMiles: 220,
          urgencyMinutes: 180,
          urgencyAdd: 30,
          after17Add: 30,
          weekendAdd: 55,
          bankHolidayAdd: 85,
          rounding: 10
        },
        return_same_day: {
          baseUpTo20: 120,
          perMileOver20: 1.95,
          uplift: [
            { min: 240, max: 480, add: 35 }
          ],
          manualQuoteMiles: 440,
          urgencyMinutes: 180,
          urgencyAdd: 30,
          after17Add: 30,
          weekendAdd: 55,
          bankHolidayAdd: 85,
          rounding: 10
        }
      },

      "Government / Public Sector": {
        oneway: {
          baseUpTo20: 120,
          perMileOver20: 2.4,
          uplift: [
            { min: 80, max: 119, add: 40 },
            { min: 120, max: 179, add: 70 }
          ],
          manualQuoteMiles: 220,
          urgencyMinutes: 180,
          urgencyAdd: 25,
          after17Add: 25,
          weekendAdd: 50,
          bankHolidayAdd: 80,
          rounding: 10
        },
        return_same_day: {
          baseUpTo20: 120,
          perMileOver20: 1.85,
          uplift: [
            { min: 240, max: 480, add: 25 }
          ],
          manualQuoteMiles: 440,
          urgencyMinutes: 180,
          urgencyAdd: 25,
          after17Add: 25,
          weekendAdd: 50,
          bankHolidayAdd: 80,
          rounding: 10
        }
      },

      "Legal": {
        oneway: {
          baseUpTo20: 120,
          perMileOver20: 3.5,
          uplift: [
            { min: 80, max: 119, add: 50 },
            { min: 120, max: 179, add: 90 }
          ],
          manualQuoteMiles: 180,
          urgencyMinutes: 180,
          urgencyAdd: 45,
          after17Add: 40,
          weekendAdd: 70,
          bankHolidayAdd: 95,
          rounding: 5
        },
        return_same_day: {
          baseUpTo20: 120,
          perMileOver20: 2.85,
          uplift: [
            { min: 240, max: 480, add: 80 }
          ],
          manualQuoteMiles: 360,
          urgencyMinutes: 180,
          urgencyAdd: 55,
          after17Add: 45,
          weekendAdd: 80,
          bankHolidayAdd: 110,
          rounding: 5
        }
      },

      "Medical": {
        oneway: {
          baseUpTo20: 120,
          perMileOver20: 3.1,
          uplift: [
            { min: 80, max: 119, add: 45 },
            { min: 120, max: 179, add: 85 }
          ],
          manualQuoteMiles: 200,
          urgencyMinutes: 180,
          urgencyAdd: 40,
          after17Add: 35,
          weekendAdd: 70,
          bankHolidayAdd: 100,
          rounding: 5
        },
        return_same_day: {
          baseUpTo20: 120,
          perMileOver20: 2.65,
          uplift: [
            { min: 240, max: 520, add: 70 }
          ],
          manualQuoteMiles: 400,
          urgencyMinutes: 180,
          urgencyAdd: 50,
          after17Add: 40,
          weekendAdd: 80,
          bankHolidayAdd: 120,
          rounding: 5
        }
      },

      "Financial Services": {
        oneway: {
          baseUpTo20: 120,
          perMileOver20: 3.25,
          uplift: [
            { min: 80, max: 119, add: 50 },
            { min: 120, max: 179, add: 90 }
          ],
          manualQuoteMiles: 200,
          urgencyMinutes: 180,
          urgencyAdd: 40,
          after17Add: 40,
          weekendAdd: 65,
          bankHolidayAdd: 95,
          rounding: 5
        },
        return_same_day: {
          baseUpTo20: 120,
          perMileOver20: 2.70,
          uplift: [
            { min: 240, max: 520, add: 75 }
          ],
          manualQuoteMiles: 400,
          urgencyMinutes: 180,
          urgencyAdd: 50,
          after17Add: 45,
          weekendAdd: 75,
          bankHolidayAdd: 110,
          rounding: 5
        }
      },

      "Other": {
        oneway: null,
        return_same_day: {
          baseUpTo20: 120,
          perMileOver20: 2.35,
          uplift: [
            { min: 240, max: 480, add: 50 }
          ],
          manualQuoteMiles: 360,
          urgencyMinutes: 180,
          urgencyAdd: 40,
          after17Add: 35,
          weekendAdd: 65,
          bankHolidayAdd: 95,
          rounding: 5
        }
      }
    };

    function getPricingProfile(industryKey, st) {
      const key = String(industryKey || '').trim();
      const s = (st === 'return_same_day') ? 'return_same_day' : 'oneway';

      const industryPack = INDUSTRY_PRICING[key];
      const override = industryPack && industryPack[s] ? industryPack[s] : null;

      const merged = override ? { ...BASE_PRICING, ...override } : { ...BASE_PRICING };
      if (override && override.uplift) merged.uplift = override.uplift;
      return merged;
    }

    const P = getPricingProfile(industry, serviceTypeSafe);

    // Effective miles used for pricing / manual quote checks
    const effectiveMiles = isReturnSameDay ? (milesNum * 2) : milesNum;

    if (effectiveMiles >= Number(P.manualQuoteMiles)) {
      return res.status(400).json({
        error: `Manual quote required for ${P.manualQuoteMiles}+ miles`
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
    const isBankHoliday = false;

    // Urgency: < N minutes notice (UTC)
    const now = new Date();
    const diffMinutes = (jobDT.getTime() - now.getTime()) / 60000;
    const isUrgent = diffMinutes >= 0 && diffMinutes < Number(P.urgencyMinutes || 0);

    // Base + distance component (based on EFFECTIVE miles)
    const over20 = Math.max(0, effectiveMiles - 20);
    const pricingBase = Number(P.baseUpTo20);
    const pricingDistance = over20 * Number(P.perMileOver20);

    // Distance uplift bracket (based on EFFECTIVE miles)
    let pricingDistanceUplift = 0;
    for (const b of (P.uplift || [])) {
      if (effectiveMiles >= b.min && effectiveMiles <= b.max) {
        pricingDistanceUplift = Number(b.add) || 0;
        break;
      }
    }

    // Time-based uplifts
    const pricingUrgency = isUrgent ? Number(P.urgencyAdd || 0) : 0;
    const pricingAfter1700 = isAfter1700 ? Number(P.after17Add || 0) : 0;

    // Weekend / Bank Holiday (bank holiday overrides weekend)
    const pricingWeekend = (!isBankHoliday && isWeekend) ? Number(P.weekendAdd || 0) : 0;
    const pricingBankHoliday = isBankHoliday ? Number(P.bankHolidayAdd || 0) : 0;

    const totalBeforeRounding =
      pricingBase +
      pricingDistance +
      pricingDistanceUplift +
      pricingUrgency +
      pricingAfter1700 +
      pricingWeekend +
      pricingBankHoliday;

    const calculated = roundToNearest(totalBeforeRounding, Number(P.rounding || 1));
    const amountPence = Math.round(Number(calculated) * 100);

    // ---------- Schedule window computation ----------
    const AVG_MPH = 30;     // assumption
    const BUFFER_MIN = 20;  // buffer

    function toISO(dateStr, timeStr) {
      const dt = new Date(`${dateStr}T${timeStr}:00.000Z`);
      return Number.isFinite(dt.getTime()) ? dt : null;
    }

    const scheduleEnd = toISO(whenDate, whenTime);
    if (!scheduleEnd) {
      return res.status(400).json({ error: 'Invalid whenDate/whenTime' });
    }

    // Schedule uses EFFECTIVE miles (return_same_day consumes more time)
    const driveMinutes = (effectiveMiles / AVG_MPH) * 60;
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
    const metadata = {
      company: String(company || ''),
      industry: String(industry || ''),
      serviceType: String(serviceTypeSafe || 'oneway'),
      pickup: String(pickup),
      dropoff: String(dropoff),

      // miles: keep both one-way and effective for traceability
      miles_oneway: String(n2(milesNum)),
      miles_effective: String(n2(effectiveMiles)),

      email: String(email),
      poNumber: String(poNumber || ''),
      whenDate: String(whenDate),
      whenTime: String(whenTime),
      notes: String(notes || ''),
      scheduleStart: String(scheduleStart),
      scheduleEnd: String(scheduleEnd),

      bookingRef: String(bookingRef),

      // Pricing audit (profile-based, itemised)
      pricingRuleVersion: PRICING_VERSION,
      pricing_profile_rounding_to: String(Number(P.rounding || 1)),
      pricing_profile_manual_quote_miles: String(Number(P.manualQuoteMiles || 0)),
      pricing_base: String(n2(pricingBase)),
      pricing_per_mile_over20: String(n2(Number(P.perMileOver20))),
      pricing_distance: String(n2(pricingDistance)),
      pricing_uplift_distance: String(n2(pricingDistanceUplift)),
      pricing_urgency: String(n2(pricingUrgency)),
      pricing_after1700: String(n2(pricingAfter1700)),
      pricing_weekend: String(n2(pricingWeekend)),
      pricing_bank_holiday: String(n2(pricingBankHoliday)),
      pricing_total_before_rounding: String(n2(totalBeforeRounding)),
      calculatedPrice: String(n2(calculated)),

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
              description: `Service: ${isReturnSameDay ? 'Return same day' : 'One-way'} | Pickup: ${pickup} → Dropoff: ${dropoff} (${Math.round(milesNum)} miles one-way)`
            }
          }
        }
      ],
      metadata,
      payment_intent_data: { metadata }
    });

    return res.status(200).json({
      url: session.url,
      calculatedPrice: calculated,
      currency: 'GBP',
      pricingRuleVersion: PRICING_VERSION,
      bookingRef: bookingRef
    });

  } catch (err) {
    console.error('create-checkout-session-v2 error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
