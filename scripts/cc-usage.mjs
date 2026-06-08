#!/usr/bin/env node
// Aggregate REAL Claude Code token burn from local session transcripts (~/.claude/projects/**/*.jsonl).
//
// WHY: Anthropic's subscription caps (5h session, weekly) are not exposed by any API. But Claude
// Code writes every assistant turn to disk with exact token usage. Summing those over a window gives
// the measured consumption that drove an in-app % reading. Pair (observed %, measured tokens up to
// that moment) and you can derive the implied full-window budget — the data no provider publishes.
//
// SCOPE CAVEAT: this sees Claude Code only, across ALL projects. It does NOT see claude.ai web/desktop
// chat usage, which also counts against the same weekly cap. So the measured burn is a FLOOR on what
// consumed the window, not the whole story. Report it as such.
//
// Usage:
//   node scripts/cc-usage.mjs --since 2026-06-02 [--until 2026-06-09] [--json]
//   node scripts/cc-usage.mjs --days 7
//   node scripts/cc-usage.mjs --since <iso> --report   # emit a usage-reports.json entry stub
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const has = (n) => args.includes(n);

const now = new Date();
let since = flag("--since") ? new Date(flag("--since")) : null;
const until = flag("--until") ? new Date(flag("--until")) : now;
if (!since && flag("--days")) since = new Date(now.getTime() - Number(flag("--days")) * 864e5);
if (!since) { console.error("Need --since <date> or --days <n>"); process.exit(1); }

// API list price per 1M tokens. cache_write_5m = base input * 1.25; cache_write_1h = base * 2;
// cache_read = base * 0.1. Edit when prices change. Value comparison only — NOT the cap mechanic.
const PRICES = {
  "claude-opus-4-8":   { in: 5,    out: 25,  cw5: 6.25,  cw1h: 10,   cr: 0.5 },
  "claude-opus-4-7":   { in: 5,    out: 25,  cw5: 6.25,  cw1h: 10,   cr: 0.5 },
  "claude-opus-4-6":   { in: 5,    out: 25,  cw5: 6.25,  cw1h: 10,   cr: 0.5 },
  "claude-sonnet-4-6": { in: 3,    out: 15,  cw5: 3.75,  cw1h: 6,    cr: 0.3 },
  "claude-sonnet-4-5": { in: 3,    out: 15,  cw5: 3.75,  cw1h: 6,    cr: 0.3 },
  "claude-haiku-4-5":  { in: 1,    out: 5,   cw5: 1.25,  cw1h: 2,    cr: 0.1 },
};
const priceFor = (m) => PRICES[m] || PRICES[Object.keys(PRICES).find((k) => m?.startsWith(k))] || null;

const projRoot = join(homedir(), ".claude", "projects");
const walk = (dir) => {
  let out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
};

// ACCOUNT ATTRIBUTION CAVEAT: transcripts record NO account/login identity. A weekly/5h cap is
// per-account, so if this machine ran more than one Claude login in the window, summing every
// project over-counts. The only proxy is the project (cwd): work repos run on the work login,
// personal repos on the personal login. Use --match <substr> to scope to one account's projects
// (e.g. --match personal), and --by-project to inspect the split. Imperfect but the best signal.
const match = flag("--match");     // only count sessions whose project path includes this substring
const exclude = flag("--exclude"); // drop sessions whose project path includes this substring
const seen = new Set();            // dedupe by message.id (resumed sessions replay lines)
const byModel = {};                // model -> token sums + cost
const byProject = {};              // project dir -> { turns, usd }
let firstTs = null, lastTs = null, turns = 0;

