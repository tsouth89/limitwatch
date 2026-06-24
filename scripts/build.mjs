#!/usr/bin/env node
// Merge data/snapshots/*.json into site/data.json AND derive the limit changelog.
// We store only as-published facts; the changelog is DERIVED here (reproducible from raw).
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// LIMITWATCH_ROOT lets tests point the build at a fixture tree (data/ + site/) in a temp
// dir; unset in normal use, so production behavior is unchanged.
const root = process.env.LIMITWATCH_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const snapDir = join(root, "data", "snapshots");
const siteUrl = "https://limitwatch.dev";

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
    if (e.measured) {
      const m = e.measured;
      const who = `${f}: ${e.provider} ${e.plan} measured`;
      const nonNeg = (key) => {
        if (m[key] != null && (typeof m[key] !== "number" || m[key] < 0 || Number.isNaN(m[key]))) throw new Error(`${who} ${key} must be a non-negative number`);
      };
      nonNeg("realized_tokens_month");
      nonNeg("api_pool_usd_stated");
      nonNeg("api_pool_usd_observed");
      nonNeg("included_spend_usd_observed");
      nonNeg("on_demand_spend_usd_observed");
      if (m.realized_tokens_month == null) throw new Error(`${who} missing realized_tokens_month`);
      if (m.breakdown != null) {
        if (!Array.isArray(m.breakdown)) throw new Error(`${who} breakdown must be an array`);
        let sum = 0;
        for (const b of m.breakdown) {
          if (!b.item) throw new Error(`${who} breakdown item missing item`);
          if (typeof b.tokens !== "number" || b.tokens < 0 || Number.isNaN(b.tokens)) throw new Error(`${who} breakdown ${b.item} tokens must be a non-negative number`);
          if (b.pct != null && (typeof b.pct !== "number" || b.pct < 0 || b.pct > 100 || Number.isNaN(b.pct))) throw new Error(`${who} breakdown ${b.item} pct must be in [0,100]`);
          sum += b.tokens;
        }
        if (m.breakdown.length && sum !== m.realized_tokens_month) throw new Error(`${who} breakdown tokens ${sum} must sum to realized_tokens_month ${m.realized_tokens_month}`);
      }
    }
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
    if (e.consumer_impact != null && !["favorable", "unfavorable"].includes(e.consumer_impact)) throw new Error(`events.json: ${e.id} bad consumer_impact "${e.consumer_impact}" (favorable|unfavorable)`);
    if (e.ends_on && e.ends_on < e.starts_on) throw new Error(`events.json: ${e.id} ends_on before starts_on`);
    if (e.starts_on > today) dataWarnings.push(`events.json: ${e.id} starts_on ${e.starts_on} is after ${today}`);
  }
  events = ev.events;
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

// Auto-published events (scripts/discover.mjs). Same schema + validation as hand-curated events;
// every one is quote-verified against its source before landing here. Merged in, tagged auto, and
// deduped against manual events by id (a human-curated entry always wins).
try {
  const ae = JSON.parse(readFileSync(join(root, "data", "auto-events.json"), "utf8"));
  if (Array.isArray(ae.events)) {
    const manualIds = new Set(events.map((e) => e.id));
    const manualSrc = new Set(events.map((e) => e.source));
    for (const e of ae.events) {
      for (const k of EVENT_REQUIRED) if (e[k] == null) throw new Error(`auto-events.json: ${e.id ?? "?"} missing ${k}`);
      if (!TIERS.includes(e.confidence)) throw new Error(`auto-events.json: ${e.id} bad confidence "${e.confidence}"`);
      if (e.ends_on && e.ends_on < e.starts_on) throw new Error(`auto-events.json: ${e.id} ends_on before starts_on`);
      if (manualIds.has(e.id) || manualSrc.has(e.source)) continue;   // a hand-curated event supersedes
      events.push({ ...e, auto: true });
    }
  }
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
    // percent rows drive the "→ $/window" extrapolation (api_equiv_usd / (observed/100)); the
    // render skips that math when observed is 0 (index.html `!r.observed`), so 0 is a valid reading
    // (a meter that exists but is untouched, e.g. the Sonnet-only cap while running pure Opus).
    if (r.metric === "percent" && (r.observed < 0 || r.observed > 100)) throw new Error(`usage-reports.json: ${who} percent observed ${r.observed} out of range [0,100]`);
    if (r.api_equiv_usd != null && (typeof r.api_equiv_usd !== "number" || r.api_equiv_usd < 0)) throw new Error(`usage-reports.json: ${who} api_equiv_usd must be a non-negative number`);
    if (r.value_basis != null && !["floor", "receipt"].includes(r.value_basis)) throw new Error(`usage-reports.json: ${who} bad value_basis "${r.value_basis}" (expected floor|receipt)`);
    if (r.account != null && typeof r.account !== "string") throw new Error(`usage-reports.json: ${who} account must be a string`);
    if (r.captured_at.slice(0, 10) > today) dataWarnings.push(`usage-reports.json: ${who} captured_at ${r.captured_at} is after ${today}`);
  }
  // `account` (work vs personal login) is internal attribution only — never ship it to the public
  // site; on-site these are all just $20-plan cap readings. Keep it in data/usage-reports.json.
  usageReports = ur.reports.map(({ account, ...rest }) => rest);
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

