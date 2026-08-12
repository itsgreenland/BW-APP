// Serverless function: GET /api/inspect
// One-off diagnostic to see whether Connecteam carries position info
// (key holder vs cashier) and where it lives: scheduler "jobs", a field on the
// employee record, or on the shift. Sensitive values (phone/email) are masked.
// Key is read from CONNECTEAM_API_KEY (server-side only).

const BASE = "https://api.connecteam.com";

async function ct(path, key) {
  const res = await fetch(BASE + path, { headers: { "X-API-KEY": key, accept: "application/json" } });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  return { status: res.status, ok: res.ok, body };
}
function pickArray(body, keys) {
  let node = body;
  if (node && node.data) node = node.data;
  if (Array.isArray(node)) return node;
  for (const k of keys) if (node && Array.isArray(node[k])) return node[k];
  return [];
}
function maskVal(k, v) {
  if (v == null) return v;
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/phone|mobile|email/i.test(k)) return s.length > 4 ? "***" + s.slice(-4) : "***";
  return s.length > 160 ? s.slice(0, 160) + "…" : s;
}
function maskObj(o) {
  const out = {};
  Object.keys(o || {}).forEach((k) => { out[k] = maskVal(k, o[k]); });
  return out;
}

module.exports = async (req, res) => {
  const key = process.env.CONNECTEAM_API_KEY;
  const send = (o) => { res.setHeader("content-type", "application/json"); res.status(200).json(o); };
  if (!key) return send({ ok: false, error: "No CONNECTEAM_API_KEY set." });

  try {
    const out = { ok: true };

    // ---- Employee records ----
    const ur = await ct("/users/v1/users?limit=5", key);
    const users = pickArray(ur.body, ["users", "items", "results"]);
    out.employeeRecordFields = users.length ? Object.keys(users[0]) : [];
    out.sampleEmployees = users.slice(0, 3).map(maskObj);

    // ---- Schedulers, their jobs (positions), and sample shifts ----
    const sr = await ct("/scheduler/v1/schedulers", key);
    const schedulers = pickArray(sr.body, ["schedulers", "items", "results"]);
    out.schedulers = schedulers.map((s) => ({ id: s.schedulerId != null ? s.schedulerId : s.id, name: s.name || s.title }));

    if (schedulers.length) {
      const sid = schedulers[0].schedulerId != null ? schedulers[0].schedulerId : schedulers[0].id;

      // Jobs = the positions defined in the scheduler (likely "Cashier" / "Key Holder")
      const jr = await ct("/scheduler/v1/schedulers/" + sid + "/jobs", key);
      out.jobsEndpoint = { status: jr.status, ok: jr.ok };
      out.positionsDefined = jr.ok
        ? pickArray(jr.body, ["jobs", "items", "results"]).map((j) => ({ id: j.jobId != null ? j.jobId : j.id, title: j.title || j.name, color: j.color }))
        : null;

      // A few shifts, to see what a shift carries (title / jobId / etc.)
      const now = Math.floor(Date.now() / 1000);
      const shr = await ct("/scheduler/v1/schedulers/" + sid + "/shifts?startTime=" + (now - 7 * 86400) + "&endTime=" + (now + 21 * 86400), key);
      const shifts = pickArray(shr.body, ["shifts", "items", "results"]);
      out.shiftFields = shifts.length ? Object.keys(shifts[0]) : [];
      out.sampleShifts = shifts.slice(0, 3).map(maskObj);
    }

    send(out);
  } catch (e) {
    send({ ok: false, error: e.message });
  }
};
