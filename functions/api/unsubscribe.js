// GET /api/unsubscribe?token=...  — removes a subscriber. Same token as the confirm link.
import { page } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  if (!env.SUBS) return page("Not available", "<p>Alerts aren't configured yet.</p>");
  const token = new URL(request.url).searchParams.get("token") || "";
  const email = token && (await env.SUBS.get(`tok:${token}`));
  if (email) {
    await env.SUBS.delete(`sub:${email}`);
    await env.SUBS.delete(`tok:${token}`);
  }
  return page("Unsubscribed", "<p>You won't get any more LimitWatch alerts. You can resubscribe anytime on the site.</p>");
}
