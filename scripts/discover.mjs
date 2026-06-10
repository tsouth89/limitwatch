#!/usr/bin/env node
// News DISCOVERY (complements scripts/fetch.mjs, which only diffs known pricing pages). Polls the
// provider news/changelog feeds in data/feeds.json, finds items not seen before, and — if an
// ANTHROPIC_API_KEY is present — asks a cheap model which of them are actually about subscription
// limits / quotas / pricing and drafts an events.json stub for each. Writes data/_discover-summary.md
// for the CI job to open an issue. Human stays in the loop: it proposes, it never edits data.
//
// Degrades gracefully: with no key it still lists the new items (you triage by hand); with a key it
// filters the noise and drafts stubs. Run: `node scripts/discover.mjs` (or `--all` to ignore state).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// Pure parsing + the quote-verification guard live in a side-effect-free module so they can be
// unit-tested without triggering this script's top-level network/fs work.
import { stripHtml, quoteInSource, parseFeed, parseHtml } from "./lib/discover-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const feedsPath = join(root, "data", "feeds.json");
const statePath = join(root, "data", "discover-state.json");
const summaryPath = join(root, "data", "_discover-summary.md");
const all = process.argv.includes("--all");

const cfg = JSON.parse(readFileSync(feedsPath, "utf8"));
const firstRun = !existsSync(statePath);   // cold start: seed a baseline, report nothing
const state = firstRun ? { seen: {} } : JSON.parse(readFileSync(statePath, "utf8"));
const nowIso = new Date().toISOString();
// Feeds can carry a deep archive (OpenAI's serves ~1000 items); only the newest few are "news".
const PER_FEED = Number(process.env.DISCOVER_PER_FEED || 30);

const fresh = [];
for (const f of cfg.feeds) {
  try {
    const res = await fetch(f.url, { headers: { "user-agent": "LimitWatch-discover/1.0" } });
    if (!res.ok) { console.log(`[skip] ${f.url} HTTP ${res.status}`); continue; }
    const text = await res.text();
    const parsed = f.format === "html" ? parseHtml(text, f.base ?? f.url, f.link_pattern) : parseFeed(text);
    const items = parsed.slice(0, PER_FEED);   // newest-first sources -> recent only
    console.log(`[ok] ${f.provider}: ${items.length} recent item(s) from ${f.url}`);
    for (const it of items) {
      if (!firstRun && (all || !state.seen[it.id])) fresh.push({ ...it, provider: f.provider, product: f.product ?? null });
      state.seen[it.id] ??= nowIso;   // mark seen in the same pass
    }
  } catch (e) { console.log(`[err] ${f.url}: ${e.message}`); }
}
if (firstRun) { writeFileSync(statePath, JSON.stringify(state, null, 2)); console.log(`Baseline established (${Object.keys(state.seen).length} items seeded); no report on first run.`); process.exit(0); }
// Bound state growth: keep the most recent 800 ids.
const ids = Object.entries(state.seen).sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, 800);
state.seen = Object.fromEntries(ids);
writeFileSync(statePath, JSON.stringify(state, null, 2));

if (!fresh.length) { console.log("No new items."); process.exit(0); }
console.log(`\n${fresh.length} new item(s).`);

