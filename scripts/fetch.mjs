#!/usr/bin/env node
// Watch official source pages for changes. We hash each page's visible text and compare
// to the last seen hash. Pages that CHANGED get flagged for human re-verification.
// This NEVER edits snapshots — it only tells you where to look. Honest by design.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchRendered } from "./browser-fetch.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = JSON.parse(readFileSync(join(root, "data", "sources.json"), "utf8")).sources;
const statePath = join(root, "data", "source-state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

// --http-only: skip browser (Cloudflare) sources — they need a headed desktop, not CI.
// --ci: write data/_watch-summary.md when something changed, for the workflow to file an issue.
const HTTP_ONLY = process.argv.includes("--http-only");
const CI = process.argv.includes("--ci");

// Collapse HTML to comparable visible text so we don't churn on tokens/markup noise.
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// Plain HTTP fetch → visible text, or null on non-OK.
async function httpText(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "LimitWatch/0.1 (+https://limitwatch.dev)" },
    redirect: "follow",
  });
  if (!res.ok) return { text: null, note: `HTTP ${res.status}` };
  return { text: visibleText(await res.text()), note: "" };
}

const results = [];
for (const src of sources) {
  try {
    let text, note;
    if (src.method === "browser" && HTTP_ONLY) {
      results.push({ src, status: "skipped (needs local headed browser)" });
      continue;
    }
    if (src.method === "browser") {
      // Cloudflare-protected: headed patchright is what actually passes (headless = 403).
      const r = await fetchRendered(src.url, { headless: false });
      if (!r.ok) { results.push({ src, status: `BLOCKED (${r.note || r.status})` }); continue; }
      text = visibleText(r.text);
    } else {
      ({ text, note } = await httpText(src.url));
      if (text == null) { results.push({ src, status: note }); continue; }
    }
    const h = hash(text);
    const prev = state[src.id];
    const changed = prev && prev.hash !== h;
    state[src.id] = { hash: h, checked: new Date().toISOString().slice(0, 10), len: text.length, method: src.method };
    results.push({ src, status: prev ? (changed ? "CHANGED" : "same") : "new", changed });
  } catch (e) {
    results.push({ src, status: `ERROR ${e.message}` });
  }
}

writeFileSync(statePath, JSON.stringify(state, null, 2));

console.log("\nSource watch results:");
for (const r of results) {
  const tag = r.status === "CHANGED" ? "  >> CHANGED <<" : r.status === "new" ? "  (baseline set)" : "";
  console.log(`  [${r.status.padEnd(8)}] ${r.src.provider} — ${r.src.label}${tag}`);
}
const changed = results.filter((r) => r.changed);
if (changed.length) {
  console.log(`\n${changed.length} page(s) changed. Re-verify and, if a number moved, add a new dated snapshot:`);
  for (const r of changed) console.log(`  - ${r.src.url}`);
} else {
  console.log("\nNo monitored official page changed since last check.");
}

if (CI) {
  const skipped = results.filter((r) => String(r.status).startsWith("skipped"));
  if (changed.length) {
    const today = new Date().toISOString().slice(0, 10);
    const body =
      `## Official source page(s) changed — re-verify\n\n` +
      `The weekly watch (${today}) detected text changes on monitored official pages. ` +
      `Check each, and if a limit/price actually moved, add a new dated snapshot.\n\n` +
      changed.map((r) => `- [ ] [${r.src.provider} — ${r.src.label}](${r.src.url})`).join("\n") +
      (skipped.length
        ? `\n\n### Also check manually (Cloudflare-protected, not run in CI)\n` +
          skipped.map((r) => `- [ ] [${r.src.provider} — ${r.src.label}](${r.src.url}) — run \`npm run watch\` locally`).join("\n")
        : "") +
      `\n`;
    writeFileSync(join(root, "data", "_watch-summary.md"), body);
    console.log("\n[ci] wrote data/_watch-summary.md (changes found)");
  } else {
    console.log("\n[ci] no changes; no issue needed.");
  }
}
