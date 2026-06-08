#!/usr/bin/env node
// CLI over the shared usage core: aggregate REAL Claude Code token burn from local transcripts and
// pair it with an in-app subscription % to derive an implied full-window budget. See scripts/lib/
// usage-core.mjs for the aggregation + pricing (single source of truth) and the attribution caveat.
//
// Usage:
//   node scripts/cc-usage.mjs --since 2026-06-03T21:00:00Z [--until <iso>] [--json] [--report]
//   node scripts/cc-usage.mjs --days 7 [--by-project]
//   node scripts/cc-usage.mjs --since <iso> --match personal   # scope to one account (project proxy)
//   node scripts/cc-usage.mjs --since <iso> --exclude personal  # the other account
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { aggregate, lastWeeklyReset } from "./lib/usage-core.mjs";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const has = (n) => args.includes(n);

const now = new Date();
let match = flag("--match");
let exclude = flag("--exclude");
let since = flag("--since") ? new Date(flag("--since")) : null;

// --account <label>: read data/accounts.json and auto-derive scope (match/exclude) + the weekly
// since-anchor from that account's reset. One short command instead of remembering reset ISO + scope.
const acctLabel = flag("--account");
if (acctLabel) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const cfg = JSON.parse(readFileSync(join(root, "data", "accounts.json"), "utf8"));
  const acc = cfg.accounts.find((a) => a.label === acctLabel);
  if (!acc) { console.error(`--account "${acctLabel}" not in data/accounts.json (have: ${cfg.accounts.map((a) => a.label).join(", ")})`); process.exit(1); }
  match = acc.match; exclude = acc.exclude;
  if (!since && acc.weekly_reset) since = lastWeeklyReset(acc.weekly_reset, now);
  // no reset configured (e.g. work): fall through to --since/--days handling below.
}

const until = flag("--until") ? new Date(flag("--until")) : now;
if (!since && flag("--days")) since = new Date(now.getTime() - Number(flag("--days")) * 864e5);
if (!since) { console.error("Need --account <label>, --since <date>, or --days <n>"); process.exit(1); }
const agg = aggregate({ since, until, match, exclude });

if (has("--json")) {
  console.log(JSON.stringify({ window: { since: since.toISOString(), until: until.toISOString() }, ...agg }, null, 2));
  process.exit(0);
}

const fmt = (n) => n.toLocaleString("en-US");
const t = agg.tokens;
console.log(`Claude Code burn  ${since.toISOString().slice(0,16)} → ${until.toISOString().slice(0,16)}`);
console.log(`  turns: ${fmt(agg.turns)}   models: ${Object.keys(agg.by_model).join(", ")}`);
console.log(`  input ${fmt(t.input)}  output ${fmt(t.output)}`);
console.log(`  cache-write 5m ${fmt(t.cache_write_5m)}  1h ${fmt(t.cache_write_1h)}  cache-read ${fmt(t.cache_read)}`);
console.log(`  API-equivalent value: $${agg.api_equiv_usd}`);
for (const [m, b] of Object.entries(agg.by_model))
  console.log(`    ${m}: ${b.turns} turns, $${b.usd.toFixed(2)}`);
if (match) console.log(`  [scoped to projects matching "${match}"]`);
if (exclude) console.log(`  [excluding projects matching "${exclude}"]`);
if (has("--by-project")) {
  console.log("  by project (account proxy — cwd):");
  for (const [p, b] of Object.entries(agg.by_project).sort((a, b) => b[1].usd - a[1].usd))
    console.log(`    ${p}: ${b.turns} turns, $${b.usd.toFixed(2)}`);
}

if (has("--report")) {
  const entry = {
    provider: "Anthropic", plan: "Pro", surface: "Claude Code", window: "week",
    captured_at: now.toISOString(),
    metric: "percent", observed: null, limit_hit: false,
    value_basis: "floor",
    note: `MEASURED FLOOR from local Claude Code transcripts${match ? ` scoped to projects matching '${match}'` : exclude ? ` excluding '${exclude}'` : ""} (excludes claude.ai chat; account attribution is a weak project proxy). Window ${since.toISOString()}..${until.toISOString()}. ${agg.turns} assistant turns. Fill in 'observed' with the in-app % at captured_at.`,
    usage_tokens: { input: t.input, output: t.output, cache_write: t.cache_write_5m + t.cache_write_1h, cache_read: t.cache_read },
    api_equiv_usd: agg.api_equiv_usd,
    api_equiv_basis: "Anthropic API list price per model (see scripts/lib/usage-core.mjs PRICES). Value comparison, not the cap mechanic.",
    reporter: "self",
    evidence: `Aggregated ~/.claude/projects/**/*.jsonl via scripts/cc-usage.mjs, deduped by message.id${match ? `, --match ${match}` : exclude ? `, --exclude ${exclude}` : ""}.`,
  };
  console.log("\n--- usage-reports.json entry stub ---");
  console.log(JSON.stringify(entry, null, 2));
}
