#!/usr/bin/env node
// Merge data/snapshots/*.json into site/data.json AND derive the limit changelog.
// We store only as-published facts; the changelog is DERIVED here (reproducible from raw).
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapDir = join(root, "data", "snapshots");

const REQUIRED = ["provider", "product", "plan", "confidence", "quote", "source", "as_of", "verified_on"];
const TIERS = ["official", "announced", "community", "crowdsourced"];

const files = readdirSync(snapDir).filter((f) => f.endsWith(".json")).sort();
const today = new Date().toISOString().slice(0, 10);
const dataWarnings = [];

const snapshots = files.map((f) => {
  const snap = JSON.parse(readFileSync(join(snapDir, f), "utf8"));
  if (snap.schema !== 2 && snap.schema !== 3) throw new Error(`${f}: expected schema 2 or 3`);
  if (!snap.date) throw new Error(`${f}: missing date`);
  if (!Array.isArray(snap.entries)) throw new Error(`${f}: entries not array`);
  for (const e of snap.entries) {
    for (const k of REQUIRED) if (!e[k]) throw new Error(`${f}: ${e.plan ?? "?"} missing ${k}`);
    if (!TIERS.includes(e.confidence)) throw new Error(`${f}: ${e.plan} bad confidence "${e.confidence}"`);
    if (!Array.isArray(e.limits)) throw new Error(`${f}: ${e.plan} limits not array`);
    if (e.as_of > today) dataWarnings.push(`${f}: ${e.provider} ${e.plan} as_of ${e.as_of} is after ${today}`);
    if (e.verified_on > today) dataWarnings.push(`${f}: ${e.provider} ${e.plan} verified_on ${e.verified_on} is after ${today}`);
    // measured.as_of is a billing-period END label; an open cycle can legitimately end after today, so it is not flagged.
    if (e.effective_on && e.effective_on < e.as_of) dataWarnings.push(`${f}: ${e.provider} ${e.plan} effective_on ${e.effective_on} is before as_of ${e.as_of}`);
  }
  return snap;
});

// Flatten to comparable rows keyed by identity (the thing whose drift we track).
const limitKey = (e, l) =>
  `${e.provider}|${e.product}|${e.plan}|${e.surface ?? ""}|${l.unit}|${l.window ?? ""}|${l.model ?? ""}`;
const priceKey = (e) => `${e.provider}|${e.product}|${e.plan}`;

function flatten(snap) {
  const limits = new Map();
  const prices = new Map();
  for (const e of snap.entries) {
    prices.set(priceKey(e), { price: e.price_usd, confidence: e.confidence, source: e.source });
    for (const l of e.limits) {
      // limit-level confidence/source override the entry default when present (schema 3).
      limits.set(limitKey(e, l), { value: l.value, unit: l.unit, window: l.window, confidence: l.confidence ?? e.confidence, source: l.source ?? e.source });
    }
  }
  return { limits, prices };
}

// A snapshot is authoritative for a set of providers: an explicit `covers` list (used by partial
// historical backfills) or, by default, every provider it contains. Keys are `provider|...`.
const coverageOf = (snap) => new Set(snap.covers ?? snap.entries.map((e) => e.provider));
const providerOf = (key) => key.split("|")[0];

// Derive the changelog PER PROVIDER: for each provider, diff consecutive snapshots that COVER it
// (skipping snapshots that don't record it). This lets partial historical snapshots interleave by
// date — e.g. a Cursor-only Feb snapshot between two Google snapshots — and still attribute every
// change to the correct pair of dates, without ever fabricating drift for an un-recorded provider.
const flatCache = new Map();
const flatOf = (snap) => { if (!flatCache.has(snap)) flatCache.set(snap, flatten(snap)); return flatCache.get(snap); };
const allProviders = new Set();
for (const s of snapshots) for (const p of coverageOf(s)) allProviders.add(p);

