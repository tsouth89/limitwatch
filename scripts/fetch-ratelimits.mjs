#!/usr/bin/env node
// Metered usage capture (roadmap item). Make ONE cheap API call per provider and record the
// rate-limit headers + token usage the provider hands back. This measures real budgets without
// draining anything — no spamming a cap to zero (that risks a ban and prompt-caching skews the
// count). See data/ratelimits/ for the dated records.
//
// IMPORTANT SCOPE: these headers report the *API tier* rate limits (per-minute request/token
// budgets) and exact per-call token usage. They are NOT the Claude.ai / ChatGPT *subscription*
// caps (the 5-hour / weekly chat limits) — those are not exposed by any API and still need the
// in-product usage UI or crowdsourced receipts. So this is the honest data source for API- and
// credit-billed plans and for real per-model token cost; it does not measure chat-plan caps.
//
// Runs only when the matching key is in the environment; absent keys are skipped, never invented.
//   ANTHROPIC_API_KEY=...  OPENAI_API_KEY=...  node scripts/fetch-ratelimits.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "data", "ratelimits");
const today = new Date().toISOString().slice(0, 10);

// Pull out every rate-limit header a provider returned, with the provider's own naming preserved.
const grabHeaders = (res, prefixes) => {
  const out = {};
  for (const [k, v] of res.headers) {
    if (prefixes.some((p) => k.toLowerCase().startsWith(p))) out[k.toLowerCase()] = v;
  }
  return out;
};

// One minimal Anthropic call (max_tokens: 1) → rate-limit headers + usage. Cheapest possible probe.
async function probeAnthropic(key) {
  const model = process.env.ANTHROPIC_PROBE_MODEL || "claude-haiku-4-5-20251001";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
  });
  const body = await res.json().catch(() => ({}));
  return {
    provider: "Anthropic",
    model,
    ok: res.ok,
    status: res.status,
    ratelimit: grabHeaders(res, ["anthropic-ratelimit-", "retry-after"]),
    usage: body.usage ?? null,           // exact input/output/cache tokens for this call
    error: res.ok ? null : (body.error?.message ?? `HTTP ${res.status}`),
  };
}

// One minimal OpenAI call → x-ratelimit-* headers + usage.
async function probeOpenAI(key) {
  const model = process.env.OPENAI_PROBE_MODEL || "gpt-5.5";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, max_completion_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
  });
  const body = await res.json().catch(() => ({}));
  return {
    provider: "OpenAI",
    model,
    ok: res.ok,
    status: res.status,
    ratelimit: grabHeaders(res, ["x-ratelimit-", "retry-after"]),
    usage: body.usage ?? null,
    error: res.ok ? null : (body.error?.message ?? `HTTP ${res.status}`),
  };
}

const probes = [];
if (process.env.ANTHROPIC_API_KEY) probes.push(probeAnthropic(process.env.ANTHROPIC_API_KEY));
else console.log("[skip] ANTHROPIC_API_KEY not set");
if (process.env.OPENAI_API_KEY) probes.push(probeOpenAI(process.env.OPENAI_API_KEY));
else console.log("[skip] OPENAI_API_KEY not set");

if (!probes.length) {
  console.log("\nNo provider keys in the environment — nothing to probe. Set ANTHROPIC_API_KEY and/or OPENAI_API_KEY.");
  process.exit(0);
}

const records = [];
for (const p of probes) {
  try { records.push(await p); }
  catch (e) { records.push({ ok: false, error: e.message }); }
}

mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${today}.json`);
const existing = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { date: today, readings: [] };
existing.readings.push({ at: new Date().toISOString(), records });
writeFileSync(file, JSON.stringify(existing, null, 2));

console.log("\nMetered usage reading:");
for (const r of records) {
  if (!r.ok) { console.log(`  [${r.provider ?? "?"}] ERROR ${r.error}`); continue; }
  const keys = Object.keys(r.ratelimit).length;
  const u = r.usage ? `usage ${JSON.stringify(r.usage)}` : "no usage body";
  console.log(`  [${r.provider}] ${r.model} — ${keys} rate-limit header(s), ${u}`);
}
console.log(`\nWrote ${file}`);
