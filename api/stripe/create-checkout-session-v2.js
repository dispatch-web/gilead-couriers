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
      serviceType = 'oneway',
      immediateDelivery = false,  // ADDED
      pickup = '',
      dropoff = '',
      miles = '',
      email = '',
      poNumber = '',
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
    const isImmediate = !!immediateDelivery;

    // ---------- Helpers ----------
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

    function makeBookingRef() {
      const now = new Date();
      const y = now.getUTCFullYear();
      const m = String(now.getUTCMonth() + 1).padStart(2, "0");
      const d = String(now.getUTCDate()).padStart(2, "0");
      const rand = String(Math.floor(1000 + Math.random() * 9000));
      return `GC-${y}${m}${d}-${rand}`;
    }

    // ---------- Pricing (must match book.html) ----------
    const PRICING_VERSION = 'PR-PROFILES-V3.0';

    const BASE_PRICING = {
      baseUpTo20: 120,
      perMileOver20: 2.75,
      uplift: [],
      manualQuoteMiles: 240,
      urgencyMinutes: 180,
      urgencyAdd: 30,
      after17Add: 30,
      weekendAdd: 55,
      bankHolidayAdd: 85,
      immediateAdd: 45,
      rounding: 10
    };

    const NO_DISTANCE_UPLIFT = [];

    const INDUSTRY_PRICING = {
      Aerospace: {
        oneway: {
          baseUpTo20: 120,
          perMileOver20: 2.25,
          uplift: [
            { min: 80,  max: 119, add: 35 },
            { min: 120, max: 210, add: 20 },
            { min: 211, max: 259, add: 105 }
          ],
          manualQuoteMiles: 260,
          urgencyMinutes: 180,
          urgencyAdd: 25,
          after17Add: 25,
          weekendAdd: 50,
          bankHolidayAdd: 80,
          immediateAdd: 30,
          rounding: 10
        },
        return_same_day: {
          baseUpTo20: 120,
          perMileOver20: 1.30,
          uplift: [
            { min: 340, max: 520, add: 60 }
          ],
          manualQuoteMiles: 520,
          urgencyMinutes: 180,
          urgencyAdd: 25,
          after17Add: 25,
          weekendAdd: 50,
          bankHolidayAdd: 80,
          immediateAdd: 30,
          rounding: 10
        }
      },

      Legal: {
        oneway: {
          baseUpTo20: 120,
          perMileOver20: 2.65,
          uplift: NO_DISTANCE_UPLIFT,
          manualQuoteMiles: 240,
          urgencyMinutes: 180,
          urgencyAdd: 40,
          after17Add: 35,
          weekendAdd: 60,
          bankHolidayAdd: 90,
          immediateAdd: 60,
          rounding: 10
        },
        return_same_day: {
          baseUpTo20: 120,
          perMileOver20: 2.00,
          uplift: NO_DISTANCE_UPLIFT,
          manualQuoteMiles: 240,
          urgencyMinutes: 180,
          urgencyAdd: 40,
          after17Add: 35,
          weekendAdd: 60,
          bankHolidayAdd: 90,
          immediateAdd: 60,
          rounding: 10
        }
      },

      Medical: {
        oneway: {
          baseUpTo20: 120,
          perMileOver20: 2.65,
          uplift: NO_DISTANCE_UPLIFT,
          manualQuoteMiles: 240,
          urgencyMinutes: 180,
          urgencyAdd: 40,
          after17Add: 35,
          weekendAdd: 60,
          bankHolidayAdd: 90,
          immediateAdd: 60,
          rounding: 10
        },
        return_same_day: {
          baseUpTo20: 120,
          perMileOver20: 2.00,
          uplift: NO_DISTANCE_UPLIFT,
          manualQuoteMiles: 240,
          urgencyMinutes: 180,
          urgencyAdd: 40,
          after17Add: 35,
          weekendAdd: 60,
          bankHolidayAdd: 90,
          immediateAdd: 60,
          rounding: 10
        }
      },

      "Financial Services": {
        oneway: {
          baseUpTo20: 120,
          perMileOver20: 2.65,
          uplift: NO_DISTANCE_UPLIFT,
          manualQuoteMiles: 240,
          urgencyMinutes: 180,
          urgencyAdd: 40,
          after17Add: 35,
          weekendAdd: 60,
          bankHolidayAdd: 90,
          immediateAdd: 60,
          rounding: 10
        },
        return_same_day: {
          baseUpTo20: 120,
          perMileOver20: 2.00,
          uplift: NO_DISTANCE_UPLIFT,
          manualQuoteMiles: 240,
          urgencyMinutes: 180,
          urgencyAdd: 40,
          after17Add: 35,
          weekendAdd: 60,
          bankHolidayAdd: 90,
          immediateAdd: 60,
          rounding: 10
        }
      },

      Defence: {
        oneway: {
          baseUpTo20: 120,
          perMileOver20: 2.65,
          uplift: NO_DISTANCE_UPLIFT,
          manualQuoteMiles: 240,
          urgencyMinutes: 180,
          urgencyAdd: 40,
          after17Add: 35,
          weekendAdd: 60,
          bankHolidayAdd: 90,
          immediateAdd: 60,
          rounding: 10
        },
        return_same_day: {
          baseUpTo20: 120,
          perMileOver20: 2.00,
          uplift: NO_DISTANCE_UPLIFT,
          manualQuoteMiles: 240,
          urgencyMinutes: 180,
          urgencyAdd: 40,
          after17Add: 35,
          weekendAdd: 60,
          bankHolidayAdd: 90,
          immediateAdd: 60,
          rounding: 10
        }
      },

      Engineering: {
        oneway: {
          baseUpTo20: 120,
          perMileOver20: 2.50,
          uplift: NO_DISTANCE_UPLIFT,
          manualQuoteMiles: 220,
          urgencyMinutes: 180,
          urgencyAdd: 30,
          after17Add: 30,
          weekendAdd: 55,
          bankHolidayAdd: 85,
          immediateAdd: 45,
          rounding: 10
        },
        return_same_day: {
          baseUpTo20: 120,
          perMileOver20: 1.85,
          uplift: NO_DISTANCE_UPLIFT,
          manualQuoteMiles: 220,
          urgencyMinutes: 180,
          urgencyAdd: 30,
          after17Add: 30,
          weekendAdd: 55,
          bankHolidayAdd: 85,
          immediateAdd: 45,
          rounding: 10
        }
      },

      "Government / Public Sector": {
        oneway: {
          baseUpTo20: 120,
          perMileOver20: 2.50,
          uplift: NO_DISTANCE_UPLIFT,
          manualQuoteMiles: 220,
          urgencyMinutes: 180,
          urgencyAdd: 30,
          after17Add: 30,
          weekendAdd: 55,
          bankHolidayAdd: 85,
          immediateAdd: 45,
          rounding: 10
        },
        return_same_day: {
          baseUpTo20: 120,
          perMileOver20: 1.85,
          uplift: NO_DISTANCE_UPLIFT,
          manualQuoteMiles: 220,
          urgencyMinutes: 180,
          urgencyAdd: 30,
          after17Add: 30,
          weekendAdd: 55,
          bankHolidayAdd: 85,
          immediateAdd: 45,
          rounding: 10
        }
      },

      Other: {
        oneway: {
          baseUpTo20: 120,
          perMileOver20: 2.50,
          uplift: NO_DISTANCE_UPLIFT,
          manualQuoteMiles: 220,
          urgencyMinutes: 180,
          urgencyAdd: 30,
          after17Add: 30,
          weekendAdd: 55,
          bankHolidayAdd: 85,
          immediateAdd: 45,
          rounding: 10
        },
        return_same_day: {
          baseUpTo20: 120,
          perMileOver20: 1.85,
          uplift: NO_DISTANCE_UPLIFT,
          manualQuoteMiles: 220,
          urgencyMinutes: 180,
          urgencyAdd: 30,
          after17Add: 30,
          weekendAdd: 55,
          bankHolidayAdd: 85,
          immediateAdd: 45,
          rounding: 10
        }
      }
    };

    function getPricingProfile(industryKey, st) {
      const key = String(industryKey || '').trim();
      const s = (st === 'return_same_day') ? 'return_same_day' : 'oneway';

      const industryPack = INDUSTRY_PRICING[key];
      const override = industryPack && industryPack[s] ? industryPack[s] : null;

      const merged = override ? { ...BASE_PRICING, ...override } : { ...BASE_PRICING };
      if (override && Object.prototype.hasOwnProperty.call(override, 'uplift')) {
        merged.uplift = override.uplift;
      }
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
    const dayOfWeekUTC = jobDT.getUTCDay();

    const isAfter1700 = jobHourUTC >= 17;
    const isWeekend = (dayOfWeekUTC === 0 || dayOfWeekUTC === 6);
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

    const pricingWeekend = (!isBankHoliday && isWeekend) ? Number(P.weekendAdd || 0) : 0;
    const pricingBankHoliday = isBankHoliday ? Number(P.bankHolidayAdd || 0) : 0;

    // Immediate delivery uplift (explicit flag)
    const pricingImmediate = isImmediate ? Number(P.immediateAdd || 0) : 0;

    const totalBeforeRounding =
      pricingBase +
      pricingDistance +
      pricingDistanceUplift +
      pricingUrgency +
      pricingAfter1700 +
      pricingWeekend +
      pricingBankHoliday +
      pricingImmediate;

    const calculated = roundToNearest(totalBeforeRounding, Number(P.rounding || 1));
    const amountPence = Math.round(Number(calculated) * 100);

    // ---------- Schedule window computation ----------
    const AVG_MPH = 30;
    const BUFFER_MIN = 20;

    function toISO(dateStr, timeStr) {
      const dt = new Date(`${dateStr}T${timeStr}:00.000Z`);
      return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
    }

    const scheduleEnd = toISO(whenDate, whenTime);
    if (!scheduleEnd) {
      return res.status(400).json({ error: 'Invalid whenDate/whenTime' });
    }

    const driveMinutes = (effectiveMiles / AVG_MPH) * 60;
    const totalMinutes = driveMinutes + BUFFER_MIN;
    const scheduleStart = new Date(new Date(scheduleEnd).getTime() - totalMinutes * 60 * 1000).toISOString();

    // ---------- URLs ----------
    const proto = (req.headers['x-forwarded-proto'] || 'https');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = `${proto}://${host}`;

    const success_url = `${origin}/?status=success`;
    const cancel_url = `${origin}/?status=cancel`;

    const bookingRef = makeBookingRef();

    // ---------- Stripe metadata ----------
    const metadata = {
      company: String(company || ''),
      industry: String(industry || ''),
      serviceType: String(serviceTypeSafe || 'oneway'),
      immediateDelivery: String(isImmediate),

      pickup: String(pickup),
      dropoff: String(dropoff),

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
      pricing_immediate: String(n2(pricingImmediate)),
      pricing_total_before_rounding: String(n2(totalBeforeRounding)),
      calculatedPrice: String(n2(calculated)),

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
