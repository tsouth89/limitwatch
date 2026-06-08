#!/usr/bin/env node
// Scheduled per-account burn logger. Each run records, per Claude login (scoped by the project proxy
// in data/accounts.json), the measured Claude Code burn in the trailing 24h and — when the account's
// weekly reset is known — week-to-date since that reset. Appends one timestamped row to
// data/burn-log.json so that when you read an in-app % later, the matching measured floor already
// exists and you never have to reconstruct the window after the fact.
//
// FLOOR, not ceiling: Claude Code only (excludes claude.ai chat), and the account split is a weak
// project-path proxy (see usage-core.mjs). Run: `node scripts/burn-log.mjs` (idempotent-ish; safe to
// run hourly or daily — every run is its own dated point).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { aggregate, lastWeeklyReset, PRICES_AS_OF } from "./lib/usage-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfgPath = join(root, "data", "accounts.json");
const outPath = join(root, "data", "burn-log.json");
const now = new Date();

const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const slim = (a) => ({ usd: a.api_equiv_usd, turns: a.turns, tokens: a.tokens });

const accounts = cfg.accounts.map((acc) => {
  const scope = { match: acc.match, exclude: acc.exclude };
  const last24h = aggregate({ since: new Date(now.getTime() - 864e5), until: now, ...scope });
  let week = null;
  if (acc.weekly_reset) {
    const reset = lastWeeklyReset(acc.weekly_reset, now);
    const wagg = aggregate({ since: reset, until: now, ...scope });
    week = { since: reset.toISOString(), ...slim(wagg) };
  }
  return { label: acc.label, plan: acc.plan, scope, last24h: slim(last24h), week_to_date: week };
});

const row = { at: now.toISOString(), prices_as_of: PRICES_AS_OF, accounts };
const log = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : { schema: 1, note: "Per-account measured Claude Code burn points appended by scripts/burn-log.mjs. Floor only (CC transcripts, weak account proxy). Pair an in-app % with the nearest row's week_to_date.usd.", rows: [] };
log.rows.push(row);
writeFileSync(outPath, JSON.stringify(log, null, 2));

console.log(`burn-log ${now.toISOString()}  (${log.rows.length} rows)`);
for (const a of accounts) {
  const w = a.week_to_date ? `  week-to-date $${a.week_to_date.usd} since ${a.week_to_date.since.slice(0,10)}` : "  (no weekly reset configured)";
  console.log(`  ${a.label}: last24h $${a.last24h.usd}${w}`);
}