const changes = [];
for (const provider of allProviders) {
  const seq = snapshots.filter((s) => coverageOf(s).has(provider));
  for (let i = 1; i < seq.length; i++) {
    const prev = flatOf(seq[i - 1]);
    const cur = flatOf(seq[i]);
    const date = seq[i].date;
    const mine = (k) => providerOf(k) === provider;

    for (const [k, now] of cur.limits) {
      if (!mine(k)) continue;
      const was = prev.limits.get(k);
      if (!was) changes.push({ date, kind: "limit_added", key: k, to: now.value, unit: now.unit, source: now.source });
      else if (was.value !== now.value)
        changes.push({ date, kind: "limit_changed", key: k, from: was.value, to: now.value, unit: now.unit, source: now.source });
    }
    for (const [k] of prev.limits) if (mine(k) && !cur.limits.has(k)) changes.push({ date, kind: "limit_removed", key: k });

    for (const [k, now] of cur.prices) {
      if (!mine(k)) continue;
      const was = prev.prices.get(k);
      if (was && was.price !== now.price)
        changes.push({ date, kind: "price_changed", key: k, from: was.price, to: now.price, source: now.source });
    }
  }
}
// Collapse a same-date remove+add of the SAME limit slot that only swapped the model (e.g. a plan's
// 160 msgs/3h budget moving from GPT-5.3 to GPT-5.5) into one "model_changed" entry, so a model
// rename doesn't read as a removal plus an unrelated addition.
const baseKey = (k) => k.split("|").slice(0, 6).join("|"); // identity without the model segment (idx 6)
const modelOf = (k) => k.split("|")[6] ?? "";
const used = new Set();
const collapsed = [];
for (let i = 0; i < changes.length; i++) {
  if (used.has(i)) continue;
  const c = changes[i];
  if (c.kind === "limit_added") {
    const j = changes.findIndex((d, idx) =>
      !used.has(idx) && d.kind === "limit_removed" && d.date === c.date &&
      baseKey(d.key) === baseKey(c.key) && modelOf(d.key) !== modelOf(c.key));
    if (j >= 0) {
      used.add(i); used.add(j);
      collapsed.push({ date: c.date, kind: "model_changed", key: c.key, from: modelOf(changes[j].key), to: modelOf(c.key), value: c.to, unit: c.unit, source: c.source });
      continue;
    }
  }
  collapsed.push(c);
}
collapsed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

// Curated REAL effective dates. A snapshot diff only knows the date a change was first OBSERVED
// (often a backfill date, so many cluster on one day), not when it actually happened. Optional
// data/change-dates.json supplies the true date for changes we can source; the original observed
// date is kept as `observed_on` for transparency. Unmatched changes are unaffected.
let changeDateRules = [];
try {
  const cd = JSON.parse(readFileSync(join(root, "data", "change-dates.json"), "utf8"));
  if (!Array.isArray(cd.rules)) throw new Error("change-dates.json: rules not array");
  changeDateRules = cd.rules;
} catch (err) { if (err.code !== "ENOENT") throw err; }
const keyParts = (k) => { const p = (k ?? "").split("|"); return { provider: p[0], product: p[1], plan: p[2], surface: p[3], unit: p[4], window: p[5], model: p[6] }; };
const ruleMatches = (c, r) => {
  const p = keyParts(c.key);
  const eq = (val, want) => want == null || String(val) === String(want);
  return eq(c.kind, r.kind) && eq(p.provider, r.provider) && eq(p.plan, r.plan)
    && eq(p.model, r.model) && eq(c.from, r.from) && eq(c.to, r.to);
};
for (const c of collapsed) {
  const r = changeDateRules.find((rule) => ruleMatches(c, rule));
  if (!r || !r.date) continue;  // unmatched, or a scaffold rule whose date isn't filled in yet
  if (r.date > today) dataWarnings.push(`change-dates.json: effective date ${r.date} for ${c.kind} ${c.key} is after ${today}`);
  if (r.date !== c.date) c.observed_on = c.date;  // keep the diff-detected date for the tooltip
  c.date = r.date;
}
collapsed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

