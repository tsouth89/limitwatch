#!/usr/bin/env node
// Local-only Codex activity collector. The provider meter is the authoritative cap reading;
// token totals below are an activity/value proxy, never the subscription limit.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_CWD = "C:\\projects\\personal\\ai-limit-tracker";
const SESSIONS_DIR = "C:\\Users\\tsout\\.codex\\sessions";
const OUTPUT_FILE = join(fileURLToPath(new URL("../data/local/codex-usage.json", import.meta.url)));

const emptyTokens = () => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 });
const toNumber = (value) => Number.isFinite(value) ? value : 0;

function tokenTotals(value = {}) {
  const totals = emptyTokens();
  for (const key of Object.keys(totals)) totals[key] = toNumber(value[key]);
  return totals;
}

function rateWindow(value) {
  if (!value) return null;
  const resetSeconds = toNumber(value.resets_at);
  return {
    used_percent: toNumber(value.used_percent),
    left_percent: 100 - toNumber(value.used_percent),
    window_minutes: toNumber(value.window_minutes),
    resets_at: resetSeconds ? new Date(resetSeconds * 1000).toISOString() : null,
  };
}

function meter(rateLimits) {
  if (!rateLimits) return null;
  return {
    plan_type: rateLimits.plan_type ?? null,
    primary: rateWindow(rateLimits.primary),
    secondary: rateWindow(rateLimits.secondary),
  };
}

function latestAtOrBefore(events, at) {
  const limit = at ? Date.parse(at) : Infinity;
  return events.reduce((latest, event) => {
    if (Date.parse(event.timestamp) > limit) return latest;
    return !latest || event.timestamp > latest.timestamp ? event : latest;
  }, null);
}

function subtractTokens(after, before) {
  const totals = emptyTokens();
  for (const key of Object.keys(totals)) totals[key] = Math.max(0, after[key] - before[key]);
  return totals;
}

export function activitySinceReset(sessions, asOf, window) {
  const resetAt = Date.parse(window?.resets_at);
  const startAt = resetAt - window.window_minutes * 60_000;
  if (!Number.isFinite(startAt)) return null;
  const start = new Date(startAt).toISOString();
  const totals = emptyTokens();
  const coverage = { complete_sessions: 0, boundary_sessions: 0, partial_sessions: 0, excluded_sessions: 0 };

  for (const session of sessions) {
    const end = latestAtOrBefore(session.events, asOf);
    if (!end || Date.parse(end.timestamp) < startAt) {
      coverage.excluded_sessions++;
      continue;
    }
    const before = latestAtOrBefore(session.events, start);
    if (before) {
      const delta = subtractTokens(end.totals, before.totals);
      for (const key of Object.keys(totals)) totals[key] += delta[key];
      coverage.complete_sessions++;
      continue;
    }
    const sessionStartedAt = Date.parse(session.started_at);
    if (sessionStartedAt >= startAt) {
      for (const key of Object.keys(totals)) totals[key] += end.totals[key];
      coverage.complete_sessions++;
    } else if (Number.isFinite(sessionStartedAt) && startAt - sessionStartedAt <= 60_000) {
      // The session began immediately before the meter reset and has no pre-reset token event.
      // Include it, but make the boundary ambiguity visible to the report.
      for (const key of Object.keys(totals)) totals[key] += end.totals[key];
      coverage.boundary_sessions++;
    } else {
      coverage.partial_sessions++;
    }
  }
  return {
    window_started_at: start,
    window_ends_at: asOf,
    cumulative_tokens: totals,
    coverage,
    label: "Scoped local token activity since this provider-meter reset; activity/value proxy, not the subscription cap. Boundary sessions began within one minute before reset and may include a small pre-reset amount.",
  };
}

