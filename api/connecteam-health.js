// Serverless function (Vercel zero-config): GET /api/connecteam-health
// Verifies the Connecteam API key WITHOUT ever exposing it to the browser.
// The key lives only in the CONNECTEAM_API_KEY environment variable on the host.
//
// NOTE: Connecteam's exact JSON response shapes are confirmed once we see the
// first live response. Parsing below is defensive and handles common shapes;
// the HTTP status codes (200 / 401 / 403) are what truly tell us auth + plan
// + permissions are correct, and those are reliable.

const BASE = "https://api.connecteam.com";

async function ct(path, key) {
  const res = await fetch(BASE + path, {
    headers: { "X-API-KEY": key, accept: "application/json" },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  return { status: res.status, ok: res.ok, body };
}

// Pull an array out of whatever envelope Connecteam wraps it in.
function pickArray(body, keys) {
  let node = body;
  if (node && node.data) node = node.data;
  if (Array.isArray(node)) return node;
  for (const k of keys) {
    if (node && Array.isArray(node[k])) return node[k];
  }
  return [];
}

module.exports = async (req, res) => {
  const key = process.env.CONNECTEAM_API_KEY;
  const out = { ok: false, checkedAt: new Date().toISOString(), steps: [], schedules: [], hint: null };
  const send = () => { res.setHeader("content-type", "application/json"); res.status(200).json(out); };
  const step = (label, ok, detail) => out.steps.push({ label, ok, detail });

  if (!key) {
    out.hint = "No key found yet. In your host's dashboard add an Environment Variable named CONNECTEAM_API_KEY, paste your Connecteam key as the value, then redeploy.";
    step("Find the API key", false, "CONNECTEAM_API_KEY is not set on the host");
    return send();
  }

  // ---- Step 1: connect + list schedules ----
  let schedules = [];
  try {
    const r = await ct("/scheduler/v1/schedulers", key);
    if (r.status === 401) {
      step("Connect to Connecteam", false, "401 — the key was rejected. Re-copy it in full (no spaces).");
      out.hint = "The key didn't work. Open the Connecteam API keys tab, copy the key again carefully, update it on the host, and redeploy.";
      return send();
    }
    if (r.status === 403) {
      step("Connect to Connecteam", true, "key accepted");
      step("Read the schedules", false, "403 — key isn't allowed to read the Job Scheduler.");
      out.hint = "The key connects but can't see the schedule yet. In Connecteam, give this key permission for the Job Scheduler (Shifts) and Users.";
      return send();
    }
    if (!r.ok) {
      step("Connect to Connecteam", false, "Connecteam returned " + r.status);
      out.hint = "Connecteam returned an unexpected code (" + r.status + "). Send me this and I'll adjust.";
      return send();
    }
    schedules = pickArray(r.body, ["schedulers", "items", "results"]);
    step("Connect to Connecteam", true, "key accepted");
    step("Read the schedules", true, schedules.length + " schedule(s) found");
    out.schedules = schedules.map((s) => ({
      id: s.schedulerId != null ? s.schedulerId : s.id,
      name: s.name || s.title || "(unnamed)",
    }));
  } catch (e) {
    step("Connect to Connecteam", false, e.message);
    out.hint = "Couldn't reach Connecteam from the host: " + e.message;
    return send();
  }

  // ---- Step 2: read today's shifts on the first schedule ----
  try {
    if (out.schedules.length) {
      const sid = out.schedules[0].id;
      const now = new Date();
      const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
      const end = start + 24 * 3600;
      const r = await ct(`/scheduler/v1/schedulers/${sid}/shifts?startTime=${start}&endTime=${end}`, key);
      if (r.ok) {
        const shifts = pickArray(r.body, ["shifts", "items", "results"]);
        step("Read today's shifts", true, shifts.length + ' shift(s) today on "' + out.schedules[0].name + '"');
      } else {
        step("Read today's shifts", false, "returned " + r.status);
      }
    } else {
      step("Read today's shifts", false, "no schedules to read from");
    }
  } catch (e) {
    step("Read today's shifts", false, e.message);
  }

  // ---- Step 3: read team members (needed to know who's who / phone for pings) ----
  try {
    const r = await ct("/users/v1/users?limit=1", key);
    if (r.ok) {
      step("Read team members", true, "team directory reachable");
    } else if (r.status === 403) {
      step("Read team members", false, "403 — give the key Users permission in Connecteam");
    } else {
      step("Read team members", false, "returned " + r.status);
    }
  } catch (e) {
    step("Read team members", false, e.message);
  }

  out.ok = out.steps.every((s) => s.ok);
  if (out.ok) out.hint = "Everything's connected. The app can read your schedule — we're clear to build auto-assignment.";
  else if (!out.hint) out.hint = "Connected, with a couple of gaps — see the red steps above.";
  return send();
};
