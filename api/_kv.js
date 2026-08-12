// Tiny database helper using Upstash Redis over its REST API — no npm packages,
// so it works with our zero-build setup. Provisioned free from the Vercel
// dashboard (Storage → Upstash), which sets these two environment variables:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
// (Vercel's KV integration sets KV_REST_API_URL / KV_REST_API_TOKEN — we accept
// either naming so it works whichever way the store is created.)

const REST_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const configured = !!(REST_URL && REST_TOKEN);

async function cmd(args) {
  if (!configured) throw new Error("Database is not connected yet.");
  const res = await fetch(REST_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REST_TOKEN, "content-type": "application/json" },
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

module.exports = { configured, cmd, kvGet, kvSet, kvGetJSON, kvSetJSON };
