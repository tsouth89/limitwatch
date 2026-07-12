// Shared core for reading real Claude Code token burn out of local session transcripts
// (~/.claude/projects/**/*.jsonl). Single source of truth for pricing and aggregation so the
// CLI (cc-usage.mjs) and the scheduled logger (burn-log.mjs) can't drift apart.
//
// ATTRIBUTION CAVEAT: transcripts record NO account identity, and Claude Code's login is global per
// instance (not per project). A weekly/5h cap is per-account, so summing every project over-counts
// when more than one login ran on the machine. The only proxy is the project (cwd): scope with
// `match` / `exclude` on the project-dir name. Treat any scoped figure as a soft bound.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// API list price per 1M tokens. cache_write_5m = base*1.25; cache_write_1h = base*2; cache_read = base*0.1.
// SINGLE source of truth — edit here when Anthropic prices change; keep PRICES_AS_OF current.
export const PRICES_AS_OF = "2026-06-08";
export const PRICES = {
  "claude-opus-4-8":   { in: 5,    out: 25,  cw5: 6.25,  cw1h: 10,   cr: 0.5 },
  "claude-opus-4-7":   { in: 5,    out: 25,  cw5: 6.25,  cw1h: 10,   cr: 0.5 },
  "claude-opus-4-6":   { in: 5,    out: 25,  cw5: 6.25,  cw1h: 10,   cr: 0.5 },
  "claude-sonnet-4-6": { in: 3,    out: 15,  cw5: 3.75,  cw1h: 6,    cr: 0.3 },
  "claude-sonnet-4-5": { in: 3,    out: 15,  cw5: 3.75,  cw1h: 6,    cr: 0.3 },
  "claude-haiku-4-5":  { in: 1,    out: 5,   cw5: 1.25,  cw1h: 2,    cr: 0.1 },
};
export const priceFor = (m) =>
  PRICES[m] || PRICES[Object.keys(PRICES).find((k) => m?.startsWith(k))] || null;

// API-equivalent dollar cost of one assistant turn's token usage, at PRICES list rates. The single
// definition of the burn math (was inline in aggregate); an unknown/unpriced model returns 0 so it
// never silently inflates a total. `usage` is the raw transcript `message.usage` object.
export function costUsd(usage, model) {
  const pr = priceFor(model);
  if (!pr || !usage) return 0;
  const cw5 = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const cw1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return ((usage.input_tokens || 0) * pr.in + (usage.output_tokens || 0) * pr.out
    + cw5 * pr.cw5 + cw1h * pr.cw1h + (usage.cache_read_input_tokens || 0) * pr.cr) / 1e6;
}

export const projRoot = join(homedir(), ".claude", "projects");

export function walk(dir) {
  // Fresh CI/dev machines have no Claude transcripts — treat missing root as empty, not fatal.
  if (!existsSync(dir)) return [];
  let out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

// Aggregate assistant-turn token usage across all transcripts within [since, until].
// opts: { since: Date, until?: Date, match?: string, exclude?: string }
// Returns { turns, tokens, api_equiv_usd, by_model, by_project, span:{first,last} }.
export function aggregate({ since, until = new Date(), match, exclude }) {
  const seen = new Set();         // dedupe by message.id (resumed sessions replay lines)
  const byModel = {};
  const byProject = {};
  let firstTs = null, lastTs = null, turns = 0;

  for (const file of walk(projRoot)) {
    if (statSync(file).mtimeMs < since.getTime()) continue; // cheap skip
    const project = file.slice(projRoot.length + 1).split(/[\\/]/)[0];
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
      b.cw5 += cw5; b.cw1h += cw1h;
      b.cr += u.cache_read_input_tokens || 0;
      b.turns += 1;
      const usd = costUsd(u, m);
      b.usd += usd;
      const pj = (byProject[project] ||= { turns: 0, usd: 0 });
      pj.turns += 1; pj.usd += usd;
      turns++;
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }
  }

  const sum = (k) => Object.values(byModel).reduce((a, b) => a + b[k], 0);
  return {
    turns,
    tokens: { input: sum("input"), output: sum("output"), cache_write_5m: sum("cw5"), cache_write_1h: sum("cw1h"), cache_read: sum("cr") },
    api_equiv_usd: +sum("usd").toFixed(2),
    by_model: byModel,
    by_project: byProject,
    span: { first: firstTs?.toISOString() ?? null, last: lastTs?.toISOString() ?? null },
  };
}

// Most-recent past weekly reset instant, given a weekday (0=Sun..6=Sat), local hour, and the
// account's UTC offset in minutes (e.g. EDT = -240). Returns a Date.
export function lastWeeklyReset({ weekday, hour, tz_offset_min = 0 }, now = new Date()) {
  // Work in the account's local clock by shifting epoch by the offset.
  const localNow = new Date(now.getTime() + tz_offset_min * 60000);
  const d = new Date(localNow);
  d.setUTCHours(hour, 0, 0, 0);
  while (d.getUTCDay() !== weekday || d > localNow) d.setUTCDate(d.getUTCDate() - 1);
  return new Date(d.getTime() - tz_offset_min * 60000); // back to real UTC instant
}
