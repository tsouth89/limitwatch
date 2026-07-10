import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMeterOverride, parseArgs, parseSessionLines, summarizeSessions } from "../scripts/codex-usage.mjs";

const target = "C:\\projects\\personal\\ai-limit-tracker";
const event = (timestamp, total, used) => JSON.stringify({
  timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: total - 10, cached_input_tokens: 5, output_tokens: 10, total_tokens: total } }, rate_limits: {
    plan_type: "prolite", primary: { used_percent: used, window_minutes: 300, resets_at: 1783671911 }, secondary: { used_percent: 0, window_minutes: 10080, resets_at: 1784258711 },
  } },
});

test("codex usage keeps the final cumulative event and newest account meter", () => {
  const kept = parseSessionLines([
    JSON.stringify({ type: "session_meta", payload: { session_id: "kept", cwd: target, timestamp: "2026-07-10T03:26:00.000Z", model_provider: "openai" } }),
    event("2026-07-10T03:26:00.000Z", 100, 1),
    event("2026-07-10T03:27:00.000Z", 250, 2),
  ].join("\n"));
  const ignored = parseSessionLines(JSON.stringify({ type: "session_meta", payload: { cwd: "C:\\elsewhere" } }));
  assert.equal(ignored, null);

  const summary = summarizeSessions([kept], "2026-07-10T03:26:30.000Z");
  assert.equal(summary.provider_meter.primary.used_percent, 1);
  assert.equal(summary.provider_meter.primary.left_percent, 99);
  assert.equal(summary.provider_meter.primary.window_minutes, 300);
  assert.equal(summary.sessions[0].cumulative_tokens.total_tokens, 100);
  assert.equal(summary.activity_value_proxy.cumulative_tokens.total_tokens, 100);
  assert.equal(summary.activity_since_reset.primary.cumulative_tokens.total_tokens, 100);
  assert.equal(summary.activity_since_reset.primary.coverage.complete_sessions, 1);
  assert.match(summary.activity_value_proxy.label, /not the subscription limit/);

  const checkpoint = applyMeterOverride(summary, {
    primaryUsed: 25,
    secondaryUsed: 4,
    primaryResetDisplay: "4:25 AM",
    secondaryResetDisplay: "Jul 16",
    capturedAt: "2026-07-10T04:35:37.000Z",
  });
  assert.equal(checkpoint.provider_meter.primary.used_percent, 25);
  assert.equal(checkpoint.provider_meter.secondary.used_percent, 4);
  assert.equal(checkpoint.provider_meter.primary.reset_display, "4:25 AM");
  assert.equal(checkpoint.checkpoint_captured_at, "2026-07-10T04:35:37.000Z");
  assert.match(checkpoint.meter_source, /provider_ui_reported/);
});

test("codex check-in accepts the provider UI's left percentages", () => {
  const args = parseArgs(["--snapshot", "--five-hour-left", "58", "--weekly-left", "93", "--five-hour-resets", "4:25 AM", "--weekly-resets", "Jul 16"]);
  assert.equal(args.snapshot, true);
  assert.equal(args.primaryUsed, 42);
  assert.equal(args.secondaryUsed, 7);
  assert.equal(args.primaryResetDisplay, "4:25 AM");
  assert.equal(args.secondaryResetDisplay, "Jul 16");
  assert.throws(() => parseArgs(["--primary-used", "1", "--five-hour-left", "99"]), /Choose one 5-hour/);
});
