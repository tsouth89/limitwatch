#!/usr/bin/env node
// One-shot maintainer check-in: glance at in-app %, pair with local burn, emit usage-report stubs.
// Wraps Claude (cc transcripts), Codex (local rollouts), and optional Cursor CSV — no new tracker.
//
// Interactive:
//   npm run checkin
// Flags (skip prompts for that provider):
//   --claude-account personal --claude-5h 47 --claude-week 83
//   --codex-5h-left 58 --codex-week-left 93 [--codex-plan Plus]
//   --cursor path/to.csv --cursor-period "May 10 - Jun 08, 2026" --cursor-api-pool 20
//   --write          append Claude/Codex stubs to data/usage-reports.json
//   --out <file>     also write all stubs as JSON to a file
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { aggregate, lastWeeklyReset } from "./lib/usage-core.mjs";
import { findAccount } from "./lib/accounts.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_PATH = join(root, "data", "usage-reports.json");
const ACCOUNTS_PATH = join(root, "data", "accounts.json");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const key = a.slice(2);
    if (["write", "help"].includes(key)) { args[key] = true; continue; }
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

const numOrNull = (v) => {
  if (v == null || v === "" || v === true) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function ask(rl, prompt, fallback = "") {
  const hint = fallback !== "" ? ` [${fallback}]` : "";
  const ans = (await rl.question(`${prompt}${hint}: `)).trim();
  return ans === "" ? fallback : ans;
}

async function askNum(rl, prompt, fallback = "") {
  const raw = await ask(rl, prompt, fallback === "" ? "" : String(fallback));
  if (raw === "" || raw.toLowerCase() === "skip") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${prompt} must be 0–100 (or blank/skip)`);
  return n;
}

function claudeStub({ account, plan, window, since, until, observed, agg, match, exclude }) {
  const t = agg.tokens;
  const implied = observed != null && observed > 0
    ? Math.round(agg.api_equiv_usd / (observed / 100))
    : null;
  return {
    provider: "Anthropic",
    plan,
    surface: "Claude Code",
    window,
    captured_at: until.toISOString(),
    metric: "percent",
    observed,
    account: account ?? undefined,
    limit_hit: observed === 100,
    value_basis: "floor",
    note: `MEASURED FLOOR from local Claude Code transcripts${match ? ` scoped to projects matching '${match}'` : exclude ? ` excluding '${exclude}'` : ""} (excludes claude.ai chat; account attribution is a weak project proxy). Window ${since.toISOString()}..${until.toISOString()}. ${agg.turns} assistant turns.${implied != null ? ` Implies ~$${implied} API-equiv / full ${window}.` : " Fill in observed with the in-app %."}`,
    usage_tokens: {
      input: t.input,
      output: t.output,
      cache_write: t.cache_write_5m + t.cache_write_1h,
      cache_read: t.cache_read,
    },
    api_equiv_usd: agg.api_equiv_usd,
    api_equiv_basis: "Anthropic API list price per model (see scripts/lib/usage-core.mjs PRICES). Value comparison, not the cap mechanic.",
    reporter: "self",
    evidence: `npm run checkin / scripts/cc-usage.mjs, deduped by message.id${match ? `, --match ${match}` : exclude ? `, --exclude ${exclude}` : ""}.`,
  };
}

function collectClaude({ accountLabel, fiveH, week, since5hHours = 5 }) {
  const cfg = JSON.parse(readFileSync(ACCOUNTS_PATH, "utf8"));
  const label = accountLabel || cfg.accounts?.[0]?.label;
  const acc = findAccount(cfg, label);
  if (!acc) throw new Error(`Claude account "${label}" not in data/accounts.json`);
  const now = new Date();
  const match = acc.match;
  const exclude = acc.exclude;
  const plan = acc.plan;
  const weekSince = acc.weekly_reset ? lastWeeklyReset(acc.weekly_reset, now) : new Date(now.getTime() - 7 * 864e5);
  const fiveSince = new Date(now.getTime() - since5hHours * 3600e3);
  const stubs = [];
  const summary = [];

  const weekAgg = aggregate({ since: weekSince, until: now, match, exclude });
  {
    const stub = claudeStub({
      account: label, plan, window: "week", since: weekSince, until: now,
      observed: week, agg: weekAgg, match, exclude,
    });
    stubs.push(stub);
    const implied = week != null && week > 0 ? Math.round(weekAgg.api_equiv_usd / (week / 100)) : null;
    summary.push(`Claude ${plan} (${label}) week: ${week ?? "?"}% · burn $${weekAgg.api_equiv_usd}${implied != null ? ` → ~$${implied}/week` : ""}`);
  }
  const fiveAgg = aggregate({ since: fiveSince, until: now, match, exclude });
  {
    const stub = claudeStub({
      account: label, plan, window: "5h", since: fiveSince, until: now,
      observed: fiveH, agg: fiveAgg, match, exclude,
    });
    stubs.push(stub);
    const implied = fiveH != null && fiveH > 0 ? Math.round(fiveAgg.api_equiv_usd / (fiveH / 100)) : null;
    summary.push(`Claude ${plan} (${label}) 5h: ${fiveH ?? "?"}% · burn $${fiveAgg.api_equiv_usd}${implied != null ? ` → ~$${implied}/5h` : ""}`);
  }
  return { stubs, summary };
}

async function collectCodex({ fiveLeft, weekLeft, plan, fiveResets, weekResets }) {
  const mod = await import(pathToFileURL(join(root, "scripts", "codex-usage.mjs")).href);
  const SESSIONS_DIR = "C:\\Users\\tsout\\.codex\\sessions";
  const { readdirSync, readFileSync: rf } = await import("node:fs");
  const { join: j } = await import("node:path");

  function rolloutFiles(dir) {
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = j(dir, entry.name);
      if (entry.isDirectory()) files.push(...rolloutFiles(path));
      else if (/^rollout-.*\.jsonl$/.test(entry.name)) files.push(path);
    }
    return files;
  }

  let sessions = [];
  try {
    sessions = rolloutFiles(SESSIONS_DIR)
      .map((file) => mod.parseSessionLines(rf(file, "utf8"), file))
      .filter(Boolean);
  } catch (err) {
    if (err.code === "ENOENT") return { stubs: [], summary: ["Codex: no local sessions dir"] };
    throw err;
  }
  if (!sessions.length) return { stubs: [], summary: ["Codex: no matching project sessions"] };

  const primaryUsed = fiveLeft != null ? 100 - fiveLeft : null;
  const secondaryUsed = weekLeft != null ? 100 - weekLeft : null;
  let summary;
  try {
    summary = mod.summarizeSessions(sessions);
    if (primaryUsed != null && secondaryUsed != null) {
      summary = mod.applyMeterOverride(summary, {
        primaryUsed,
        secondaryUsed,
        primaryResetDisplay: fiveResets,
        secondaryResetDisplay: weekResets,
      });
    }
  } catch (err) {
    return { stubs: [], summary: [`Codex: ${err.message}`] };
  }

  const stubs = [];
  const lines = [];
  const planName = plan || "Plus";
  const mk = (window, used, activity) => {
    const tokens = activity?.cumulative_tokens;
    const stub = {
      provider: "OpenAI",
      plan: planName,
      surface: "Codex",
      window,
      captured_at: summary.checkpoint_captured_at ?? new Date().toISOString(),
      metric: "percent",
      observed: used,
      limit_hit: used === 100,
      note: `Codex local activity check-in. Provider UI % is authoritative; local token totals are an activity/value proxy, not the subscription cap. Meter: ${summary.meter_source}.`,
      usage_tokens: tokens ? {
        input: tokens.input_tokens,
        output: tokens.output_tokens,
        cache_read: tokens.cached_input_tokens,
      } : undefined,
      api_equiv_usd: null,
      api_equiv_basis: "Not priced yet — local Codex token activity only. Pair with API list rates when publishing a dollar floor.",
      reporter: "self",
      evidence: "npm run checkin / scripts/codex-usage.mjs local rollout logs for this project.",
    };
    stubs.push(stub);
    const tok = tokens?.total_tokens;
    lines.push(`Codex ${planName} ${window}: ${used ?? "?"}% used · ${tok != null ? tok.toLocaleString() + " local tokens since reset" : "no scoped tokens"}`);
  };

  const pUsed = summary.provider_meter.primary?.used_percent;
  const sUsed = summary.provider_meter.secondary?.used_percent;
  if (pUsed != null) mk("5h", pUsed, summary.activity_since_reset.primary);
  if (sUsed != null) mk("week", sUsed, summary.activity_since_reset.secondary);
  return { stubs, summary: lines };
}

function collectCursor({ csv, period, apiPool, includedSpend, onDemandSpend }) {
  if (!csv) return { stubs: [], summary: [], measured: null };
  const script = join(root, "scripts", "cursor-usage.mjs");
  const argv = [script, resolve(csv)];
  if (period) argv.push("--period", period);
  if (apiPool != null) argv.push("--api-pool", String(apiPool));
  if (includedSpend != null) argv.push("--included-spend", String(includedSpend));
  if (onDemandSpend != null) argv.push("--on-demand-spend", String(onDemandSpend));
  const r = spawnSync(process.execPath, argv, { encoding: "utf8" });
  if (r.status !== 0) {
    return { stubs: [], summary: [`Cursor: ${(r.stderr || r.stdout || "failed").trim()}`], measured: null };
  }
  let measured;
  try { measured = JSON.parse(r.stdout); } catch {
    return { stubs: [], summary: ["Cursor: could not parse measured JSON"], measured: null };
  }
  const tokens = measured.realized_tokens_month;
  const pool = measured.api_pool_usd_stated;
  return {
    stubs: [],
    measured,
    summary: [
      `Cursor measured: ${tokens?.toLocaleString?.() ?? tokens} included tokens` +
        (pool != null ? ` · stated pool $${pool}` : "") +
        ` (${measured.period}) — paste measured block into a snapshot entry`,
    ],
  };
}

function appendReports(stubs) {
  const ready = stubs.filter((s) => s.observed != null);
  if (!ready.length) {
    console.error("Nothing to --write: need observed % on at least one stub.");
    return 0;
  }
  const data = JSON.parse(readFileSync(REPORTS_PATH, "utf8"));
  data.reports.push(...ready);
  writeFileSync(REPORTS_PATH, `${JSON.stringify(data, null, 2)}\n`);
  return ready.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: npm run checkin [-- --claude-account personal --claude-5h 47 --claude-week 83]
                [--codex-5h-left 58 --codex-week-left 93] [--cursor file.csv --cursor-api-pool 20]
                [--write] [--out stubs.json]

Pairs in-app % readings with local burn collectors. Prints stubs + a one-line summary per plan/window.`);
    return;
  }

  const hasClaudeFlags = args["claude-account"] || args["claude-5h"] != null || args["claude-week"] != null;
  const hasCodexFlags = args["codex-5h-left"] != null || args["codex-week-left"] != null || args["codex-5h"] != null || args["codex-week"] != null;
  const hasCursorFlags = args.cursor || args["cursor-csv"];
  const anyFlags = hasClaudeFlags || hasCodexFlags || hasCursorFlags;

  let claudeAccount = args["claude-account"];
  let claude5h = numOrNull(args["claude-5h"]);
  let claudeWeek = numOrNull(args["claude-week"]);
  let codex5Left = numOrNull(args["codex-5h-left"]);
  let codexWeekLeft = numOrNull(args["codex-week-left"]);
  // Also accept used-% aliases
  if (args["codex-5h"] != null) codex5Left = 100 - numOrNull(args["codex-5h"]);
  if (args["codex-week"] != null) codexWeekLeft = 100 - numOrNull(args["codex-week"]);
  let cursorCsv = args.cursor || args["cursor-csv"];
  let cursorPeriod = args["cursor-period"];
  let cursorPool = numOrNull(args["cursor-api-pool"]);
  let doClaude = hasClaudeFlags;
  let doCodex = hasCodexFlags;
  let doCursor = !!hasCursorFlags;

  if (!anyFlags) {
    const rl = createInterface({ input, output });
    try {
      const cfg = existsSync(ACCOUNTS_PATH) ? JSON.parse(readFileSync(ACCOUNTS_PATH, "utf8")) : { accounts: [] };
      const defaultAcct = cfg.accounts?.[0]?.label || "personal";
      console.log("LimitWatch check-in — enter in-app % (or blank to skip a field).\n");
      const wantClaude = (await ask(rl, "Check Claude Code? (y/n)", "y")).toLowerCase().startsWith("y");
      if (wantClaude) {
        doClaude = true;
        claudeAccount = await ask(rl, "Claude account label", defaultAcct);
        claude5h = await askNum(rl, "Claude 5h used %");
        claudeWeek = await askNum(rl, "Claude weekly used %");
      }
      const wantCodex = (await ask(rl, "Check Codex / ChatGPT? (y/n)", "y")).toLowerCase().startsWith("y");
      if (wantCodex) {
        doCodex = true;
        const fiveLeft = await askNum(rl, "Codex 5h left %");
        const weekLeft = await askNum(rl, "Codex weekly left %");
        codex5Left = fiveLeft;
        codexWeekLeft = weekLeft;
      }
      const wantCursor = (await ask(rl, "Import Cursor usage CSV? (y/n)", "n")).toLowerCase().startsWith("y");
      if (wantCursor) {
        doCursor = true;
        cursorCsv = await ask(rl, "Path to usage-events.csv");
        cursorPeriod = await ask(rl, "Billing period label", "");
        cursorPool = numOrNull(await ask(rl, "Stated API pool $", "20"));
      }
    } finally {
      rl.close();
    }
  } else {
    // Flag mode: run whichever providers were mentioned; if only --write etc., default Claude.
    if (!doClaude && !doCodex && !doCursor) doClaude = true;
  }

  const allStubs = [];
  const allSummary = [];
  let cursorMeasured = null;

  if (doClaude) {
    try {
      const r = collectClaude({ accountLabel: claudeAccount, fiveH: claude5h, week: claudeWeek });
      allStubs.push(...r.stubs);
      allSummary.push(...r.summary);
    } catch (err) {
      allSummary.push(`Claude: ${err.message}`);
    }
  }
  if (doCodex) {
    const r = await collectCodex({
      fiveLeft: codex5Left,
      weekLeft: codexWeekLeft,
      plan: args["codex-plan"],
      fiveResets: args["codex-5h-resets"],
      weekResets: args["codex-week-resets"],
    });
    allStubs.push(...r.stubs);
    allSummary.push(...r.summary);
  }
  if (doCursor) {
    const r = collectCursor({
      csv: cursorCsv,
      period: cursorPeriod,
      apiPool: cursorPool,
      includedSpend: numOrNull(args["cursor-included-spend"]),
      onDemandSpend: numOrNull(args["cursor-on-demand-spend"]),
    });
    cursorMeasured = r.measured;
    allSummary.push(...r.summary);
  }

  console.log("\n=== Summary ===");
  if (!allSummary.length) console.log("(nothing collected)");
  else for (const line of allSummary) console.log(`• ${line}`);

  if (allStubs.length) {
    console.log("\n--- usage-reports.json stubs ---");
    console.log(JSON.stringify(allStubs, null, 2));
  }
  if (cursorMeasured) {
    console.log("\n--- Cursor measured block (paste into snapshot entry) ---");
    console.log(JSON.stringify(cursorMeasured, null, 2));
  }

  if (args.out) {
    const payload = { stubs: allStubs, cursor_measured: cursorMeasured, summary: allSummary };
    writeFileSync(resolve(args.out), `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\nWrote ${args.out}`);
  }
  if (args.write) {
    const n = appendReports(allStubs);
    if (n) console.log(`\nAppended ${n} report(s) to data/usage-reports.json — review, then npm run build.`);
  } else if (allStubs.some((s) => s.observed != null)) {
    console.log("\nTip: re-run with --write to append stubs that have an observed %.");
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
