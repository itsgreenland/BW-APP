// Shared data API for the task app: checklist templates + daily sign-offs,
// stored in the shared database so all 4 stores/devices see the same thing.
//
//   GET  /api/data?action=health
//   GET  /api/data?action=get-templates
//   POST /api/data?action=save-templates      body: { templates: {...} }
//   GET  /api/data?action=get-tasks&store=&date=&shift=
//   POST /api/data?action=signoff             body: { store,date,shift,index,done,by }

const kv = require("./_kv.js");

const DEFAULTS = {
  morning: [
    "Disarm alarm & unlock front doors",
    "Turn on all lights, signs & music",
    "Count opening register / cash float",
    "Power on POS terminals & card readers",
    "Walk the floor — straighten wig & bundle displays",
    "Restock edge control & styling gel end-caps",
    "Check & tidy restrooms",
    "Sweep entrance & front walkway",
    "Refill shopping bags at each register",
    "Confirm today's promo signage is up",
  ],
  afternoon: [
    "Restock shelves shopped during the day",
    "Face & straighten aisles (braiding hair, lace, bundles)",
    "Count & reconcile register, prep deposit",
    "Sweep and mop floors",
    "Take out trash & recycling",
    "Clean & lock restrooms",
    "Secure back stock room",
    "Power down POS & displays",
    "Set alarm & lock all doors",
    "Text manager end-of-day sales total",
  ],
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayKey(dateISO) {
  const p = String(dateISO || "").split("-").map(Number);
  const dt = new Date(Date.UTC(p[0] || 1970, (p[1] || 1) - 1, p[2] || 1));
  return DAYS[dt.getUTCDay()];
}
function seedTemplates() {
  const t = {};
  DAYS.forEach((d) => { t[d + "|morning"] = DEFAULTS.morning.slice(); t[d + "|afternoon"] = DEFAULTS.afternoon.slice(); });
  return t;
}
function signKey(store, date, shift) { return "bw:signoff:" + store + ":" + date + ":" + shift; }

async function readBody(req) {
  if (req.body != null) {
    if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return {}; } }
    return req.body;
  }
  return await new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => { d += c; });
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (e) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

module.exports = async (req, res) => {
  const send = (o, code) => { res.setHeader("content-type", "application/json"); res.status(code || 200).json(o); };
  const q = req.query || {};
  const action = q.action || (req.method === "POST" ? "signoff" : "get-tasks");

  try {
    if (action === "health") {
      if (!kv.configured) return send({ ok: false, db: "not connected", hint: "Create the database in Vercel (Storage tab), then redeploy." });
      const stamp = String(Date.now());
      await kv.kvSet("bw:health", stamp);
      const back = await kv.kvGet("bw:health");
      return send({ ok: back === stamp, db: back === stamp ? "connected" : "error" });
    }

    if (action === "get-templates") {
      const t = (await kv.kvGetJSON("bw:templates", null)) || seedTemplates();
      return send({ ok: true, templates: t });
    }

    if (action === "save-templates") {
      const body = await readBody(req);
      await kv.kvSetJSON("bw:templates", body.templates || {});
      return send({ ok: true });
    }

    if (action === "get-tasks") {
      const store = q.store, date = q.date, shift = q.shift;
      const t = (await kv.kvGetJSON("bw:templates", null)) || seedTemplates();
      const tasks = t[dayKey(date) + "|" + shift] || DEFAULTS[shift] || [];
      const signoffs = await kv.kvGetJSON(signKey(store, date, shift), {});
      return send({ ok: true, tasks: tasks, signoffs: signoffs });
    }

    if (action === "signoff") {
      const body = await readBody(req);
      const key = signKey(body.store, body.date, body.shift);
      const s = (await kv.kvGetJSON(key, {})) || {};
      if (body.done) s[body.index] = { by: body.by || "Unknown", at: Date.now() };
      else delete s[body.index];
      await kv.kvSetJSON(key, s);
      return send({ ok: true, signoffs: s });
    }

    return send({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return send({ ok: false, error: e.message });
  }
};