export function parseSessionLines(lines, file = "") {
  let meta = null;
  const events = [];
  for (const line of lines.split(/\r?\n/)) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type === "session_meta") meta = record.payload ?? null;
    if (record.type !== "event_msg" || record.payload?.type !== "token_count") continue;
    const info = record.payload.info ?? {};
    events.push({
      timestamp: record.timestamp,
      totals: tokenTotals(info.total_token_usage),
      model: info.model ?? record.payload.model ?? null,
      rate_limits: record.payload.rate_limits ?? null,
    });
  }
  if (meta?.cwd !== TARGET_CWD || !events.length) return null;
  return {
    session_id: meta.session_id ?? basename(file, ".jsonl"),
    started_at: meta.timestamp ?? null,
    model: meta.model ?? events.at(-1).model ?? null,
    model_provider: meta.model_provider ?? null,
    events,
  };
}

function rolloutFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...rolloutFiles(path));
    else if (/^rollout-.*\.jsonl$/.test(entry.name)) files.push(path);
  }
  return files;
}

export function summarizeSessions(sessions, at) {
  const selected = sessions.map((session) => ({ ...session, event: latestAtOrBefore(session.events, at) }))
    .filter((session) => session.event)
    .sort((a, b) => a.event.timestamp.localeCompare(b.event.timestamp));
  const newestMeter = selected.flatMap((session) => session.events)
    .filter((event) => !at || event.timestamp <= at)
    .filter((event) => event.rate_limits)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  if (!selected.length || !newestMeter) throw new Error("No matching Codex token-count events found");

  const totals = emptyTokens();
  const outputSessions = selected.map(({ session_id, model, model_provider, event }) => {
    for (const key of Object.keys(totals)) totals[key] += event.totals[key];
    return { session_id, captured_at: event.timestamp, model, model_provider, cumulative_tokens: event.totals };
  });
  const providerMeter = meter(newestMeter.rate_limits);
  return {
    as_of: newestMeter.timestamp,
    meter_source: "local_codex_session_log",
    provider_meter: providerMeter,
    activity_value_proxy: {
      label: "Local cumulative token activity/value proxy, not the subscription limit or cap.",
      cumulative_tokens: totals,
    },
    activity_since_reset: {
      primary: activitySinceReset(selected, newestMeter.timestamp, providerMeter.primary),
      secondary: activitySinceReset(selected, newestMeter.timestamp, providerMeter.secondary),
    },
    sessions: outputSessions,
  };
}

export function applyMeterOverride(summary, { primaryUsed, secondaryUsed, primaryResetDisplay, secondaryResetDisplay, capturedAt } = {}) {
  if (primaryUsed == null && secondaryUsed == null) return summary;
  if (primaryUsed == null || secondaryUsed == null) throw new Error("Provide both 5-hour and weekly percentages");
  for (const value of [primaryUsed, secondaryUsed])
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("Usage percentages must be numbers from 0 through 100");
  const setUsage = (window, used_percent, reset_display) => ({ ...window, used_percent, left_percent: 100 - used_percent, ...(reset_display ? { reset_display } : {}) });
  return {
    ...summary,
    ...(capturedAt ? { checkpoint_captured_at: capturedAt } : {}),
    meter_source: "provider_ui_reported_percentages; local Codex log supplied windows and resets",
    provider_meter: {
      ...summary.provider_meter,
      primary: setUsage(summary.provider_meter.primary, primaryUsed, primaryResetDisplay),
      secondary: setUsage(summary.provider_meter.secondary, secondaryUsed, secondaryResetDisplay),
    },
  };
}

