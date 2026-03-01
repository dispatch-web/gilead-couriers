// api/distance-from-base.js
// GET /api/distance-from-base?postcode=SW1A%202AA
//
// Returns:
// {
//   ok: true,
//   basePostcode: "GL6 0RT",
//   postcode: "SW1A 2AA",
//   miles: 94.3,
//   tier: "TIER_2_EXTENDED"
// }
//
// Notes:
// - Uses postcodes.io for geocoding
// - Uses OSRM public routing server for road distance
// - Tiering is for marketing only (NOT pricing)

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const BASE_POSTCODE = "GL6 0RT";

    const raw = String(req.query.postcode || "").trim();
    if (!raw) {
      return res.status(400).json({ error: "Missing postcode" });
    }

    const postcode = raw.toUpperCase().replace(/\s+/g, " ").trim();

    // ---------------------------
    // Helpers
    // ---------------------------

    async function geocode(pc) {
      const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`);
      const j = await r.json().catch(() => ({}));

      if (!r.ok || !j || j.status !== 200 || !j.result) {
        throw new Error("Invalid postcode: " + pc);
      }

      return {
        lat: j.result.latitude,
        lon: j.result.longitude
      };
    }

    function getTier(miles) {
      if (miles <= 90) return "TIER_1_CORE";
      if (miles <= 140) return "TIER_2_EXTENDED";
      if (miles <= 180) return "TIER_3_EXCEPTION";
      return "TIER_X_OUT_OF_RANGE";
    }

    // ---------------------------
    // Geocode base + destination
    // ---------------------------

    const base = await geocode(BASE_POSTCODE);
    const dest = await geocode(postcode);

    // ---------------------------
    // OSRM road routing (driving)
    // ---------------------------

    const routeUrl =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${base.lon},${base.lat};${dest.lon},${dest.lat}?overview=false`;

    const rr = await fetch(routeUrl);
    const rj = await rr.json().catch(() => ({}));

    if (!rr.ok || !rj || rj.code !== "Ok" || !rj.routes || !rj.routes[0]) {
      throw new Error("Routing failed");
    }

    const meters = rj.routes[0].distance;
    const miles = Math.max(0, Math.round((meters / 1609.344) * 10) / 10); // 1 decimal

    return res.status(200).json({
      ok: true,
      basePostcode: BASE_POSTCODE,
      postcode,
      miles,
      tier: getTier(miles)
    });

  } catch (err) {
    return res.status(400).json({ error: err.message || "Error" });
  }
};
