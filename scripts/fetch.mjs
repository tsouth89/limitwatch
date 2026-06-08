#!/usr/bin/env node
// Watch official source pages for changes. We hash each page's visible text and compare
// to the last seen hash. Pages that CHANGED get flagged for human re-verification.
// This NEVER edits snapshots — it only tells you where to look. Honest by design.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = JSON.parse(readFileSync(join(root, "data", "sources.json"), "utf8")).sources;
const statePath = join(root, "data", "source-state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

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

const results = [];
for (const src of sources) {
  try {
    const res = await fetch(src.url, {
      headers: { "user-agent": "LimitWatch/0.1 (+https://limitwatch.southforgeai.com)" },
      redirect: "follow",
    });
    if (!res.ok) { results.push({ src, status: `HTTP ${res.status}` }); continue; }
    const text = visibleText(await res.text());
    const h = hash(text);
    const prev = state[src.id];
    const changed = prev && prev.hash !== h;
    state[src.id] = { hash: h, checked: new Date().toISOString().slice(0, 10), len: text.length };
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
