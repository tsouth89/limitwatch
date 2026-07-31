// POST /api/receipt — crowdsourced usage reading from the on-site form.
//
// Requires a screenshot (or short proof image) so submissions can be verified. Accepts
// multipart/form-data (preferred: fields + proof file) or JSON with evidenceUrl (fallback).
// Emails the maintainer a ready-to-verify data/usage-reports.json stub via Cloudflare Email
// Sending, with the
// proof attached when present. Nothing is auto-published.
//
// Cloudflare Pages env:
//   CLOUDFLARE_EMAIL_API_TOKEN  (secret)
//   CLOUDFLARE_ACCOUNT_ID       (var)
//   RECEIPT_TO      (var)
//   RECEIPT_FROM    (var)
// Optional: SUBS KV, TURNSTILE_SECRET_KEY

import { json, clientIp, allowRequest, verifyTurnstile, emailConfigured, sendEmail } from "./_lib.js";

const PROOF_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const PROOF_MAX = 1_500_000; // 1.5 MB
const CSV_MAX = 2_000_000;

function bytesToBase64(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

async function fileAttachment(file, fallbackName) {
  if (!file || typeof file === "string" || !file.size) return null;
  const buf = new Uint8Array(await file.arrayBuffer());
  return {
    filename: (file.name || fallbackName).replace(/[^\w.\-]+/g, "_").slice(0, 120),
    content: bytesToBase64(buf),
    type: file.type || "application/octet-stream",
    disposition: "attachment",
  };
}

async function parseBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const form = await request.formData();
    const d = {};
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") d[k] = v;
    }
    return { d, proof: form.get("proof"), csv: form.get("csv") };
  }
  const d = await request.json();
  return { d, proof: null, csv: null };
}

export async function onRequestPost({ request, env }) {
  let d, proof, csv;
  try {
    ({ d, proof, csv } = await parseBody(request));
  } catch {
    return json({ error: "bad body" }, 400);
  }

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
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === "string" && v.length > 2000) return json({ error: `${k} too long` }, 400);
  }

  const evidenceUrl = d.evidenceUrl ? String(d.evidenceUrl).trim() : "";
  const hasProofFile = proof && typeof proof !== "string" && proof.size > 0;
  if (!hasProofFile && !evidenceUrl) {
    return json({ error: "screenshot required" }, 400);
  }
  if (hasProofFile) {
    if (!PROOF_TYPES.has(proof.type)) return json({ error: "proof must be png, jpeg, webp, or gif" }, 400);
    if (proof.size > PROOF_MAX) return json({ error: "proof too large (max 1.5MB)" }, 400);
  }
  if (csv && typeof csv !== "string" && csv.size) {
    const name = (csv.name || "").toLowerCase();
    if (!name.endsWith(".csv") && csv.type && !csv.type.includes("csv") && csv.type !== "text/plain" && csv.type !== "application/vnd.ms-excel") {
      return json({ error: "optional csv must be a .csv file" }, 400);
    }
    if (csv.size > CSV_MAX) return json({ error: "csv too large (max 2MB)" }, 400);
  }

  if (!emailConfigured(env) || !env.RECEIPT_TO || !env.RECEIPT_FROM) {
    return json({ error: "not configured" }, 503);
  }

  const ip = clientIp(request);
  const ts = await verifyTurnstile(env, d.turnstileToken, ip);
  if (!ts.ok) return json({ error: "challenge failed" }, 403);

  const store = env.SUBS || caches.default;
  if (!(await allowRequest(store, `receipt:ip:${ip}`, { limit: 5, windowSeconds: 3600 }))) {
    return json({ error: "rate limited" }, 429);
  }

  const stub = {
    provider: String(d.provider),
    plan: String(d.plan),
    surface: d.surface ? String(d.surface) : "",
    window: d.window,
    captured_at: new Date().toISOString(),
    metric: d.metric,
    observed,
    limit_hit: d.limit_hit === true || d.limit_hit === "true" || d.limit_hit === "on",
    value_basis: "crowdsourced",
    confidence: "crowdsourced",
    note: String(d.note).slice(0, 1500),
    evidence: hasProofFile
      ? `screenshot attached (${proof.name || "proof"}, ${proof.type}, ${proof.size} bytes)`
      : `evidence url: ${evidenceUrl}`,
  };

  const attachments = [];
  const proofAtt = await fileAttachment(proof, "usage-proof.png");
  if (proofAtt) attachments.push(proofAtt);
  const csvAtt = await fileAttachment(csv, "usage-events.csv");
  if (csvAtt) attachments.push(csvAtt);

  const text =
    `New crowdsourced usage reading submitted on limitwatch.dev.\n\n` +
    `Verify the screenshot/CSV before publishing; do not paste blindly.\n\n` +
    `Stub for data/usage-reports.json:\n${JSON.stringify(stub, null, 2)}\n\n` +
    `Raw fields:\n${JSON.stringify(d, null, 2)}`;

  const email = {
    from: { address: env.RECEIPT_FROM, name: "LimitWatch" },
    to: env.RECEIPT_TO,
    subject: `[limitwatch] reading: ${stub.provider} ${stub.plan} ${stub.window} ${stub.metric}`,
    text,
  };
  if (attachments.length) email.attachments = attachments;

  if (!(await sendEmail(env, email))) return json({ error: "send failed" }, 502);

  return json({ ok: true });
}
