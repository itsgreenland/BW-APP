// Serverless function: GET /api/roster
// Lists everyone from Connecteam grouped by their location, split into key
// holders vs. everyone else, with each person's exact role (Title custom field)
// so the role detection can be verified. Key read from CONNECTEAM_API_KEY.

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
function pagingTotal(body) {
  const p = (body && (body.paging || (body.data && body.data.paging))) || null;
  if (p && typeof p.total === "number") return p.total;
  if (body && typeof body.total === "number") return body.total;
  return null;
}
async function pagedUsers(key) {
  const first = await ct("/users/v1/users", key);
  if (!first.ok) return [];
  let all = pickArray(first.body, ["users", "items", "results"]);
  const total = pagingTotal(first.body);
  if (total == null || all.length >= total || all.length === 0) return all;
  let offset = all.length;
  for (let g = 0; g < 60 && offset < total; g++) {
    const r = await ct("/users/v1/users?offset=" + offset + "&limit=100", key);
    if (!r.ok) break;
    const arr = pickArray(r.body, ["users", "items", "results"]);
    if (!arr.length) break;
    all = all.concat(arr); offset += arr.length;
  }
  return all;
}
function userName(u) {
  const f = u.firstName || u.firstname || "", l = u.lastName || u.lastname || "";
  const n = (f + " " + l).trim();
  return n || u.name || u.email || ("User " + (u.userId != null ? u.userId : u.id));
}
function cfValue(f) {
  if (typeof f.value === "string") return f.value;
  if (Array.isArray(f.value)) return f.value.map((x) => (x && typeof x === "object" ? (x.value != null ? x.value : x.name) : x)).join(", ");
  return f.value != null ? String(f.value) : "";
}
function extract(u) {
  const cf = Array.isArray(u.customFields) ? u.customFields : [];
  let role = "", location = "";
  cf.forEach((f) => {
    const nm = (f.name || "").toLowerCase();
    if (!role && /title|position|role/.test(nm)) role = cfValue(f);
    if (!location && /location|store|site|branch/.test(nm)) location = cfValue(f);
  });
  if (!location) { // fallback: first dropdown-style field that isn't the title
    for (const f of cf) {
      const nm = (f.name || "").toLowerCase();
      if (/title|position|role/.test(nm)) continue;
      if (Array.isArray(f.value)) { location = cfValue(f); break; }
    }
  }
  return { name: userName(u), role: role, location: location, archived: !!u.isArchived };
}
function isKeyHolder(role) { return /key/i.test(role || ""); }

module.exports = async (req, res) => {
  const key = process.env.CONNECTEAM_API_KEY;
  const send = (o) => { res.setHeader("content-type", "application/json"); res.status(200).json(o); };
  if (!key) return send({ ok: false, error: "No CONNECTEAM_API_KEY set." });

  try {
    const users = await pagedUsers(key);
    const groups = {}; // location -> { keyHolders:[], others:[] }
    let keyHolderTotal = 0, active = 0;

    users.forEach((u) => {
      const info = extract(u);
      if (info.archived) return;
      active++;
      const loc = info.location || "(no location set)";
      groups[loc] = groups[loc] || { keyHolders: [], others: [] };
      if (isKeyHolder(info.role)) { groups[loc].keyHolders.push({ name: info.name, role: info.role }); keyHolderTotal++; }
      else groups[loc].others.push({ name: info.name, role: info.role || "(no title set)" });
    });

    const locations = Object.keys(groups).sort().map((loc) => ({
      location: loc,
      keyHolders: groups[loc].keyHolders.sort((a, b) => a.name.localeCompare(b.name)),
      others: groups[loc].others.sort((a, b) => a.name.localeCompare(b.name)),
    }));

    send({ ok: true, activeEmployees: active, keyHolderTotal: keyHolderTotal, locations: locations });
  } catch (e) {
    send({ ok: false, error: e.message });
  }
};
