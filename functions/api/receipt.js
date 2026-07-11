// POST /api/receipt — crowdsourced usage reading from the on-site form.
//
// Validates the submission and emails the maintainer a ready-to-verify data/usage-reports.json stub
// via Resend. A human still verifies and publishes; this only delivers the lead. Nothing is written
// to the repo automatically. The on-site form falls back to the GitHub issue template if this returns
// non-2xx, so the form is never a dead end even before the env vars are set.
//
// Cloudflare Pages env (Settings -> Environment variables / Secrets):
//   RESEND_API_KEY  (secret)  your Resend API key
//   RECEIPT_TO      (var)     where leads are emailed, e.g. you@example.com
//   RECEIPT_FROM    (var)     a verified Resend sender, e.g. "LimitWatch <receipts@limitwatch.dev>"
// Optional abuse controls (see README):
//   SUBS KV binding           preferred rate-limit store (shared with email alerts)
//   TURNSTILE_SECRET_KEY      when set, requires a valid Turnstile token

import { json, clientIp, allowRequest, verifyTurnstile } from "./_lib.js";

export async function onRequestPost({ request, env }) {
  let d;
  try { d = await request.json(); } catch { return json({ error: "bad json" }, 400); }

  // Honeypot: a real user never fills the off-screen "website" field. Pretend success, drop silently.
  if (d.website) return json({ ok: true });

  const required = ["provider", "plan", "window", "metric", "observed", "note"];
  for (const k of required) {
    if (d[k] == null || String(d[k]).trim() === "") return json({ error: `missing ${k}` }, 400);
  }
  if (d.confirm !== true && d.confirm !== "on" && d.confirm !== "true") return json({ error: "must confirm" }, 400);
  const observed = Number(d.observed);
  if (!Number.isFinite(observed)) return json({ error: "observed must be a number" }, 400);
  if (!["5h", "day", "week", "month"].includes(d.window)) return json({ error: "bad window" }, 400);
  if (!["percent", "messages", "tokens"].includes(d.metric)) return json({ error: "bad metric" }, 400);
  // Cheap abuse guard: cap field lengths.
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === "string" && v.length > 2000) return json({ error: `${k} too long` }, 400);
  }

  if (!env.RESEND_API_KEY || !env.RECEIPT_TO || !env.RECEIPT_FROM) {
    // Not configured yet — tell the client to fall back to the GitHub issue.
    return json({ error: "not configured" }, 503);
  }

  const ip = clientIp(request);
  const ts = await verifyTurnstile(env, d.turnstileToken, ip);
  if (!ts.ok) return json({ error: "challenge failed" }, 403);

  const store = env.SUBS || caches.default;
  if (!(await allowRequest(store, `receipt:ip:${ip}`, { limit: 5, windowSeconds: 3600 }))) {
    return json({ error: "rate limited" }, 429);
  }

  // A stub shaped like a data/usage-reports.json entry, so the maintainer can paste-and-verify.
  const stub = {
    provider: String(d.provider), plan: String(d.plan), surface: d.surface ? String(d.surface) : "",
    window: d.window, captured_at: new Date().toISOString(), metric: d.metric, observed,
    limit_hit: d.limit_hit === true || d.limit_hit === "true" || d.limit_hit === "on",
    value_basis: "crowdsourced", confidence: "crowdsourced",
    note: String(d.note).slice(0, 1500),
  };

  const text =
    `New crowdsourced usage reading submitted on limitwatch.dev.\n\n` +
    `Verify against the description before publishing; do not paste blindly.\n\n` +
    `Stub for data/usage-reports.json:\n${JSON.stringify(stub, null, 2)}\n\n` +
    `Raw submission:\n${JSON.stringify(d, null, 2)}`;

  let r;
  try {
    r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.RECEIPT_FROM,
        to: env.RECEIPT_TO,
        subject: `[limitwatch] reading: ${stub.provider} ${stub.plan} ${stub.window} ${stub.metric}`,
        text,
      }),
    });
  } catch { return json({ error: "send failed" }, 502); }
  if (!r.ok) return json({ error: "send failed", status: r.status }, 502);

  return json({ ok: true });
}