// Optional relevance filter + event-stub drafting (cheap model, one batched call).
let relevant = null;
if (process.env.ANTHROPIC_API_KEY && fresh.length) {
  const model = process.env.ANTHROPIC_DISCOVER_MODEL || "claude-haiku-4-5-20251001";
  const list = fresh.map((it, i) => `${i}. [${it.provider}] ${it.title} — ${it.link}`).join("\n");
  const prompt = `You triage AI-provider news for a site that tracks SUBSCRIPTION usage limits, quotas, rate limits, and consumer plan pricing over time.\n\nFrom the numbered items below, return ONLY the ones that announce a change to subscription/plan usage limits, quotas, rate limits, message/request/token caps, or consumer plan pricing/credits. Ignore model releases, infra, security, SDKs, partnerships, and enterprise sales unless they change a published consumer limit or price.\n\nReturn a JSON array (no prose). Each element: {"index": <number>, "why": "<one sentence>", "kind": "limit_boost|limit_cut|pricing_change|promo|new_plan", "confidence": "official|announced"}. If none qualify, return [].\n\nItems:\n${list}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
    });
    const body = await res.json();
    const text = body?.content?.[0]?.text ?? "[]";
    relevant = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
  } catch (e) { console.log(`[llm] classify failed, falling back to raw list: ${e.message}`); }
}

// Build the summary the CI job turns into an issue.
const lines = [`# Discovery: ${fresh.length} new provider item(s) — ${nowIso.slice(0, 10)}`, ""];
if (relevant) {
  if (relevant.length) {
    lines.push(`## ⚠ ${relevant.length} look limit/pricing-relevant — review for events.json`, "");
    for (const r of relevant) {
      const it = fresh[r.index]; if (!it) continue;
      lines.push(`### ${it.provider}: ${it.title}`);
      lines.push(`- **Why:** ${r.why}`);
      lines.push(`- **Link:** ${it.link}`);
      lines.push("- **Draft event stub** (verify the quote against the source before merging):");
      lines.push("```json");
      lines.push(JSON.stringify({
        id: `${it.provider.toLowerCase()}-CHANGEME-2026`, provider: it.provider, product: it.product ?? "",
        applies_to: [], title: it.title.slice(0, 80), kind: r.kind, starts_on: (it.date && new Date(it.date).toISOString().slice(0, 10)) || "2026-00-00",
        ends_on: null, permanent: true, confidence: r.confidence,
        quote: "PASTE the exact sentence from the source", source: it.link, note: ""
      }, null, 2));
      lines.push("```", "");
    }
  } else {
    lines.push("_Classifier reviewed the new items; none look limit/pricing-relevant._", "");
  }
  lines.push("<details><summary>All new items</summary>", "");
}
for (const it of fresh) lines.push(`- [${it.provider}] [${it.title}](${it.link}) ${it.date ? `· ${it.date}` : ""}`);
if (relevant) lines.push("", "</details>");
writeFileSync(summaryPath, lines.join("\n"));
console.log(`Wrote ${summaryPath}${relevant ? ` (${relevant.length} relevant)` : " (no LLM filter — raw list)"}`);

// Append the LLM-flagged items to the site's news radar (data/news.json) so relevant news shows
// on the site automatically — badged unverified, never promoted to a verified event without a human.
if (relevant && relevant.length) {
  const newsPath = join(root, "data", "news.json");
  const news = existsSync(newsPath) ? JSON.parse(readFileSync(newsPath, "utf8")) : { schema: 1, note: "Auto-flagged news radar (unverified). Appended by scripts/discover.mjs.", items: [] };
  const have = new Set((news.items || []).map((i) => i.link));
  let added = 0;
  for (const r of relevant) {
    const it = fresh[r.index]; if (!it || have.has(it.link)) continue;
    news.items.unshift({
      at: (it.date && new Date(it.date).toISOString().slice(0, 10)) || nowIso.slice(0, 10),
      provider: it.provider, product: it.product ?? null, title: it.title, link: it.link,
      why: r.why, kind: r.kind, confidence: r.confidence,
    });
    have.add(it.link); added++;
  }
  news.items = news.items.slice(0, 40);   // keep the radar recent
  writeFileSync(newsPath, JSON.stringify(news, null, 2));
  console.log(`news.json: +${added} flagged item(s) (${news.items.length} total)`);
}

// Pull a structured event (with a VERBATIM quote) from an article's text. One LLM call per candidate.
async function extractEvent(item, pageText, model) {
  const prompt = `You extract a structured "limit/pricing change" event from an AI provider's article, for a site that tracks subscription usage limits and consumer plan pricing over time.\n\nProvider: ${item.provider}${item.product ? " / " + item.product : ""}\nArticle title: ${item.title}\nArticle text (may be truncated):\n"""${pageText.slice(0, 7000)}"""\n\nReturn ONE JSON object, no prose:\n{\n  "is_limit_change": <true only if this announces a concrete change to a consumer subscription usage limit/quota/rate cap or plan price/credit>,\n  "certainty": "high|medium|low",\n  "quote": "<a SINGLE sentence copied EXACTLY, character-for-character, from the article text above that states the change. Do not paraphrase, fix, or shorten it. If no such sentence exists, set is_limit_change false.>",\n  "title": "<= 80 char headline. State ONLY what the article supports; never invent specific numbers (token counts, prices, percentages) that do not literally appear in the article text.",\n  "kind": "limit_boost|limit_cut|pricing_change|promo|new_plan",\n  "applies_to": ["plan names mentioned, e.g. Pro, Pro+"] ,\n  "window": "5h|3h|day|week|month|null",\n  "factor": <number like 1.5 for +50%, 2 for 2x, or null>,\n  "starts_on": "YYYY-MM-DD or null",\n  "ends_on": "YYYY-MM-DD or null",\n  "permanent": <true|false>,\n  "confidence": "official|announced"\n}\nThe quote MUST be a verbatim substring of the article text. Be conservative: low certainty if unsure.`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 700, messages: [{ role: "user", content: prompt }] }),
    });
    const body = await res.json();
    const text = body?.content?.[0]?.text ?? "{}";
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch (e) { console.log(`[auto] extract failed: ${e.message}`); return null; }
}

