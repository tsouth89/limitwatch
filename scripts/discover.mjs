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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const feedsPath = join(root, "data", "feeds.json");
const statePath = join(root, "data", "discover-state.json");
const summaryPath = join(root, "data", "_discover-summary.md");
const all = process.argv.includes("--all");

const decode = (s) => (s ?? "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
  .trim();
const tag = (block, name) => decode(block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"))?.[1] ?? "");

// Minimal RSS/Atom item extraction — no deps. Handles <item> (RSS) and <entry> (Atom).
function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const title = tag(b, "title");
    // RSS uses <link>url</link>; Atom uses <link href="url"/>.
    const link = tag(b, "link") || (b.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ?? "");
    const id = tag(b, "guid") || tag(b, "id") || link;
    const date = tag(b, "pubDate") || tag(b, "updated") || tag(b, "published") || "";
    if (title && link) items.push({ title, link, id, date });
  }
  return items;
}

// HTML source (providers without a feed, e.g. Anthropic): pull article links matching a pattern
// off a server-rendered index page, with the heading text as the title (humanized slug fallback).
const humanize = (href) => (href.split(/[?#]/)[0].split("/").filter(Boolean).pop() || href).replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
function parseHtml(html, base, pattern) {
  const re = new RegExp(`href=["'](${pattern})["']`, "gi");
  const seen = new Set(); const items = [];
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (seen.has(href)) continue; seen.add(href);
    const after = html.slice(m.index, m.index + 500);
    const h = after.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i);
    const title = (h ? decode(h[1]) : "") || humanize(href);
    const link = /^https?:/i.test(href) ? href : base.replace(/\/$/, "") + href;
    items.push({ title, link, id: link, date: "" });
  }
  return items;
}

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