// Time-bounded events (promos / temporary boosts). Validated and passed through; the site computes
// active/upcoming/ended from `today` so they expire on their own. Optional file.
const EVENT_REQUIRED = ["id", "provider", "title", "kind", "starts_on", "confidence", "quote", "source"];
let events = [];
try {
  const ev = JSON.parse(readFileSync(join(root, "data", "events.json"), "utf8"));
  if (!Array.isArray(ev.events)) throw new Error("events.json: events not array");
  for (const e of ev.events) {
    for (const k of EVENT_REQUIRED) if (e[k] == null) throw new Error(`events.json: ${e.id ?? "?"} missing ${k}`);
    if (!TIERS.includes(e.confidence)) throw new Error(`events.json: ${e.id} bad confidence "${e.confidence}"`);
    if (e.ends_on && e.ends_on < e.starts_on) throw new Error(`events.json: ${e.id} ends_on before starts_on`);
    if (e.starts_on > today) dataWarnings.push(`events.json: ${e.id} starts_on ${e.starts_on} is after ${today}`);
  }
  events = ev.events;
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

// Self-reported / crowdsourced usage observations (chat-subscription caps that no API exposes).
// Light validation only — these are honest field reports, kept verbatim. Optional file.
const REPORT_REQUIRED = ["provider", "plan", "surface", "window", "captured_at", "metric", "observed"];
const REPORT_WINDOWS = ["5h", "3h", "day", "week", "month"];
const REPORT_METRICS = ["messages", "percent", "tokens"];
let usageReports = [];
try {
  const ur = JSON.parse(readFileSync(join(root, "data", "usage-reports.json"), "utf8"));
  if (!Array.isArray(ur.reports)) throw new Error("usage-reports.json: reports not array");
  for (const r of ur.reports) {
    const who = `${r.provider ?? "?"} ${r.plan ?? "?"} ${r.window ?? "?"}`;
    for (const k of REPORT_REQUIRED) if (r[k] == null) throw new Error(`usage-reports.json: ${who} missing ${k}`);
    if (!REPORT_WINDOWS.includes(r.window)) throw new Error(`usage-reports.json: ${who} bad window "${r.window}" (expected ${REPORT_WINDOWS.join("|")})`);
    if (!REPORT_METRICS.includes(r.metric)) throw new Error(`usage-reports.json: ${who} bad metric "${r.metric}" (expected ${REPORT_METRICS.join("|")})`);
    if (typeof r.observed !== "number" || Number.isNaN(r.observed)) throw new Error(`usage-reports.json: ${who} observed must be a number`);
    // percent rows drive the "→ $/window" extrapolation (api_equiv_usd / (observed/100)); 0 or out-of-range breaks it.
    if (r.metric === "percent" && (r.observed <= 0 || r.observed > 100)) throw new Error(`usage-reports.json: ${who} percent observed ${r.observed} out of range (0,100]`);
    if (r.api_equiv_usd != null && (typeof r.api_equiv_usd !== "number" || r.api_equiv_usd < 0)) throw new Error(`usage-reports.json: ${who} api_equiv_usd must be a non-negative number`);
    if (r.value_basis != null && !["floor", "receipt"].includes(r.value_basis)) throw new Error(`usage-reports.json: ${who} bad value_basis "${r.value_basis}" (expected floor|receipt)`);
    if (r.account != null && typeof r.account !== "string") throw new Error(`usage-reports.json: ${who} account must be a string`);
    if (r.captured_at.slice(0, 10) > today) dataWarnings.push(`usage-reports.json: ${who} captured_at ${r.captured_at} is after ${today}`);
  }
  usageReports = ur.reports;
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

const out = {
  generated_at: new Date().toISOString(),
  snapshot_count: snapshots.length,
  date_range: snapshots.length ? [snapshots[0].date, snapshots.at(-1).date] : [],
  data_warnings: dataWarnings,
  events,
  changes: collapsed.reverse(), // newest first
  usage_reports: usageReports,
  snapshots,
};

writeFileSync(join(root, "site", "data.json"), JSON.stringify(out, null, 2));
console.log(`built site/data.json — ${snapshots.length} snapshot(s), ${events.length} event(s), ${collapsed.length} change(s), ${usageReports.length} usage report(s), ${dataWarnings.length} warning(s)`);