// AUTO-PROMOTE: for high-confidence flagged items, fetch the article, extract an event with a
// verbatim quote, and publish it ONLY if the quote string-matches the source page. This makes a
// hallucinated quote impossible to ship; the LLM's interpretation (kind/factor) is still machine
// output, so these are tagged auto:true and badged on-site for transparency + easy correction.
if (process.env.ANTHROPIC_API_KEY && relevant && relevant.length) {
  const model = process.env.ANTHROPIC_DISCOVER_MODEL || "claude-haiku-4-5-20251001";
  const autoPath = join(root, "data", "auto-events.json");
  const auto = existsSync(autoPath) ? JSON.parse(readFileSync(autoPath, "utf8")) : { schema: 1, note: "Auto-published events. Machine-extracted, but every quote is verified to appear verbatim in the cited source before publishing (see scripts/discover.mjs). Tagged auto:true and badged on-site. A human may correct or delete any entry; build.mjs merges these with the hand-curated data/events.json.", events: [] };
  const haveSrc = new Set(auto.events.map((e) => e.source));
  const haveId = new Set(auto.events.map((e) => e.id));
  let promoted = 0, checked = 0;
  for (const r of relevant) {
    const it = fresh[r.index];
    if (!it || haveSrc.has(it.link)) continue;
    checked++;
    let pageText = "";
    try { const res = await fetch(it.link, { headers: { "user-agent": "Mozilla/5.0 LimitWatch-discover" } }); if (res.ok) pageText = stripHtml(await res.text()); } catch {}
    if (pageText.length < 200) { console.log(`[auto] no article text, skip ${it.link}`); continue; }
    const ev = await extractEvent(it, pageText, model);
    if (!ev || !ev.is_limit_change || ev.certainty !== "high" || !ev.quote) continue;
    if (!quoteInSource(ev.quote, pageText)) { console.log(`[auto] quote NOT verbatim in source, skip ${it.link}`); continue; }
    const yr = (ev.starts_on || it.date || nowIso).slice(0, 4);
    const slug = (ev.title || it.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
    const id = `auto-${it.provider.toLowerCase()}-${slug}-${yr}`;
    if (haveId.has(id)) continue;
    auto.events.unshift({
      id, provider: it.provider, product: it.product ?? null,
      applies_to: Array.isArray(ev.applies_to) ? ev.applies_to : [],
      title: (ev.title || it.title).slice(0, 80), kind: ev.kind || r.kind,
      window: ev.window && ev.window !== "null" ? ev.window : null,
      factor: typeof ev.factor === "number" ? ev.factor : null,
      starts_on: (ev.starts_on && /^\d{4}-\d{2}-\d{2}$/.test(ev.starts_on)) ? ev.starts_on : (it.date ? new Date(it.date).toISOString().slice(0, 10) : nowIso.slice(0, 10)),
      ends_on: (ev.ends_on && /^\d{4}-\d{2}-\d{2}$/.test(ev.ends_on)) ? ev.ends_on : null,
      permanent: ev.permanent !== false,
      confidence: ev.confidence === "official" ? "official" : "announced",
      quote: ev.quote, source: it.link, auto: true, flagged_at: nowIso,
    });
    haveId.add(id); haveSrc.add(it.link); promoted++;
  }
  auto.events = auto.events.slice(0, 60);
  writeFileSync(autoPath, JSON.stringify(auto, null, 2));
  console.log(`auto-events: checked ${checked}, +${promoted} auto-published (quote-verified)`);
}
