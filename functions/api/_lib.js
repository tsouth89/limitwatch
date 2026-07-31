// Shared helpers for the email-alerts Pages Functions (subscribe / confirm / unsubscribe / notify).
// Files starting with _ are not routed by Pages, only imported.

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// A minimal styled HTML page for the confirm/unsubscribe landing screens.
export const page = (title, body) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · LimitWatch</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:520px;margin:3rem auto;padding:0 1.2rem;color:#11201d;line-height:1.55">` +
    `<h1 style="color:#0f766e;font-size:1.4rem">${title}</h1>${body}` +
    `<p style="margin-top:1.5rem"><a href="https://limitwatch.dev" style="color:#0d9488;font-weight:600">limitwatch.dev</a></p></body></html>`,
    { headers: { "content-type": "text/html;charset=utf-8" } }
  );

export const validEmail = (e) =>
  typeof e === "string" && e.length <= 200 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// Two UUIDs concatenated → a long opaque token used for confirm + unsubscribe links.
export const newToken = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");

export function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// Fixed-window counter. Prefers KV; falls back to the Cache API so receipt can limit without SUBS.
export async function allowRequest(store, key, { limit = 5, windowSeconds = 3600 } = {}) {
  if (!store) return false;
  const now = Date.now();
  const k = `rl:${key}`;

  if (typeof store.get === "function" && typeof store.put === "function") {
    // KV binding
    let state = await store.get(k, "json");
    if (!state || !state.reset || state.reset <= now) {
      state = { n: 1, reset: now + windowSeconds * 1000 };
      await store.put(k, JSON.stringify(state), { expirationTtl: Math.max(60, windowSeconds + 60) });
      return true;
    }
    if (state.n >= limit) return false;
    state.n += 1;
    const ttl = Math.max(60, Math.ceil((state.reset - now) / 1000));
    await store.put(k, JSON.stringify(state), { expirationTtl: ttl });
    return true;
  }

  // Cache API fallback (caches.default)
  const cacheKey = new Request(`https://limitwatch.internal/rate-limit/${encodeURIComponent(key)}`);
  const hit = await store.match(cacheKey);
  let state = null;
  if (hit) {
    try { state = await hit.json(); } catch { state = null; }
  }
  if (!state || !state.reset || state.reset <= now) {
    state = { n: 1, reset: now + windowSeconds * 1000 };
  } else if (state.n >= limit) {
    return false;
  } else {
    state.n += 1;
  }
  const ttl = Math.max(60, Math.ceil((state.reset - now) / 1000));
  await store.put(
    cacheKey,
    new Response(JSON.stringify(state), {
      headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
    })
  );
  return true;
}

// Optional Turnstile: when TURNSTILE_SECRET_KEY is set, require a valid token before sending email.
export async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET_KEY) return { ok: true, skipped: true };
  if (!token || typeof token !== "string") return { ok: false };
  try {
    const body = new URLSearchParams();
    body.set("secret", env.TURNSTILE_SECRET_KEY);
    body.set("response", token);
    if (ip && ip !== "unknown") body.set("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const j = await r.json().catch(() => ({}));
    return { ok: !!j.success };
  } catch {
    return { ok: false };
  }
}

export const emailConfigured = (env) =>
  !!(env.CLOUDFLARE_EMAIL_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID);

export async function sendEmail(env, email) {
  if (!emailConfigured(env)) return false;
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/sending/send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.CLOUDFLARE_EMAIL_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(email),
      }
    );
    return r.ok;
  } catch { return false; }
}
