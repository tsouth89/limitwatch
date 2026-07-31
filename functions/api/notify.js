// POST /api/notify  (header x-notify-secret: <NOTIFY_SECRET>)
//
// Emails confirmed subscribers a digest of any NEW changelog entries since the last run. Triggered
// daily by .github/workflows/alerts.yml. Idempotent: it diffs the live changelog against a marker in
// KV, so running it repeatedly with no new changes sends nothing. Base the digest on data.json's
// derived `changes` (the per-limit changelog).
import { json, sendEmail, emailConfigured } from "./_lib.js";

const sig = (c) => `${c.date}|${c.kind}|${c.key || ""}|${c.from ?? ""}|${c.to ?? ""}`;

const fmtChange = (c) => {
  const p = (c.key || "").split("|");
  const prov = p[0] === "GitHub" ? "GitHub Copilot" : p[0];
  const plan = p[2] || "";
  let what;
  if (c.kind === "price_changed") what = `price $${c.from} -> $${c.to}/mo`;
  else if (c.kind === "limit_changed") what = `limit ${c.from} -> ${c.to}`;
  else if (c.kind === "model_changed") what = `${c.from} -> ${c.to}`;
  else if (c.kind === "limit_added") what = c.to == null ? "new plan/limit" : `new limit ${c.to}`;
  else if (c.kind === "limit_removed") what = "limit removed";
  else what = String(c.kind || "changed");
  return `${c.date}  ${prov} ${plan}: ${what}`;
};

export async function onRequestPost({ request, env }) {
  if (!env.SUBS || !emailConfigured(env) || !env.ALERT_FROM) return json({ error: "not configured" }, 503);
  if (!env.NOTIFY_SECRET || request.headers.get("x-notify-secret") !== env.NOTIFY_SECRET) return json({ error: "forbidden" }, 403);

  const base = new URL(request.url).origin;
  let data;
  try { data = await (await fetch(`${base}/data.json`, { cf: { cacheTtl: 0 } })).json(); }
  catch { return json({ error: "no data" }, 502); }
  const changes = Array.isArray(data.changes) ? data.changes : [];
  if (!changes.length) return json({ ok: true, sent: 0, reason: "no changes" });

  const latest = sig(changes[0]);
  const marker = await env.SUBS.get("meta:last_notified");
  if (marker === latest) return json({ ok: true, sent: 0, reason: "no new changes" });

  // New changes are everything above the marker; first run (no marker) seeds silently, like discovery.
  let fresh = [];
  if (marker) { for (const c of changes) { if (sig(c) === marker) break; fresh.push(c); } }
  if (!marker || !fresh.length) {
    await env.SUBS.put("meta:last_notified", latest);
    return json({ ok: true, sent: 0, reason: marker ? "nothing above marker" : "seeded baseline" });
  }
  fresh = fresh.slice(0, 20);

  // Collect confirmed subscribers (paginated list).
  const subs = [];
  let cursor;
  do {
    const list = await env.SUBS.list({ prefix: "sub:", cursor });
    for (const k of list.keys) {
      const r = await env.SUBS.get(k.name, "json");
      if (r && r.status === "confirmed" && r.token) subs.push(r);
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);

  const n = fresh.length;
  const subject = `LimitWatch: ${n} AI plan ${n === 1 ? "change" : "changes"}`;
  const lines = fresh.map(fmtChange);
  let sent = 0;
  for (const s of subs) {
    const unsub = `${base}/api/unsubscribe?token=${s.token}`;
    const text = `What changed on the AI plans LimitWatch tracks:\n\n${lines.join("\n")}\n\nSee the full changelog: ${base}/#changelog\n\nUnsubscribe: ${unsub}`;
    const html =
      `<div style="font-family:system-ui,sans-serif;max-width:560px;color:#11201d;line-height:1.55">` +
      `<h2 style="color:#0f766e">What changed</h2>` +
      `<ul style="padding-left:1.1rem">${fresh.map((c) => `<li style="margin:.25rem 0">${fmtChange(c)}</li>`).join("")}</ul>` +
      `<p><a href="${base}/#changelog" style="color:#0d9488;font-weight:600">Full changelog</a></p>` +
      `<p style="color:#4d625d;font-size:12px"><a href="${unsub}">Unsubscribe</a></p></div>`;
    if (await sendEmail(env, { from: env.ALERT_FROM, to: [s.email], subject, text, html })) sent++;
  }

  await env.SUBS.put("meta:last_notified", latest);
  return json({ ok: true, sent, changes: n, subscribers: subs.length });
}
