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

// If a schedule name doesn't obviously contain the store name, we fall back to
// matching by the people known to work there (first-name fingerprint).
const ROSTER = {
  britton: ["abriana", "amara", "catalina", "mariah", "naila", "tayetta"],
};

function isIgnored(name) {
  const n = String(name || "").toLowerCase();
  return n.indexOf("office") !== -1 || n.indexOf("job scheduler") !== -1;
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

function pagingTotal(body) {
  const p = (body && (body.paging || (body.data && body.data.paging))) || null;
  if (p && typeof p.total === "number") return p.total;
  if (body && typeof body.total === "number") return body.total;
  return null;
}

// Fetch a list endpoint. Do a plain request first (known to work), then page
// with offset ONLY if the response advertises more via a paging total — this
// avoids sending params to endpoints that might reject them.
async function ctPaged(path, key, arrayKeys) {
  const first = await ct(path, key);
  if (!first.ok) return [];
  let all = pickArray(first.body, arrayKeys);
  const total = pagingTotal(first.body);
  if (total == null || all.length >= total || all.length === 0) return all;
  let offset = all.length;
  for (let guard = 0; guard < 60 && offset < total; guard++) {
    const sep = path.indexOf("?") === -1 ? "?" : "&";
    const r = await ct(path + sep + "offset=" + offset + "&limit=100", key);
    if (!r.ok) break;
    const arr = pickArray(r.body, arrayKeys);
    if (!arr.length) break;
    all = all.concat(arr);
    offset += arr.length;
  }
  return all;
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
    // 1) Users map (id -> name), paged
    const users = await ctPaged("/users/v1/users", key, ["users", "items", "results"]);
    const nameById = {};
    users.forEach((u) => { const id = u.userId != null ? u.userId : u.id; if (id != null) nameById[String(id)] = userName(u); });

    // 2) Schedules, paged (this is the fix if some were being cut off)
    const schedules = await ctPaged("/scheduler/v1/schedulers", key, ["schedulers", "items", "results"]);

    // 3) Fetch today's shifts for EVERY schedule (over-fetch window, filter to local date)
    const [y, m, d] = date.split("-").map(Number);
    const dayStartUtc = Math.floor(Date.UTC(y, m - 1, d, 0, 0, 0) / 1000);
    const qStart = dayStartUtc - 12 * 3600;
    const qEnd = dayStartUtc + 36 * 3600;

    const shiftsBySchedule = {};   // id -> [shift]
    const peopleBySchedule = {};   // id -> Set(lowercase names)
    const allSchedules = [];
    const debug = { unclassifiedShiftKeys: null };

    for (const sc of schedules) {
      const id = sc.schedulerId != null ? sc.schedulerId : sc.id;
      const name = sc.name || sc.title || "(unnamed)";
      const raw = await ctPaged(`/scheduler/v1/schedulers/${id}/shifts?startTime=${qStart}&endTime=${qEnd}`, key, ["shifts", "items", "results"]);
      const todays = [];
      const people = new Set();
      raw.forEach((s) => {
        const st = shiftStartUnix(s);
        if (st == null) { if (!debug.unclassifiedShiftKeys) debug.unclassifiedShiftKeys = Object.keys(s); return; }
        if (localParts(st).date !== date) return;
        todays.push(s);
        shiftUserIds(s).forEach((uid) => { const nm = nameById[String(uid)]; if (nm) people.add(nm.toLowerCase()); });
      });
      shiftsBySchedule[String(id)] = todays;
      peopleBySchedule[String(id)] = people;
      allSchedules.push({
        name: name, id: id, shiftsToday: todays.length, ignored: isIgnored(name),
        people: Array.from(people).map(function (n) { return n.replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }),
      });
    }

    // helper: does a schedule's people match a store roster?
    function rosterMatch(schedId, roster) {
      const people = peopleBySchedule[String(schedId)];
      if (!people || !roster) return false;
      for (const r of roster) {
        for (const person of people) { if (person.indexOf(r) !== -1) return true; }
      }
      return false;
    }

    // 4) Match each store to a schedule (by name, else by roster) and split shifts
    const storeResults = STORES.map((store) => {
      const roster = ROSTER[store.key];
      // Every schedule that could be this store: name contains the store word,
      // or it carries the store's known crew. (A store can have more than one
      // schedule with the same name — e.g. an old empty one and the live one.)
      const candidates = schedules.filter((sc) => {
        const nm = String(sc.name || sc.title || "").toLowerCase();
        if (isIgnored(nm)) return false;
        const id = sc.schedulerId != null ? sc.schedulerId : sc.id;
        return nm.indexOf(store.key) !== -1 || rosterMatch(id, roster);
      });
      // Among candidates, prefer the one that actually has this store's crew,
      // then the one with the most shifts — that's the live schedule.
      function score(sc) {
        const id = String(sc.schedulerId != null ? sc.schedulerId : sc.id);
        const people = peopleBySchedule[id] || new Set();
        let rc = 0;
        if (roster) roster.forEach((r) => { for (const p of people) { if (p.indexOf(r) !== -1) { rc++; break; } } });
        return rc * 1000 + (shiftsBySchedule[id] || []).length;
      }
      candidates.sort((a, b) => score(b) - score(a));
      const match = candidates[0] || null;
      const how = match ? (String(match.name || match.title || "").toLowerCase().indexOf(store.key) !== -1 ? "name" : "people") : null;

      const result = { store: store.label, schedule: null, matchedBy: how, morning: [], afternoon: [], totalShifts: 0 };
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
      ok: true, date: date, timezone: TZ,
      stores: storeResults, allSchedules: allSchedules,
      debug: debug.unclassifiedShiftKeys ? debug : undefined,
    });
  } catch (e) {
    send({ ok: false, error: e.message });
  }
};
