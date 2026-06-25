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

export async function sendEmail(env, to, subject, text, html) {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.ALERT_FROM, to, subject, text, html }),
    });
    return r.ok;
  } catch { return false; }
}
