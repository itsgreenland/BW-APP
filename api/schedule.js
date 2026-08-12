// Serverless function: GET /api/schedule?date=YYYY-MM-DD
// Reads the live Connecteam schedule, matches each schedule to a store, and
// sorts scheduled people into morning / afternoon by shift start time.
// Key is read from CONNECTEAM_API_KEY (server-side only, never sent to browser).

const BASE = "https://api.connecteam.com";
const TZ = "America/Chicago"; // Oklahoma City
const MORNING_BEFORE_HOUR = 12; // starts before noon (local) = morning shift

const STORES = [
  { key: "hefner", label: "Hefner" },
  { key: "britton", label: "Britton" },
  { key: "meridian", label: "Meridian" },
  { key: "rockwell", label: "Rockwell" },
];

// Only these exact schedules are treated as "not a store".
function isIgnored(name) {
  const n = String(name || "").toLowerCase().trim();
  return n === "office" || n === "job scheduler" || n.indexOf("job scheduler") !== -1;
}

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

    // 3) Fetch today's shifts for EVERY schedule (over-fetch window, filter to local date)
    const [y, m, d] = date.split("-").map(Number);
    const dayStartUtc = Math.floor(Date.UTC(y, m - 1, d, 0, 0, 0) / 1000);
    const qStart = dayStartUtc - 12 * 3600;
    const qEnd = dayStartUtc + 36 * 3600;

    const shiftsBySchedule = {};
    const allSchedules = [];
    const debug = { unclassifiedShiftKeys: null };

    for (const sc of schedules) {
      const id = sc.schedulerId != null ? sc.schedulerId : sc.id;
      const name = sc.name || sc.title || "(unnamed)";
      const shr = await ct(`/scheduler/v1/schedulers/${id}/shifts?startTime=${qStart}&endTime=${qEnd}`, key);
      const raw = pickArray(shr.body, ["shifts", "items", "results"]);
      const todays = [];
      raw.forEach((s) => {
        const st = shiftStartUnix(s);
        if (st == null) { if (!debug.unclassifiedShiftKeys) debug.unclassifiedShiftKeys = Object.keys(s); return; }
        if (localParts(st).date === date) todays.push(s);
      });
      shiftsBySchedule[String(id)] = todays;
      allSchedules.push({ name: name, id: id, shiftsToday: todays.length, ignored: isIgnored(name) });
    }

    // 4) Match each store to a schedule and split into morning / afternoon
    const storeResults = STORES.map((store) => {
      const match = schedules.find((sc) => {
        const nm = String(sc.name || sc.title || "").toLowerCase();
        return !isIgnored(nm) && nm.indexOf(store.key) !== -1;
      });
      const result = { store: store.label, schedule: null, morning: [], afternoon: [], totalShifts: 0 };
      if (!match) return result;

      const sid = String(match.schedulerId != null ? match.schedulerId : match.id);
      result.schedule = match.name || match.title;
      (shiftsBySchedule[sid] || []).forEach((s) => {
        const lp = localParts(shiftStartUnix(s));
        result.totalShifts++;
        const bucket = lp.hour < MORNING_BEFORE_HOUR ? result.morning : result.afternoon;
        const ids = shiftUserIds(s);
        if (!ids.length) bucket.push({ name: "(open shift — nobody assigned)", start: lp.label, open: true });
        else ids.forEach((id) => bucket.push({ name: nameById[String(id)] || ("User " + id), start: lp.label }));
      });
      return result;
    });

    send({
      ok: true,
      date: date,
      timezone: TZ,
      stores: storeResults,
      allSchedules: allSchedules,
      debug: debug.unclassifiedShiftKeys ? debug : undefined,
    });
  } catch (e) {
    send({ ok: false, error: e.message });
  }
};
