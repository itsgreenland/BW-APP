// Serverless function: GET /api/schedule?date=YYYY-MM-DD
// Reads the live Connecteam schedule, matches each schedule to a store, and
// sorts scheduled people into morning / afternoon by shift start time.
// Key is read from CONNECTEAM_API_KEY (server-side only, never sent to browser).
//
// Store <-> schedule matching is by name. "Office" schedules are ignored, and
// "Job Scheduler" (Connecteam's default) matches no store, so it's ignored too.

const BASE = "https://api.connecteam.com";
const TZ = "America/Chicago"; // Oklahoma City
const MORNING_BEFORE_HOUR = 12; // starts before noon (local) = morning shift

const STORES = [
  { key: "hefner", label: "Hefner" },
  { key: "britton", label: "Britton" },
  { key: "meridian", label: "Meridian" },
  { key: "rockwell", label: "Rockwell" },
];

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

function userName(u) {
  if (!u) return null;
  if (u.name) return u.name;
  const f = u.firstName || u.firstname || "";
  const l = u.lastName || u.lastname || "";
  const n = (f + " " + l).trim();
  return n || u.email || ("User " + (u.userId != null ? u.userId : u.id));
}

function shiftUserIds(s) {
  const cands = s.assignedUserIds || s.userIds || s.assignedUsers || s.users || s.assignments;
  if (!Array.isArray(cands)) return [];
  return cands.map((x) => (x && typeof x === "object" ? (x.userId != null ? x.userId : x.id) : x)).filter((v) => v != null);
}

function shiftStartUnix(s) {
  let v = s.startTime != null ? s.startTime : (s.start != null ? s.start : (s.startTimestamp != null ? s.startTimestamp : (s.from != null ? s.from : s.shiftStart)));
  if (v == null) return null;
  if (typeof v === "string" && /^\d+$/.test(v)) v = Number(v);
  if (typeof v === "number") { if (v > 1e12) v = Math.floor(v / 1000); return v; }
  const t = Date.parse(v);
  return isNaN(t) ? null : Math.floor(t / 1000);
}

function localParts(unixSec) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = {};
  dtf.formatToParts(new Date(unixSec * 1000)).forEach((x) => { p[x.type] = x.value; });
  const hour = Number(p.hour) % 24;
  return { date: p.year + "-" + p.month + "-" + p.day, hour: hour, label: fmt12(hour, Number(p.minute)) };
}

function fmt12(h, m) {
  const ap = h < 12 ? "am" : "pm";
  let hh = h % 12; if (hh === 0) hh = 12;
  return hh + ":" + String(m).padStart(2, "0") + ap;
}

function todayInTZ() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

module.exports = async (req, res) => {
  const key = process.env.CONNECTEAM_API_KEY;
  const send = (obj) => { res.setHeader("content-type", "application/json"); res.status(200).json(obj); };

  if (!key) return send({ ok: false, error: "No CONNECTEAM_API_KEY set on the host." });

  const date = (req.query && req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) ? req.query.date : todayInTZ();

  try {
    // 1) Users map (id -> name)
    const ur = await ct("/users/v1/users?limit=500", key);
    const users = pickArray(ur.body, ["users", "items", "results"]);
    const nameById = {};
    users.forEach((u) => { const id = u.userId != null ? u.userId : u.id; if (id != null) nameById[String(id)] = userName(u); });

    // 2) Schedules
    const sr = await ct("/scheduler/v1/schedulers", key);
    const schedules = pickArray(sr.body, ["schedulers", "items", "results"]);

    // 3) Query window (over-fetch, then filter to the local date)
    const [y, m, d] = date.split("-").map(Number);
    const dayStartUtc = Math.floor(Date.UTC(y, m - 1, d, 0, 0, 0) / 1000);
    const qStart = dayStartUtc - 12 * 3600;
    const qEnd = dayStartUtc + 36 * 3600;

    const unmatched = [];
    const debug = { unclassifiedShiftKeys: null };

    const storeResults = [];
    for (const store of STORES) {
      // find a schedule for this store (name contains store key, not an "office")
      const match = schedules.find((s) => {
        const nm = String(s.name || s.title || "").toLowerCase();
        return nm.includes(store.key) && !nm.includes("office");
      });

      const result = { store: store.label, schedule: null, morning: [], afternoon: [], totalShifts: 0 };
      if (!match) { storeResults.push(result); continue; }

      const sid = match.schedulerId != null ? match.schedulerId : match.id;
      result.schedule = match.name || match.title;

      const shr = await ct(`/scheduler/v1/schedulers/${sid}/shifts?startTime=${qStart}&endTime=${qEnd}`, key);
      const shifts = pickArray(shr.body, ["shifts", "items", "results"]);

      shifts.forEach((s) => {
        const start = shiftStartUnix(s);
        if (start == null) { if (!debug.unclassifiedShiftKeys) debug.unclassifiedShiftKeys = Object.keys(s); return; }
        const lp = localParts(start);
        if (lp.date !== date) return; // shift is on another day
        result.totalShifts++;
        const bucket = lp.hour < MORNING_BEFORE_HOUR ? result.morning : result.afternoon;
        const ids = shiftUserIds(s);
        if (!ids.length) {
          bucket.push({ name: "(open shift — nobody assigned)", start: lp.label, open: true });
        } else {
          ids.forEach((id) => bucket.push({ name: nameById[String(id)] || ("User " + id), start: lp.label }));
        }
      });

      storeResults.push(result);
    }

    // note any real schedules we intentionally ignored
    schedules.forEach((s) => {
      const nm = String(s.name || s.title || "");
      const low = nm.toLowerCase();
      const isStore = STORES.some((st) => low.includes(st.key)) && !low.includes("office");
      if (!isStore) unmatched.push(nm);
    });

    send({ ok: true, date: date, timezone: TZ, stores: storeResults, ignoredSchedules: unmatched, debug: debug.unclassifiedShiftKeys ? debug : undefined });
  } catch (e) {
    send({ ok: false, error: e.message });
  }
};
