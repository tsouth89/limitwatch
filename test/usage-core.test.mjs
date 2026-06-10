// Tests for the measured-usage core: the per-turn dollar math and the weekly-reset clock. These
// numbers ARE the moat (real burn priced at API list rates), so a silent pricing or timezone bug
// would corrupt every receipt. node:test + node:assert, no external deps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { costUsd, priceFor, lastWeeklyReset, PRICES } from "../scripts/lib/usage-core.mjs";

const M = 1_000_000;

test("costUsd: prices each token bucket at the model's list rate (per 1M)", () => {
  const p = PRICES["claude-opus-4-8"]; // in 5, out 25, cw5 6.25, cw1h 10, cr 0.5
  assert.equal(costUsd({ input_tokens: M }, "claude-opus-4-8"), p.in);
  assert.equal(costUsd({ output_tokens: M }, "claude-opus-4-8"), p.out);
  assert.equal(costUsd({ cache_read_input_tokens: M }, "claude-opus-4-8"), p.cr);
  assert.equal(costUsd({ cache_creation: { ephemeral_5m_input_tokens: M } }, "claude-opus-4-8"), p.cw5);
  assert.equal(costUsd({ cache_creation: { ephemeral_1h_input_tokens: M } }, "claude-opus-4-8"), p.cw1h);
});

test("costUsd: sums all buckets in one turn", () => {
  const usd = costUsd({
    input_tokens: 200_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 400_000, ephemeral_1h_input_tokens: 0 },
  }, "claude-sonnet-4-6"); // in 3, out 15, cr 0.3, cw5 3.75
  // 0.2*3 + 0.1*15 + 1*0.3 + 0.4*3.75 = 0.6 + 1.5 + 0.3 + 1.5 = 3.9
  assert.equal(+usd.toFixed(6), 3.9);
});

test("costUsd: unknown model or missing usage contributes 0, never NaN", () => {
  assert.equal(costUsd({ input_tokens: M }, "gpt-5"), 0);
  assert.equal(costUsd(null, "claude-opus-4-8"), 0);
  assert.equal(costUsd(undefined, "claude-opus-4-8"), 0);
});

test("priceFor: matches a dated model id by prefix", () => {
  // Transcripts carry full ids like claude-opus-4-8-20260101; the table is keyed by family prefix.
  assert.equal(priceFor("claude-opus-4-8-20260101"), PRICES["claude-opus-4-8"]);
  assert.equal(priceFor("claude-haiku-4-5"), PRICES["claude-haiku-4-5"]);
  assert.equal(priceFor("o3-mini"), null);
  assert.equal(priceFor(undefined), null);
});

test("lastWeeklyReset: returns the most recent past Wed 17:00 EDT as a UTC instant", () => {
  // EDT = UTC-4 => tz_offset_min -240. 17:00 EDT == 21:00 UTC.
  // From Fri 2026-06-12 the previous Wed is 2026-06-10.
  const reset = lastWeeklyReset({ weekday: 3, hour: 17, tz_offset_min: -240 }, new Date("2026-06-12T12:00:00Z"));
  assert.equal(reset.toISOString(), "2026-06-10T21:00:00.000Z");
});

test("lastWeeklyReset: when 'now' is just before the reset hour, rolls to the prior week", () => {
  // Wed 2026-06-10 16:00 EDT (20:00 UTC) is before that day's 17:00 reset, so the last reset is the
  // previous Wednesday, 2026-06-03 21:00 UTC.
  const reset = lastWeeklyReset({ weekday: 3, hour: 17, tz_offset_min: -240 }, new Date("2026-06-10T20:00:00Z"));
  assert.equal(reset.toISOString(), "2026-06-03T21:00:00.000Z");
});

test("lastWeeklyReset: UTC account (offset 0) anchors on the named weekday/hour", () => {
  const reset = lastWeeklyReset({ weekday: 1, hour: 0, tz_offset_min: 0 }, new Date("2026-06-12T12:00:00Z"));
  assert.equal(reset.toISOString(), "2026-06-08T00:00:00.000Z"); // Mon 2026-06-08 00:00 UTC
});
