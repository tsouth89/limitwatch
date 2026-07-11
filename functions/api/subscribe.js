// POST /api/subscribe  { email }
// Stores a PENDING subscriber in KV and sends a double-opt-in confirmation email. Nobody is added to
// the alert list until they click the confirm link, so you can't sign someone else up.
//
// Needs the SUBS KV binding plus RESEND_API_KEY and ALERT_FROM env vars (see README).
import { json, validEmail, newToken, sendEmail, clientIp, allowRequest, verifyTurnstile } from "./_lib.js";

export async function onRequestPost({ request, env }) {
  if (!env.SUBS || !env.RESEND_API_KEY || !env.ALERT_FROM) return json({ error: "not configured" }, 503);

  let d;
  try { d = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  if (d.website) return json({ ok: true });                       // honeypot: pretend success, drop
  const email = String(d.email || "").trim().toLowerCase();
  if (!validEmail(email)) return json({ error: "invalid email" }, 400);

  const ip = clientIp(request);
  const ts = await verifyTurnstile(env, d.turnstileToken, ip);
  if (!ts.ok) return json({ error: "challenge failed" }, 403);

  // Cap outbound confirm emails per IP and per address.
  if (!(await allowRequest(env.SUBS, `sub:ip:${ip}`, { limit: 5, windowSeconds: 3600 }))) {
    return json({ error: "rate limited" }, 429);
  }
  if (!(await allowRequest(env.SUBS, `sub:email:${email}`, { limit: 3, windowSeconds: 3600 }))) {
    return json({ error: "rate limited" }, 429);
  }

  const existing = await env.SUBS.get(`sub:${email}`, "json");
  if (existing && existing.status === "confirmed") return json({ ok: true, already: true });

  const token = newToken();
  await env.SUBS.put(`sub:${email}`, JSON.stringify({ email, status: "pending", token, created: new Date().toISOString() }));
  await env.SUBS.put(`tok:${token}`, email);

  const base = new URL(request.url).origin;
  const confirmUrl = `${base}/api/confirm?token=${token}`;
  const unsubUrl = `${base}/api/unsubscribe?token=${token}`;
  const text =
    `Confirm your LimitWatch alerts subscription:\n${confirmUrl}\n\n` +
    `You'll get an email when a tracked AI plan's limits or price change. If this wasn't you, just ignore it.\n\n` +
    `Unsubscribe anytime: ${unsubUrl}`;
  const html =
    `<div style="font-family:system-ui,sans-serif;max-width:520px;color:#11201d;line-height:1.55">` +
    `<h2 style="color:#0f766e">Confirm your LimitWatch alerts</h2>` +
    `<p>Click below to start getting an email whenever a tracked AI plan's limits or price change:</p>` +
    `<p><a href="${confirmUrl}" style="display:inline-block;background:#0d9488;color:#fff;padding:.6rem 1.1rem;border-radius:8px;text-decoration:none;font-weight:600">Confirm subscription</a></p>` +
    `<p style="color:#4d625d;font-size:13px">If this wasn't you, ignore this email. <a href="${unsubUrl}">Unsubscribe</a>.</p></div>`;

  const ok = await sendEmail(env, [email], "Confirm your LimitWatch alerts", text, html);
  if (!ok) return json({ error: "send failed" }, 502);
  return json({ ok: true });
}
