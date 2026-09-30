// Serverless function: Key Holder weekly reorders (per store, shared).
//   GET  /api/reorder?store=Hefner&date=YYYY-MM-DD   -> one store's week view
//   GET  /api/reorder?overview=1&date=YYYY-MM-DD      -> all 4 stores (owner report)
//   POST /api/reorder  { store, category, action, by, date }
//        action = "ordered" | "skip" | "clear"
//
// Categories run on a 2-week rhythm PER STORE: a category marked "ordered" one
// week is on cooldown (hidden) the next week, then offered again. "skip" (not
// needed this week) does NOT start a cooldown — it returns next Monday.
// Due Tuesday 12:00pm Central; un-ordered eligible categories then go overdue.

const kv = require("./_kv.js");
const TZ = "America/Chicago";

const CATS = [
  { key: "chemical", label: "Chemical", note: "Order through Global" },
  { key: "hair", label: "Hair", note: "" },
  { key: "braiding", label: "Braiding", note: "" },
  { key: "wigs", label: "Wigs", note: "" },
];
const STORES = ["Hefner", "Britton", "Meridian", "Rockwell"];

function pad(n) { return String(n).padStart(2, "0"); }
function ymd(dt) { return dt.getUTCFullYear() + "-" + pad(dt.getUTCMonth() + 1) + "-" + pad(dt.getUTCDate()); }
function parseISO(iso) { const p = String(iso).split("-").map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])); }
function addDays(iso, n) { const dt = parseISO(iso); dt.setUTCDate(dt.getUTCDate() + n); return ymd(dt); }
function weekMonday(iso) { const dt = parseISO(iso); const back = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - back); return ymd(dt); }
function todayCT() { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function nowCT() {
  const p = {};
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return { date: p.year + "-" + p.month + "-" + p.day, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
function isPastDue(wm) { // due Tuesday (Monday+1) 12:00 CT
  const due = addDays(wm, 1); const now = nowCT();
  if (now.date > due) return true;
  if (now.date === due && now.minutes >= 12 * 60) return true;
  return false;
}
function keyFor(store, wm) { return "bw:reorder:" + store + ":" + wm; }

async function viewStore(store, iso) {
  const wm = weekMonday(iso);
  const cur = (await kv.kvGetJSON(keyFor(store, wm), {})) || {};
  const prev = (await kv.kvGetJSON(keyFor(store, addDays(wm, -7)), {})) || {};
  const past = isPastDue(wm);
  const categories = CATS.map((c) => {
    const orderedLast = prev[c.key] && prev[c.key].status === "ordered";
    const rec = cur[c.key];
    const status = rec ? rec.status : (orderedLast ? "cooldown" : "pending");
    const overdue = status === "pending" && past;
    return { key: c.key, label: c.label, note: c.note, status: status, by: rec ? rec.by : null, at: rec ? rec.at : null, overdue: overdue };
  });
  return {
    ok: true, store: store, weekMonday: wm, dueDate: addDays(wm, 1), dueLabel: "Tuesday 12:00pm",
    pastDue: past, anyOverdue: categories.some((c) => c.overdue), categories: categories,
  };
}

async function readBody(req) {
  if (req.body != null) { if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return {}; } } return req.body; }
  return await new Promise((resolve) => { let d = ""; req.on("data", (c) => { d += c; }); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (e) { resolve({}); } }); req.on("error", () => resolve({})); });
}

module.exports = async (req, res) => {
  const send = (o, c) => { res.setHeader("content-type", "application/json"); res.status(c || 200).json(o); };
  const q = req.query || {};
  try {
    if (req.method === "POST") {
      const body = await readBody(req);
      const store = body.store, cat = body.category, action = body.action, by = body.by || "Unknown";
      const iso = body.date || todayCT();
      if (!store || !cat) return send({ ok: false, error: "store and category required" }, 400);
      const k = keyFor(store, weekMonday(iso));
      const rec = (await kv.kvGetJSON(k, {})) || {};
      if (action === "ordered") rec[cat] = { status: "ordered", by: by, at: Date.now() };
      else if (action === "skip") rec[cat] = { status: "skip", by: by, at: Date.now() };
      else delete rec[cat];
      await kv.kvSetJSON(k, rec);
      return send(await viewStore(store, iso));
    }

    const iso = (q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date)) ? q.date : todayCT();
    if (q.overview) {
      const stores = await Promise.all(STORES.map((s) => viewStore(s, iso)));
      return send({ ok: true, weekMonday: weekMonday(iso), stores: stores, anyOverdue: stores.some((s) => s.anyOverdue) });
    }
    if (q.store) return send(await viewStore(q.store, iso));
    return send({ ok: false, error: "store or overview required" }, 400);
  } catch (e) {
    return send({ ok: false, error: e.message });
  }
};
