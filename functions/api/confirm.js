// GET /api/confirm?token=...  — marks a pending subscriber confirmed (double opt-in step 2).
import { page } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  if (!env.SUBS) return page("Not available", "<p>Alerts aren't configured yet.</p>");
  const token = new URL(request.url).searchParams.get("token") || "";
  const email = token && (await env.SUBS.get(`tok:${token}`));
  const rec = email && (await env.SUBS.get(`sub:${email}`, "json"));
  if (!rec) return page("Link invalid", "<p>That confirmation link is invalid or has expired.</p>");

  if (rec.status !== "confirmed") {
    rec.status = "confirmed";
    rec.confirmed = new Date().toISOString();
    await env.SUBS.put(`sub:${email}`, JSON.stringify(rec));
  }
  return page("You're subscribed", "<p>Done. You'll get an email whenever a tracked AI plan's limits or price change. Every alert has a one-click unsubscribe.</p>");
}