for (const file of walk(projRoot)) {
  if (statSync(file).mtimeMs < since.getTime()) continue; // cheap skip
  const project = file.slice(projRoot.length + 1).split(/[\\/]/)[0]; // top dir under projects/
  if (match && !project.includes(match)) continue;
  if (exclude && project.includes(exclude)) continue;
  let lines;
  try { lines = readFileSync(file, "utf8").split("\n"); } catch { continue; }
  for (const line of lines) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "assistant" || !o.message?.usage || !o.timestamp) continue;
    const ts = new Date(o.timestamp);
    if (ts < since || ts > until) continue;
    const id = o.message.id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const u = o.message.usage;
    const m = o.message.model || "unknown";
    const cw5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    const cw1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const b = (byModel[m] ||= { input: 0, output: 0, cw5: 0, cw1h: 0, cr: 0, turns: 0, usd: 0 });
    b.input += u.input_tokens || 0;
    b.output += u.output_tokens || 0;
    b.cw5 += cw5;
    b.cw1h += cw1h;
    b.cr += u.cache_read_input_tokens || 0;
    b.turns += 1;
    const pr = priceFor(m);
    const usd = pr ? ((u.input_tokens||0)*pr.in + (u.output_tokens||0)*pr.out + cw5*pr.cw5 + cw1h*pr.cw1h + (u.cache_read_input_tokens||0)*pr.cr) / 1e6 : 0;
    b.usd += usd;
    const pj = (byProject[project] ||= { turns: 0, usd: 0 });
    pj.turns += 1; pj.usd += usd;
    turns++;
    if (!firstTs || ts < firstTs) firstTs = ts;
    if (!lastTs || ts > lastTs) lastTs = ts;
  }
}

const sum = (k) => Object.values(byModel).reduce((a, b) => a + b[k], 0);
const totals = {
  window: { since: since.toISOString(), until: until.toISOString() },
  span_observed: { first: firstTs?.toISOString() ?? null, last: lastTs?.toISOString() ?? null },
  turns,
  tokens: { input: sum("input"), output: sum("output"), cache_write_5m: sum("cw5"), cache_write_1h: sum("cw1h"), cache_read: sum("cr") },
  api_equiv_usd: +sum("usd").toFixed(2),
  by_model: byModel,
};

if (has("--json")) { console.log(JSON.stringify(totals, null, 2)); process.exit(0); }

const fmt = (n) => n.toLocaleString("en-US");
console.log(`Claude Code burn  ${since.toISOString().slice(0,16)} → ${until.toISOString().slice(0,16)}`);
console.log(`  turns: ${fmt(turns)}   models: ${Object.keys(byModel).join(", ")}`);
console.log(`  input ${fmt(totals.tokens.input)}  output ${fmt(totals.tokens.output)}`);
console.log(`  cache-write 5m ${fmt(totals.tokens.cache_write_5m)}  1h ${fmt(totals.tokens.cache_write_1h)}  cache-read ${fmt(totals.tokens.cache_read)}`);
console.log(`  API-equivalent value: $${totals.api_equiv_usd}`);
for (const [m, b] of Object.entries(byModel))
  console.log(`    ${m}: ${b.turns} turns, $${b.usd.toFixed(2)}`);
if (match) console.log(`  [scoped to projects matching "${match}"]`);
if (has("--by-project")) {
  console.log("  by project (account proxy — cwd):");
  for (const [p, b] of Object.entries(byProject).sort((a, b) => b[1].usd - a[1].usd))
    console.log(`    ${p}: ${b.turns} turns, $${b.usd.toFixed(2)}`);
}

if (has("--report")) {
  const t = totals.tokens;
  const entry = {
    provider: "Anthropic", plan: "Pro", surface: "Claude Code", window: "week",
    captured_at: now.toISOString(),
    metric: "percent", observed: null, limit_hit: false,
    note: `MEASURED FLOOR from local Claude Code transcripts only (excludes claude.ai chat, which also counts). Window ${since.toISOString()}..${until.toISOString()}. ${turns} assistant turns. Fill in 'observed' with the in-app weekly % at captured_at.`,
    usage_tokens: { input: t.input, output: t.output, cache_write: t.cache_write_5m + t.cache_write_1h, cache_read: t.cache_read },
    api_equiv_usd: totals.api_equiv_usd,
    api_equiv_basis: "Anthropic API list price per model (see scripts/cc-usage.mjs PRICES). Value comparison, not the cap mechanic.",
    reporter: "self",
    evidence: "Aggregated ~/.claude/projects/**/*.jsonl assistant-turn usage, deduped by message.id.",
  };
  console.log("\n--- usage-reports.json entry stub ---");
  console.log(JSON.stringify(entry, null, 2));
}
