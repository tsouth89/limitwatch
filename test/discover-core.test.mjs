// Tests for the discovery helpers — above all quoteInSource(), the anti-hallucination guard that is
// the ONLY thing standing between an LLM-extracted event and auto-publication. If a paraphrased or
// fabricated quote could pass this, the auto-events pipeline would ship unverifiable claims. Also
// covers the no-dep RSS/Atom parser. node:test + node:assert, no external deps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteInSource, normForMatch, parseFeed, stripHtml, classifyModelAvailabilityText } from "../scripts/lib/discover-core.mjs";

test("quoteInSource: accepts a verbatim sentence present in the source", () => {
  const page = "Today we are announcing that Claude Pro users get 5x more usage starting next week.";
  const quote = "Claude Pro users get 5x more usage starting next week";
  assert.equal(quoteInSource(quote, page), true);
});

test("quoteInSource: ignores case, punctuation, and whitespace differences", () => {
  const page = "We're raising the weekly cap: Pro+ now includes 1500 messages every seven days.";
  // Different case, punctuation, and spacing than the source — normalization should still match.
  const quote = "PRO+ -- now,  includes 1500 messages every seven days";
  assert.equal(quoteInSource(quote, page), true);
});

test("quoteInSource: rejects a quote that is NOT in the source (hallucination)", () => {
  const page = "The Pro plan continues unchanged this quarter with no new limits.";
  const quote = "The Pro plan now includes unlimited Opus usage every day";
  assert.equal(quoteInSource(quote, page), false);
});

test("quoteInSource: rejects too-short fragments even if present", () => {
  const page = "Pricing changed today for everyone.";
  // < 6 words and < 30 normalized chars — trivially matchable, must be refused.
  assert.equal(quoteInSource("Pricing changed today", page), false);
});

test("quoteInSource: rejects empty / nullish input", () => {
  assert.equal(quoteInSource("", "anything"), false);
  assert.equal(quoteInSource(null, "anything"), false);
  assert.equal(quoteInSource("a real long enough sentence here now", ""), false);
});

test("normForMatch: lowercases and collapses non-alphanumerics to single spaces", () => {
  assert.equal(normForMatch("  Pro+ : 1,500 msgs/week!! "), "pro 1 500 msgs week");
});

test("parseFeed: extracts title/link/id/date from RSS <item>", () => {
  const xml = `<rss><channel>
    <item><title>Limit raised</title><link>https://x.test/a</link><guid>g-1</guid><pubDate>Mon, 08 Jun 2026 12:00:00 GMT</pubDate></item>
    <item><title>Other</title><link>https://x.test/b</link></item>
  </channel></rss>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { title: "Limit raised", link: "https://x.test/a", id: "g-1", date: "Mon, 08 Jun 2026 12:00:00 GMT" });
  assert.equal(items[1].id, "https://x.test/b"); // id falls back to link when no guid
});

test("parseFeed: handles Atom <entry> with <link href> and <id>", () => {
  const xml = `<feed>
    <entry><title>New plan</title><link href="https://x.test/c"/><id>id-c</id><updated>2026-06-09T00:00:00Z</updated></entry>
  </feed>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].link, "https://x.test/c");
  assert.equal(items[0].id, "id-c");
});

test("stripHtml: drops script/style and collapses to readable text", () => {
  const html = "<div>Pro <b>now</b> 5x<script>evil()</script> usage</div>";
  assert.equal(stripHtml(html), "Pro now 5x usage");
});

test("classifyModelAvailabilityText: accepts named subscriber model access and rejects API benchmarks", () => {
  assert.equal(classifyModelAvailabilityText("Claude Sonnet 5 is now the default model for Free and Pro plans"), "model_availability");
  assert.equal(classifyModelAvailabilityText("GPT-5.6 benchmark results and API pricing"), null);
});