// Auto-flagged news radar (scripts/discover.mjs output). Unverified machine signal, shown in its own
// section — never mixed with verified events/changelog. Optional file; newest first, capped for display.
let radar = [];
try {
  const nw = JSON.parse(readFileSync(join(root, "data", "news.json"), "utf8"));
  if (Array.isArray(nw.items)) {
    for (const i of nw.items) if (!i.title || !i.link) throw new Error("news.json: an item is missing title/link");
    // Drop radar items whose link already became a published event — once a lead is promoted it shows
    // in What's new with a verified quote, so leaving it on the radar would double-list the same item.
    const eventSrc = new Set(events.map((e) => e.source));
    radar = nw.items.filter((i) => !eventSrc.has(i.link)).slice(0, 15);
  }
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

// Reset-window reference: how each provider's caps refresh (rolling vs fixed-per-account). Sourced
// mechanic only — never an invented clock time. Optional file; validated like the rest of the data.
const RESET_REQUIRED = ["provider", "window", "type", "detail", "confidence", "source"];
const RESET_TYPES = ["rolling", "rolling-on-hit", "fixed-per-account", "fixed"];
let resets = [];
try {
  const rw = JSON.parse(readFileSync(join(root, "data", "reset-windows.json"), "utf8"));
  if (!Array.isArray(rw.windows)) throw new Error("reset-windows.json: windows not array");
  for (const w of rw.windows) {
    const who = `${w.provider ?? "?"} ${w.window ?? "?"}`;
    for (const k of RESET_REQUIRED) if (!w[k]) throw new Error(`reset-windows.json: ${who} missing ${k}`);
    if (!RESET_TYPES.includes(w.type)) throw new Error(`reset-windows.json: ${who} bad type "${w.type}" (expected ${RESET_TYPES.join("|")})`);
    if (!TIERS.includes(w.confidence)) throw new Error(`reset-windows.json: ${who} bad confidence "${w.confidence}"`);
  }
  resets = rw.windows;
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
  radar,
  resets,
  drift: [],   // per-provider generosity trend, derived below once changeText() helpers exist
  snapshots,
};

// site/data.json is written below (after out.drift is derived) so the shipped file is complete.

const escHtml = (s) => String(s ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");
const fmt = (n) => n == null ? "?" : Number(n).toLocaleString();
const winShort = (w) => w == null || w === "" ? "" : ({ week: "wk", month: "mo" }[w] ?? w);
const unitLabel = (l) =>
  l.unit === "multiplier" ? `${fmt(l.value)}x ${l.baseline ?? "Pro"}` :
  l.unit === "usd_credit" ? `$${fmt(l.value)} usage` :
  `${fmt(l.value)} ${l.unit}`;
const niceLimit = (value, unit, window) => {
  if (unit === "multiplier") return `${fmt(value)}x usage`;
  if (unit === "usd_credit") return `$${fmt(value)} credit${window ? ` / ${winShort(window)}` : ""}`;
  const w = window ? ` / ${winShort(window)}` : "";
  return value == null ? `${unit}${w}` : `${fmt(value)} ${unit}${w}`;
};
const provName = (p) => ({ GitHub: "GitHub Copilot" }[p] ?? p);
// Self-hosted (site/icons/) so the prerendered provider pages ping no third party — was google.com/s2.
const providerLogos = {
  OpenAI: "/icons/openai.png",
  Anthropic: "/icons/anthropic.png",
  Google: "/icons/google.png",
  xAI: "/icons/xai.png",
  Perplexity: "/icons/perplexity.png",
  Cursor: "/icons/cursor.png",
  GitHub: "/icons/github.png",
  Replit: "/icons/replit.png",
};
const provMark = (p) => providerLogos[p]
  ? `<span class="pmark" title="${escHtml(provName(p))}"><img src="${escHtml(providerLogos[p])}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'"><span class="fallback">${escHtml((p ?? "?")[0])}</span></span>`
  : `<span class="pmark" title="${escHtml(provName(p))}"><span class="fallback" style="display:inline">${escHtml((p ?? "?")[0])}</span></span>`;
const freshestDate = () => {
  const dates = [out.date_range.at(-1)];
  for (const r of usageReports) if (r.captured_at) dates.push(r.captured_at.slice(0, 10));
  for (const e of events) if (e.starts_on) dates.push(e.starts_on);
  return dates.filter(Boolean).sort().at(-1) ?? "—";
};
const renderStats = (latest) => {
  const stat = (n, l) => `<div class="stat"><div class="n">${escHtml(n)}</div><div class="l">${escHtml(l)}</div></div>`;
  return [
    stat(new Set(latest.entries.map((e) => e.provider)).size, "providers"),
    stat(latest.entries.length, "plans"),
    stat(out.changes.length, "changes logged"),
    stat(out.snapshot_count, "snapshots"),
    stat(freshestDate(), "data through"),
  ].join("");
};
const renderLimitCell = (e) => e.limits.map((l) => {
  const win = (l.window && l.unit !== "multiplier" && l.unit !== "usd_credit") ? `/${winShort(l.window)}` : "";
  const credWin = l.unit === "usd_credit" && l.window ? ` <span class="meta">/ ${escHtml(winShort(l.window))}</span>` : "";
  const model = l.model ? ` <span class="meta">(${escHtml(l.model)})</span>` : "";
  const basis = l.basis && l.basis !== "published" ? ` <span class="meta">· ${escHtml(l.basis)}</span>` : "";
  return `<span>${escHtml(unitLabel(l))}${escHtml(win)}${credWin}${model}</span>${basis}`;
}).join("<br>");
const renderLatest = (latest, changes) => {
  const cutoff90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const recentKeys = new Set((changes ?? []).filter((c) => c.date >= cutoff90).map((c) => c.key.split("|").slice(0, 3).join("|")));
  const rows = [...latest.entries].sort((a, b) =>
    a.price_usd - b.price_usd || provName(a.provider).localeCompare(provName(b.provider)) || a.plan.localeCompare(b.plan)
  ).map((e) => {
    const surf = e.surface ? ` <span class="meta">· ${escHtml(e.surface)}</span>` : "";
    const changed = recentKeys.has(`${e.provider}|${e.product}|${e.plan}`) ? ` <span class="changed-chip">updated</span>` : "";
    return `<tr>` +
      `<td class="cardtitle">${provMark(e.provider)}<span class="pname">${escHtml(provName(e.provider))}</span> <strong>${escHtml(e.plan)}</strong>${surf}${changed}</td>` +
      `<td class="num" data-label="Price / mo">$${escHtml(e.price_usd)}</td>` +
      `<td data-label="Limits">${renderLimitCell(e)}</td>` +
      `<td data-label="Confidence"><span class="badge ${escHtml(e.confidence)}">${escHtml(e.confidence)}</span></td>` +
      `<td data-label="Source"><a href="${escHtml(e.source)}">src</a> <span class="meta">${escHtml(e.verified_on)}</span></td>` +
      `</tr>`;
  }).join("");
  return `<div class="table-scroll"><table class="ltable"><colgroup><col style="width:30%"><col style="width:9%"><col style="width:37%"><col style="width:12%"><col style="width:12%"></colgroup><thead><tr><th>Plan</th><th class="num">Price</th><th>Limits</th><th>Confidence</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
};
const changeText = (c) => {
  const [prov, , plan, , unit, window] = c.key.split("|");
  if (c.kind === "limit_changed") return `${prov} ${plan} ${niceLimit(c.from, unit, window)} -> ${niceLimit(c.to, unit, window)}`;
  if (c.kind === "model_changed") return `${prov} ${plan} ${c.from} -> ${c.to}${c.value != null ? ` (${niceLimit(c.value, unit, window)})` : ""}`;
  if (c.kind === "price_changed") return `${prov} ${plan} $${c.from} -> $${c.to} / mo`;
  if (c.kind === "limit_added") return c.to == null ? `${prov} ${plan} plan added (usage unpublished)` : `${prov} ${plan} ${niceLimit(c.to, unit, window)}`;
  return `${prov} ${plan} ${niceLimit(null, unit, window)} removed`;
};

// ── Drift leaderboard ────────────────────────────────────────────────────────────────────────
// Per-provider read on whether a consumer is getting MORE or LESS over a recent window. Scored ONLY
// from signals that carry an unambiguous direction: numeric price moves, numeric same-unit limit
// moves, and explicit boost/cut/removal/promo events. Anything ambiguous (model swaps, "?x"→"4x"
// unknowns, plan added/removed, billing-model changes) is listed as context but never scored, so the
// verdict can't be manufactured from a unit mismatch. Source-linked; this turns the time-series moat
// into a one-glance headline. Window is generous (default 120d) because snapshot cadence is sparse.
const DRIFT_WINDOW_DAYS = Number(process.env.DRIFT_WINDOW_DAYS || 120);
const driftCutoff = new Date(Date.now() - DRIFT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
const numOf = (v) => { const m = String(v ?? "").replace(/,/g, "").match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; };
const driftMap = new Map();   // provider -> { up:[], down:[], context:[] }
const driftFor = (p) => { if (!driftMap.has(p)) driftMap.set(p, { up: [], down: [], context: [] }); return driftMap.get(p); };
const driftSig = (provider, dir, text, source, date) => {
  const bucket = dir > 0 ? "up" : dir < 0 ? "down" : "context";
  driftFor(provider)[bucket].push({ text, source: source ?? null, date });
};
// Derived snapshot diffs (collapsed). out.changes is newest-first; date already reflects real effective date.
for (const c of out.changes) {
  if (c.date < driftCutoff) continue;
  const provider = c.key.split("|")[0];
  const text = changeText(c);
  if (c.kind === "price_changed") {
    const a = numOf(c.from), b = numOf(c.to);
    driftSig(provider, a != null && b != null ? Math.sign(a - b) : 0, text, c.source, c.date);   // cheaper = up (favorable)
  } else if (c.kind === "limit_changed") {
    const a = numOf(c.from), b = numOf(c.to);
    driftSig(provider, a != null && b != null ? Math.sign(b - a) : 0, text, c.source, c.date);   // bigger limit = up
  } else {
    driftSig(provider, 0, text, c.source, c.date);   // added/removed/model swap → context only
  }
}
// Events (incl auto): explicit direction by kind. pricing_change/new_plan stay context (direction not
// guaranteed numeric here, and a real price move is already captured from the snapshot diff above).
const EVENT_DIR = { limit_boost: 1, promo: 1, limit_cut: -1, removal: -1 };
for (const e of events) {
  const when = e.starts_on || "";
  if (when < driftCutoff) continue;
  let dir = EVENT_DIR[e.kind] ?? 0;
  // An AUTO-classified boost/cut with no magnitude (no factor, no window) is too weak to move the
  // verdict — its direction is a bare machine guess. Show it as context, not a scored direction. (A
  // capability bump mis-tagged "limit_boost" was reading a provider users feel got worse as "more
  // generous".) Human-curated events and removals/promos still score by kind.
  if (e.auto && (e.kind === "limit_boost" || e.kind === "limit_cut") && e.factor == null && !e.window) dir = 0;
  // Explicit human-judged direction for structural changes with no numeric from/to (e.g. a billing-
  // model overhaul that's an effective tightening without a sticker-price move). A sourced editorial
  // call, documented in the event note — overrides the kind-based default. Wins last.
  if (e.consumer_impact === "favorable") dir = 1;
  else if (e.consumer_impact === "unfavorable") dir = -1;
  const temp = e.ends_on ? " (temporary)" : "";
  driftSig(e.provider, dir, `${e.title}${temp}`, e.source, when);
}
out.drift = [...driftMap.entries()].map(([provider, b]) => {
  const score = b.up.length - b.down.length;
  const label = (!b.up.length && !b.down.length) ? "stable"
    : (b.down.length && b.up.length) ? "mixed"
    : score > 0 ? "more generous" : "less generous";
  const all = [...b.up.map((s) => ({ ...s, dir: 1 })), ...b.down.map((s) => ({ ...s, dir: -1 })), ...b.context.map((s) => ({ ...s, dir: 0 }))]
    .sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  return { provider, label, score, up: b.up.length, down: b.down.length, signals: all };
}).sort((x, y) => y.score - x.score || (y.up + y.down) - (x.up + x.down) || provName(x.provider).localeCompare(provName(y.provider)));

writeFileSync(join(root, "site", "data.json"), JSON.stringify(out, null, 2));
const renderChangelog = () => {
  if (!out.changes.length) return `<p class="empty">No changes yet, need 2+ snapshots.</p>`;
  const kindClass = { model_changed: "model", price_changed: "price", limit_changed: "limit", limit_added: "added", limit_removed: "removed" };
  const kindText = { model_changed: "model", price_changed: "price", limit_changed: "limit", limit_added: "new", limit_removed: "removed" };
  return out.changes.slice(0, 12).map((c) =>
    `<div class="clrow"><span class="num">${escHtml(c.date)}</span> <span class="hk ${kindClass[c.kind] ?? "limit"}">${escHtml(kindText[c.kind] ?? c.kind)}</span> <span class="cltxt">${escHtml(changeText(c))}</span> ${c.source ? `<a href="${escHtml(c.source)}">src</a>` : ""}</div>`
  ).join("");
};
const replaceBlock = (html, name, body) => {
  const start = `<!-- BUILD:${name}:start -->`;
  const end = `<!-- BUILD:${name}:end -->`;
  const pattern = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  if (!pattern.test(html)) throw new Error(`site/index.html missing ${name} build markers`);
  return html.replace(pattern, `${start}${body}${end}`);
};
const latest = snapshots.at(-1);

// ---- Per-provider SEO landing pages ----------------------------------------
// One static, fully pre-rendered page per provider (e.g. /claude, /chatgpt) so the actual numbers
// are indexable and long-tail searches ("claude pro limits") have a page to land on. Generated from
// the same data; the homepage footer links to each so crawlers (and the sitemap) reach them.
const PROVIDER_SLUGS = {
  OpenAI: "chatgpt", Anthropic: "claude", Google: "gemini", xAI: "grok",
  Perplexity: "perplexity", Cursor: "cursor", GitHub: "copilot", Replit: "replit",
};
const slugOf = (p) => PROVIDER_SLUGS[p] ?? p.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const providerPages = [...new Set(latest.entries.map((e) => e.provider))]
  .map((provider) => ({ provider, name: provName(provider), slug: slugOf(provider) }))
  .sort((a, b) => a.name.localeCompare(b.name));

const year = latest.date.slice(0, 4);

// Shared CSS for every prerendered landing page (per-provider + the vs-comparison pages) so they
// stay visually identical and the style lives in one place.
const LANDING_CSS = `
:root{color-scheme:light dark;--bg:#eef3f3;--paper:#fff;--ink:#11201d;--muted:#4d625d;--line:#d7e2df;--blue:#0d9488;--green:#047857;--pos-soft:#d8f1e6;--pos-line:#bce6d3}
@media(prefers-color-scheme:dark){:root{--bg:#0a1413;--paper:#111d1b;--ink:#e6efec;--muted:#9bb0ab;--line:#233532;--blue:#2dd4bf;--green:#34d399;--pos-soft:#0f3328;--pos-line:#1c4d3d}}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 system-ui,sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--blue)}.wrap{max-width:880px;margin:0 auto;padding:1.4rem 1.5rem 3rem}
nav{display:flex;align-items:center;gap:.6rem;border-bottom:1px solid var(--line);padding:.2rem 0 .9rem}
nav .brand{font-weight:800;color:var(--ink);text-decoration:none}nav .spacer{margin-left:auto}
nav a.app{font-size:13px;font-weight:700}
h1{font-size:1.85rem;letter-spacing:-.02em;margin:1.3rem 0 .3rem;display:flex;align-items:center;gap:.2rem;flex-wrap:wrap}
.lede{color:var(--muted);margin:.2rem 0 1.3rem;max-width:66ch}
table{width:100%;border-collapse:collapse;font-size:14px;margin:.4rem 0 1.4rem}
th,td{text-align:left;padding:.6rem .55rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.meta{color:var(--muted);font-size:12.5px}
.badge{display:inline-block;border-radius:999px;padding:.05rem .5rem;font-size:11px;font-weight:800;background:var(--pos-soft);color:var(--green);border:1px solid var(--pos-line)}
.pmark{display:inline-flex;width:26px;height:26px;border:1px solid var(--line);border-radius:7px;overflow:hidden;background:var(--paper);vertical-align:-7px;margin-right:.45rem;flex:none}
.pmark img{width:100%;height:100%;object-fit:contain;padding:1px}
.prov{white-space:nowrap;font-weight:650}
h2{font-size:1.2rem;margin:1.7rem 0 .5rem}
.cl{font-size:13.5px}.cl>div{padding:.45rem 0;border-bottom:1px solid var(--line)}.cl .d{color:var(--muted);font-variant-numeric:tabular-nums;margin-right:.5rem}
.vs{display:inline-block;color:var(--muted);font-weight:700;margin:0 .15rem}
footer{border-top:1px solid var(--line);margin-top:2rem;padding:1.2rem 0;color:var(--muted);font-size:13px}
footer .provs{margin:.2rem 0 .7rem;line-height:1.9}`;

// Provider logo chip used in landing-page headings and comparison rows.
const landingLogo = (provider) => providerLogos[provider]
  ? `<span class="pmark"><img src="${escHtml(providerLogos[provider])}" alt="" referrerpolicy="no-referrer"></span>` : "";

const renderProviderRow = (e) => {
  const surf = e.surface ? ` <span class="meta">· ${escHtml(e.surface)}</span>` : "";
  return `<tr>` +
    `<td><strong>${escHtml(e.plan)}</strong>${surf}</td>` +
    `<td class="num">$${escHtml(e.price_usd)}</td>` +
    `<td>${renderLimitCell(e)}</td>` +
    `<td><span class="badge">${escHtml(e.confidence)}</span></td>` +
    `<td><a href="${escHtml(e.source)}" rel="nofollow noopener">src</a> <span class="meta">${escHtml(e.verified_on)}</span></td>` +
    `</tr>`;
};
const renderProviderChanges = (changes) => {
  if (!changes.length) return `<p class="meta">No changes tracked yet — they appear here as snapshots accumulate.</p>`;
  return `<div class="cl">` + changes.slice(0, 20).map((c) =>
    `<div><span class="d">${escHtml(c.date)}</span>${escHtml(changeText(c))} ${c.source ? `<a href="${escHtml(c.source)}" rel="nofollow noopener">src</a>` : ""}</div>`
  ).join("") + `</div>`;
};
const providerPageHtml = ({ provider, name, slug }) => {
  const entries = latest.entries.filter((e) => e.provider === provider)
    .sort((a, b) => a.price_usd - b.price_usd || a.plan.localeCompare(b.plan));
  const changes = out.changes.filter((c) => c.key.split("|")[0] === provider);
  const planNames = [...new Set(entries.map((e) => e.plan))];
  const canonical = `${siteUrl}/${slug}`;
  const title = `${name} plan limits & pricing (${planNames.slice(0, 3).join(", ")}${planNames.length > 3 ? ", …" : ""}) | LimitWatch`;
  const desc = `Current ${name} plans, prices, and usage limits — ${planNames.join(", ")}. Every number is source-linked and tracked over time. Updated ${latest.date}.`;
  const logo = landingLogo(provider);
  const otherLinks = providerPages.map((p) =>
    p.slug === slug ? `<strong>${escHtml(p.name)}</strong>` : `<a href="/${p.slug}">${escHtml(p.name)}</a>`).join(" · ");
  const jsonLd = {
    "@context": "https://schema.org", "@type": "Dataset",
    name: `${name} subscription limits & pricing`, description: desc, url: canonical,
    isPartOf: { "@type": "Dataset", name: "LimitWatch", url: `${siteUrl}/` },
    creator: { "@type": "Organization", name: "SouthForge AI" },
    license: "https://opensource.org/licenses/MIT", isAccessibleForFree: true,
    dateModified: latest.date,
  };
  const breadcrumb = {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "LimitWatch", item: `${siteUrl}/` },
      { "@type": "ListItem", position: 2, name, item: canonical },
    ],
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(desc)}">
<link rel="canonical" href="${escHtml(canonical)}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:site_name" content="LimitWatch">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(desc)}">
<meta property="og:url" content="${escHtml(canonical)}">
<meta property="og:image" content="${siteUrl}/og.png">
<meta property="og:image:alt" content="LimitWatch - AI subscription limits tracker">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHtml(title)}">
<meta name="twitter:description" content="${escHtml(desc)}">
<meta name="twitter:image" content="${siteUrl}/og.png">
<meta name="twitter:image:alt" content="LimitWatch - AI subscription limits tracker">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>
<style>${LANDING_CSS}
</style>
</head>
<body>
<div class="wrap">
<nav>
<a class="brand" href="/">LimitWatch</a>
<span class="spacer"></span>
<a class="app" href="/">Compare all providers →</a>
</nav>
<h1>${logo}${escHtml(name)} plan limits &amp; pricing</h1>
<p class="lede">Current ${escHtml(name)} subscription plans, prices, and usage limits, source-linked and tracked over time. ${year} snapshot, last verified ${escHtml(latest.date)}. For the full cross-provider comparison, value-per-dollar, and measured-usage receipts, see the <a href="/">interactive LimitWatch app</a>.</p>
<table>
<thead><tr><th>Plan</th><th class="num">Price / mo</th><th>Limits</th><th>Confidence</th><th>Source</th></tr></thead>
<tbody>${entries.map(renderProviderRow).join("")}</tbody>
</table>
<h2>Recent ${escHtml(name)} changes</h2>
${renderProviderChanges(changes)}
<footer>
<div class="provs">Other providers: ${otherLinks}</div>
<a href="/">LimitWatch home</a> · <a href="https://github.com/tsouth89/limitwatch" rel="noopener">Source &amp; raw data</a> · open data, AI-built.
</footer>
</div>
</body>
</html>
`;
};

// ---- Pairwise comparison pages ("X vs Y") ----------------------------------
// The highest-intent searches are versus queries ("claude pro vs chatgpt plus limits"), which the
// single-provider pages don't target. One static page per provider pair, built from the same data:
// a combined plan table sorted by price, each side's recent changes, and cross-links. Indexable and
// in the sitemap; the homepage surfaces a curated popular subset.
const comparisons = [];
for (let i = 0; i < providerPages.length; i++)
  for (let j = i + 1; j < providerPages.length; j++) {
    const a = providerPages[i], b = providerPages[j];   // providerPages is name-sorted
    comparisons.push({ a, b, slug: `${a.slug}-vs-${b.slug}` });
  }
// Match a pair by slug regardless of which provider is named first (canonical order follows the
// provider NAME sort, so a hand-written "chatgpt-vs-gemini" should still resolve to "gemini-vs-chatgpt").
const comparisonOf = (slug) => {
  const [x, y] = slug.split("-vs-");
  return comparisons.find((c) => c.slug === slug || c.slug === `${y}-vs-${x}`);
};
// Curated, high-traffic pairs surfaced on the homepage (only those that actually exist are shown).
const POPULAR_VS = ["claude-vs-chatgpt", "claude-vs-gemini", "chatgpt-vs-gemini", "cursor-vs-copilot", "chatgpt-vs-grok", "claude-vs-grok"];
const popularComparisons = POPULAR_VS.map(comparisonOf).filter(Boolean);

const renderCompareRow = (e) => {
  const surf = e.surface ? ` <span class="meta">· ${escHtml(e.surface)}</span>` : "";
  return `<tr>` +
    `<td class="prov">${landingLogo(e.provider)}${escHtml(provName(e.provider))}</td>` +
    `<td><strong>${escHtml(e.plan)}</strong>${surf}</td>` +
    `<td class="num">$${escHtml(e.price_usd)}</td>` +
    `<td>${renderLimitCell(e)}</td>` +
    `<td><span class="badge">${escHtml(e.confidence)}</span></td>` +
    `<td><a href="${escHtml(e.source)}" rel="nofollow noopener">src</a> <span class="meta">${escHtml(e.verified_on)}</span></td>` +
    `</tr>`;
};
const comparePageHtml = ({ a, b, slug }) => {
  const entries = latest.entries.filter((e) => e.provider === a.provider || e.provider === b.provider)
    .sort((x, y) => x.price_usd - y.price_usd || provName(x.provider).localeCompare(provName(y.provider)) || x.plan.localeCompare(y.plan));
  const aChanges = out.changes.filter((c) => c.key.split("|")[0] === a.provider);
  const bChanges = out.changes.filter((c) => c.key.split("|")[0] === b.provider);
  const cheapest = entries[0];
  const canonical = `${siteUrl}/${slug}`;
  const title = `${a.name} vs ${b.name}: plan limits & pricing compared | LimitWatch`;
  const desc = `${a.name} vs ${b.name} — subscription plans, prices, and usage limits side by side. Every number is source-linked and tracked over time. Updated ${latest.date}.`;
  // Other comparisons that involve either provider on this page — internal links for crawl + readers.
  const related = comparisons.filter((c) => c.slug !== slug && (c.a.provider === a.provider || c.b.provider === a.provider || c.a.provider === b.provider || c.b.provider === b.provider))
    .map((c) => `<a href="/${c.slug}">${escHtml(c.a.name)} vs ${escHtml(c.b.name)}</a>`).join(" · ");
  const jsonLd = {
    "@context": "https://schema.org", "@type": "Dataset",
    name: `${a.name} vs ${b.name}: subscription limits & pricing`, description: desc, url: canonical,
    isPartOf: { "@type": "Dataset", name: "LimitWatch", url: `${siteUrl}/` },
    creator: { "@type": "Organization", name: "SouthForge AI" },
    license: "https://opensource.org/licenses/MIT", isAccessibleForFree: true,
    dateModified: latest.date,
  };
  const breadcrumb = {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "LimitWatch", item: `${siteUrl}/` },
      { "@type": "ListItem", position: 2, name: `${a.name} vs ${b.name}`, item: canonical },
    ],
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(desc)}">
<link rel="canonical" href="${escHtml(canonical)}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:site_name" content="LimitWatch">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(desc)}">
<meta property="og:url" content="${escHtml(canonical)}">
<meta property="og:image" content="${siteUrl}/og.png">
<meta property="og:image:alt" content="LimitWatch - AI subscription limits tracker">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHtml(title)}">
<meta name="twitter:description" content="${escHtml(desc)}">
<meta name="twitter:image" content="${siteUrl}/og.png">
<meta name="twitter:image:alt" content="LimitWatch - AI subscription limits tracker">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>
<style>${LANDING_CSS}
</style>
</head>
<body>
<div class="wrap">
<nav>
<a class="brand" href="/">LimitWatch</a>
<span class="spacer"></span>
<a class="app" href="/">Compare all providers →</a>
</nav>
<h1>${landingLogo(a.provider)}${escHtml(a.name)} <span class="vs">vs</span> ${landingLogo(b.provider)}${escHtml(b.name)}</h1>
<p class="lede">${escHtml(a.name)} and ${escHtml(b.name)} subscription plans, prices, and usage limits side by side, source-linked and tracked over time. ${year} snapshot, last verified ${escHtml(latest.date)}.${cheapest ? ` Cheapest plan across the two: <strong>${escHtml(provName(cheapest.provider))} ${escHtml(cheapest.plan)}</strong> at $${escHtml(cheapest.price_usd)}/mo.` : ""} For value-per-dollar and measured receipts, see the <a href="/">interactive LimitWatch app</a>.</p>
<table>
<thead><tr><th>Provider</th><th>Plan</th><th class="num">Price / mo</th><th>Limits</th><th>Confidence</th><th>Source</th></tr></thead>
<tbody>${entries.map(renderCompareRow).join("")}</tbody>
</table>
<h2>Recent ${escHtml(a.name)} changes</h2>
${renderProviderChanges(aChanges)}
<h2>Recent ${escHtml(b.name)} changes</h2>
${renderProviderChanges(bChanges)}
<footer>
<div class="provs">Single-provider detail: <a href="/${a.slug}">${escHtml(a.name)}</a> · <a href="/${b.slug}">${escHtml(b.name)}</a></div>
${related ? `<div class="provs">More comparisons: ${related}</div>` : ""}
<a href="/">LimitWatch home</a> · <a href="https://github.com/tsouth89/limitwatch" rel="noopener">Source &amp; raw data</a> · open data, AI-built.
</footer>
</div>
</body>
</html>
`;
};

let html = readFileSync(join(root, "site", "index.html"), "utf8");
html = replaceBlock(html, "stats", renderStats(latest));
html = replaceBlock(html, "latest", renderLatest(latest, out.changes));
html = replaceBlock(html, "changelog", renderChangelog());
html = replaceBlock(html, "providerlinks", providerPages.map((p) => `<a href="/${p.slug}">${escHtml(p.name)}</a>`).join(" · "));
html = replaceBlock(html, "comparelinks", popularComparisons.map((c) => `<a href="/${c.slug}">${escHtml(c.a.name)} vs ${escHtml(c.b.name)}</a>`).join(" · "));
const websiteLD = { "@context": "https://schema.org", "@type": "WebSite", "name": "LimitWatch", "url": `${siteUrl}/` };
const datasetLD = {
  "@context": "https://schema.org", "@type": "Dataset",
  "name": "LimitWatch: AI subscription limits over time",
  "description": "Source-linked, dated snapshots of AI subscription plans, prices, and usage limits across providers (Claude, ChatGPT, Gemini, Grok, Perplexity, Cursor, Copilot, Replit), tracking how limits drift over time.",
  "url": `${siteUrl}/`,
  "keywords": ["AI subscription limits", "Claude", "ChatGPT", "Gemini", "rate limits", "usage caps", "pricing"],
  "creator": { "@type": "Organization", "name": "SouthForge AI" },
  "license": "https://opensource.org/licenses/MIT",
  "isAccessibleForFree": true,
  "dateModified": latest.date,
};
html = replaceBlock(html, "jsonld",
  `<script type="application/ld+json">${JSON.stringify(websiteLD)}</script>` +
  `<script type="application/ld+json">${JSON.stringify(datasetLD)}</script>`);
writeFileSync(join(root, "site", "index.html"), html);

for (const page of providerPages) writeFileSync(join(root, "site", `${page.slug}.html`), providerPageHtml(page));
for (const c of comparisons) writeFileSync(join(root, "site", `${c.slug}.html`), comparePageHtml(c));

const latestMod = out.generated_at.slice(0, 10);
writeFileSync(join(root, "site", "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${siteUrl}/sitemap.xml\n`);
const sitemapUrls = [
  { loc: `${siteUrl}/`, priority: "1.0", changefreq: "daily", lastmod: latestMod },
  ...providerPages.map((p) => ({ loc: `${siteUrl}/${p.slug}`, priority: "0.8", changefreq: "weekly", lastmod: latest.date })),
  ...comparisons.map((c) => ({ loc: `${siteUrl}/${c.slug}`, priority: "0.6", changefreq: "weekly", lastmod: latest.date })),
];
writeFileSync(join(root, "site", "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  sitemapUrls.map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`).join("\n") +
  `\n</urlset>\n`);
const rssItems = out.changes.slice(0, 25).map((c) => {
  const title = changeText(c);
  const pubDate = new Date(`${c.date}T12:00:00Z`).toUTCString();
  const guid = `${c.date}-${c.kind}-${c.key}-${c.from ?? ""}-${c.to ?? ""}`;
  return `  <item>\n    <title>${escHtml(title)}</title>\n    <link>${siteUrl}/#changelog</link>\n    <guid isPermaLink="false">${escHtml(guid)}</guid>\n    <pubDate>${pubDate}</pubDate>\n    <description>${escHtml(title)}</description>\n  </item>`;
}).join("\n");
writeFileSync(join(root, "site", "changes.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n<channel>\n  <title>LimitWatch changes</title>\n  <link>${siteUrl}/</link>\n  <description>Recent AI plan limit and price changes tracked by LimitWatch.</description>\n  <lastBuildDate>${new Date(out.generated_at).toUTCString()}</lastBuildDate>\n${rssItems}\n</channel>\n</rss>\n`);

console.log(`built site/data.json + prerendered HTML/RSS/sitemap + ${providerPages.length} provider page(s) + ${comparisons.length} comparison page(s) — ${snapshots.length} snapshot(s), ${events.length} event(s), ${collapsed.length} change(s), ${usageReports.length} usage report(s), ${radar.length} radar item(s), ${dataWarnings.length} warning(s)`);
