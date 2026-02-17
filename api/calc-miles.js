module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    if (!from || !to) {
      return res.status(400).json({ error: "Missing from/to" });
    }

    // 1) Geocode postcodes via postcodes.io (free)
    async function geocode(pc) {
      const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`);
      const j = await r.json();
      if (!r.ok || !j || j.status !== 200 || !j.result) throw new Error("Invalid postcode: " + pc);
      return { lat: j.result.latitude, lon: j.result.longitude };
    }

    const a = await geocode(from);
    const b = await geocode(to);

    // 2) Route via OSRM public server (free)
    // Note: public endpoint is best-effort. Fine for early launch; if volume grows, we can swap to a dedicated provider.
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;
    const rr = await fetch(url);
    const rj = await rr.json();

    if (!rr.ok || !rj || rj.code !== "Ok" || !rj.routes || !rj.routes[0]) {
      throw new Error("Routing failed");
    }

    const meters = rj.routes[0].distance;
    const miles = Math.max(1, Math.round((meters / 1609.344) * 10) / 10); // 1 decimal, minimum 1

    return res.status(200).json({ miles });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Error" });
  }
};
