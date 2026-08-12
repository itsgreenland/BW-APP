// Tiny database helper using Upstash Redis over its REST API — no npm packages,
// so it works with our zero-build setup.
//
// Different Vercel/Upstash integrations name the connection variables
// differently (UPSTASH_REDIS_REST_URL, KV_REST_API_URL, a custom prefix, ...),
// so instead of hard-coding one name we auto-detect any REST url/token pair.

function findCreds() {
  const e = process.env;
  let url = e.UPSTASH_REDIS_REST_URL || e.KV_REST_API_URL || e.REDIS_REST_URL || null;
  let token = e.UPSTASH_REDIS_REST_TOKEN || e.KV_REST_API_TOKEN || e.REDIS_REST_TOKEN || null;

  if (!url) {
    const k = Object.keys(e).find((k) => /(REDIS|KV|UPSTASH|STORAGE)/i.test(k) && /REST/i.test(k) && /URL$/i.test(k));
    if (k) url = e[k];
  }
  if (!token) {
    const ks = Object.keys(e).filter((k) => /(REDIS|KV|UPSTASH|STORAGE)/i.test(k) && /REST/i.test(k) && /TOKEN$/i.test(k));
    const k = ks.find((x) => !/READ.?ONLY/i.test(x)) || ks[0]; // prefer the read-write token
    if (k) token = e[k];
  }
  return { url: url, token: token };
}

// Names only (never values) of settings that look database-related — for diagnostics.
function candidateKeys() {
  return Object.keys(process.env).filter((k) => /(REDIS|KV|UPSTASH|STORAGE)/i.test(k));
}

const creds = findCreds();
const configured = !!(creds.url && creds.token);

async function cmd(args) {
  if (!configured) throw new Error("Database is not connected yet.");
  const res = await fetch(creds.url, {
    method: "POST",
    headers: { Authorization: "Bearer " + creds.token, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const j = await res.json();
  if (j && j.error) throw new Error(j.error);
  return j ? j.result : null;
}

async function kvGet(key) { return cmd(["GET", key]); }
async function kvSet(key, val) { return cmd(["SET", key, val]); }
async function kvGetJSON(key, fallback) {
  const v = await kvGet(key);
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}
async function kvSetJSON(key, obj) { return kvSet(key, JSON.stringify(obj)); }

module.exports = { configured, candidateKeys, cmd, kvGet, kvSet, kvGetJSON, kvSetJSON };