export function parseArgs(argv) {
  const args = {};
  const setPercent = (key, raw, label, invert = false) => {
    if (args[key] != null) throw new Error(`Choose one ${label} percentage option`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${label} percentage must be a number from 0 through 100`);
    args[key] = invert ? 100 - value : value;
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--snapshot") args.snapshot = true;
    else if (argv[i] === "--at") args.at = argv[++i];
    else if (argv[i] === "--primary-used") setPercent("primaryUsed", argv[++i], "5-hour");
    else if (argv[i] === "--secondary-used") setPercent("secondaryUsed", argv[++i], "weekly");
    else if (argv[i] === "--five-hour-left") setPercent("primaryUsed", argv[++i], "5-hour", true);
    else if (argv[i] === "--weekly-left") setPercent("secondaryUsed", argv[++i], "weekly", true);
    else if (argv[i] === "--primary-reset-display" || argv[i] === "--five-hour-resets") args.primaryResetDisplay = argv[++i];
    else if (argv[i] === "--secondary-reset-display" || argv[i] === "--weekly-resets") args.secondaryResetDisplay = argv[++i];
    else if (argv[i] === "--captured-at") args.capturedAt = argv[++i];
    else if (argv[i] === "--help") args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (args.at && Number.isNaN(Date.parse(args.at))) throw new Error("--at must be an ISO timestamp");
  if (args.capturedAt && Number.isNaN(Date.parse(args.capturedAt))) throw new Error("--captured-at must be an ISO timestamp");
  return args;
}

function format(summary) {
  const { primary, secondary } = summary.provider_meter;
  const reset = (value) => value.reset_display ? `${value.reset_display} (local log: ${value.resets_at})` : value.resets_at;
  const window = (name, value) => `${name}: ${value.used_percent}% used (${value.left_percent}% left), ${value.window_minutes}m, resets ${reset(value)}`;
  return [
    `Codex local activity — ${summary.as_of}`,
    `  Provider meter (${summary.meter_source}): ${window("primary", primary)}`,
    `                                   ${window("secondary", secondary)}`,
    `  Activity/value proxy (not the cap): ${summary.activity_value_proxy.cumulative_tokens.total_tokens.toLocaleString()} cumulative tokens across ${summary.sessions.length} project session(s).`,
    `  Since current primary reset: ${summary.activity_since_reset.primary.cumulative_tokens.total_tokens.toLocaleString()} scoped tokens (${summary.activity_since_reset.primary.coverage.complete_sessions} complete, ${summary.activity_since_reset.primary.coverage.boundary_sessions} boundary, ${summary.activity_since_reset.primary.coverage.partial_sessions} partial session(s)).`,
    `  Since current weekly reset: ${summary.activity_since_reset.secondary.cumulative_tokens.total_tokens.toLocaleString()} scoped tokens (${summary.activity_since_reset.secondary.coverage.complete_sessions} complete, ${summary.activity_since_reset.secondary.coverage.boundary_sessions} boundary, ${summary.activity_since_reset.secondary.coverage.partial_sessions} partial session(s)).`,
    `  Models: ${[...new Set(summary.sessions.map((s) => s.model ?? "not recorded"))].join(", ")}`,
  ].join("\n");
}

function saveSnapshot(summary) {
  mkdirSync(join(OUTPUT_FILE, ".."), { recursive: true });
  let data = { schema: 1, snapshots: [] };
  try { data = JSON.parse(readFileSync(OUTPUT_FILE, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const snapshot = { captured_at: summary.checkpoint_captured_at ?? new Date().toISOString(), ...summary };
  const existing = data.snapshots.findIndex((item) => item.captured_at === snapshot.captured_at);
  if (existing >= 0) data.snapshots[existing] = snapshot;
  else data.snapshots.push(snapshot);
  writeFileSync(OUTPUT_FILE, `${JSON.stringify(data, null, 2)}\n`);
  return OUTPUT_FILE;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Quick check-in: npm run codex-checkin -- --five-hour-left <0-100> --weekly-left <0-100> [--five-hour-resets "4:25 AM" --weekly-resets "Jul 16"]\n\nUsage: npm run codex-usage [-- --snapshot] [--primary-used <0-100> --secondary-used <0-100>] [--captured-at <ISO>] [--at <ISO timestamp>]\nReads only local Codex rollout logs for this project. --snapshot appends a gitignored local reading. Supplied percentages are recorded as the authoritative provider-UI reading. The local token totals are activity/value proxies, never the subscription cap.');
    return;
  }
  const sessions = rolloutFiles(SESSIONS_DIR)
    .map((file) => parseSessionLines(readFileSync(file, "utf8"), file))
    .filter(Boolean);
  const summary = applyMeterOverride(summarizeSessions(sessions, args.at), args);
  console.log(format(summary));
  if (args.snapshot) console.log(`Saved local snapshot: ${saveSnapshot(summary)}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) main();
