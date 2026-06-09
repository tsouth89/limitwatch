// Golden tests for scripts/build.mjs — the file that derives the changelog AND pre-renders the
// HTML, sitemap, robots.txt, and RSS. A single run drives the headline feature plus every SEO
// surface, so these tests run the REAL build against fixture data in a temp dir (via
// LIMITWATCH_ROOT) and assert on the generated outputs. No external deps: node:test + node:assert.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const BUILD = fileURLToPath(new URL("../scripts/build.mjs", import.meta.url));

// ---- fixture helpers --------------------------------------------------------
const lim = (o = {}) => ({ value: null, unit: "messages", window: "day", model: null, kind: "primary", ...o });
const entry = (o = {}) => ({
  provider: "TestCo", product: "P", confidence: "official",
  quote: "q", source: "https://example.com/src", as_of: "2026-01-01", verified_on: "2026-01-01",
  price_usd: 10, limits: [lim()], ...o,
});
const snap = (date, entries, extra = {}) => ({ schema: 3, date, entries, ...extra });

const MARKED_HTML =
  "<!doctype html><html><body>" +
  '<div id="stats"><!-- BUILD:stats:start --><!-- BUILD:stats:end --></div>' +
  '<div id="latest"><!-- BUILD:latest:start --><!-- BUILD:latest:end --></div>' +
  '<div id="changelog"><!-- BUILD:changelog:start --><!-- BUILD:changelog:end --></div>' +
  '<footer><!-- BUILD:providerlinks:start --><!-- BUILD:providerlinks:end --></footer>' +
  "</body></html>";

// Build a temp root with data/snapshots + site/index.html, optionally events/change-dates files.
function setupRoot({ snapshots = [], events, changeDates, indexHtml = MARKED_HTML } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lw-test-"));
  mkdirSync(join(root, "data", "snapshots"), { recursive: true });
  mkdirSync(join(root, "site"), { recursive: true });
  for (const s of snapshots) writeFileSync(join(root, "data", "snapshots", `${s.date}.json`), JSON.stringify(s));
  if (events) writeFileSync(join(root, "data", "events.json"), JSON.stringify(events));
  if (changeDates) writeFileSync(join(root, "data", "change-dates.json"), JSON.stringify(changeDates));
  writeFileSync(join(root, "site", "index.html"), indexHtml);
  return root;
}

function runBuild(root) {
  return execFileSync(process.execPath, [BUILD], { env: { ...process.env, LIMITWATCH_ROOT: root }, encoding: "utf8" });
}

// Keys are `provider|product|plan|...` (limit keys) or `provider|product|plan` (price keys);
// plan is always index 2, provider index 0 — so match on segments, not substrings.
const planOf = (c) => c.key.split("|")[2];
const readData = (root) => JSON.parse(readFileSync(join(root, "site", "data.json"), "utf8"));
const readFile = (root, name) => readFileSync(join(root, "site", name), "utf8");
const cleanup = (root) => rmSync(root, { recursive: true, force: true });

// ---- changelog derivation ---------------------------------------------------
test("derives price, limit, model, add, and remove changes between two snapshots", () => {
  const s1 = snap("2026-01-01", [
    entry({ plan: "Basic", price_usd: 10, limits: [lim({ value: 100 })] }),
    entry({ plan: "Modeled", price_usd: 20, limits: [lim({ value: 50, model: "M1" })] }),
    entry({ plan: "Gone", price_usd: 30, limits: [lim({ value: 5 })] }),
  ]);
  const s2 = snap("2026-02-01", [
    entry({ plan: "Basic", price_usd: 12, limits: [lim({ value: 150 })] }),          // price + limit change
    entry({ plan: "Modeled", price_usd: 20, limits: [lim({ value: 50, model: "M2" })] }), // model swap → model_changed
    entry({ plan: "NewPlan", price_usd: 15, limits: [lim({ value: 7 })] }),          // added
    // "Gone" omitted → removed
  ]);
  const root = setupRoot({ snapshots: [s1, s2] });
  try {
    runBuild(root);
    const { changes } = readData(root);

    const price = changes.find((c) => c.kind === "price_changed" && planOf(c) === "Basic");
    assert.ok(price, "expected a price_changed for Basic");
    assert.equal(price.from, 10);
    assert.equal(price.to, 12);

    const limitChg = changes.find((c) => c.kind === "limit_changed" && planOf(c) === "Basic");
    assert.ok(limitChg, "expected a limit_changed for Basic");
    assert.equal(limitChg.from, 100);
    assert.equal(limitChg.to, 150);

    const model = changes.find((c) => c.kind === "model_changed" && planOf(c) === "Modeled");
    assert.ok(model, "expected model_changed (same-date remove+add collapsed)");
    assert.equal(model.from, "M1");
    assert.equal(model.to, "M2");
    assert.equal(model.value, 50);

    const removed = changes.find((c) => c.kind === "limit_removed" && planOf(c) === "Gone");
    assert.ok(removed, "expected limit_removed for Gone");

    const added = changes.find((c) => c.kind === "limit_added" && planOf(c) === "NewPlan");
    assert.ok(added, "expected limit_added for NewPlan");
    assert.equal(added.to, 7);

    assert.equal(changes.length, 5, "exactly five changes, model swap collapsed to one");
  } finally {
    cleanup(root);
  }
});

// ---- partial snapshots (covers) --------------------------------------------
test("a partial snapshot (covers) never fabricates changes for an unrecorded provider", () => {
  const s1 = snap("2026-03-01", [
    entry({ provider: "A", plan: "A1", limits: [lim({ value: 100 })] }),
    entry({ provider: "B", plan: "B1", limits: [lim({ value: 5 })] }),
  ]);
  const s2 = snap("2026-03-15", [
    entry({ provider: "A", plan: "A1", limits: [lim({ value: 200 })] }),
  ], { covers: ["A"] });
  const root = setupRoot({ snapshots: [s1, s2] });
  try {
    runBuild(root);
    const { changes } = readData(root);
    assert.ok(changes.every((c) => !c.key.startsWith("B|")), "provider B must have no fabricated changes");
    const a = changes.find((c) => c.kind === "limit_changed" && c.key.startsWith("A|"));
    assert.ok(a, "expected A's real limit change");
    assert.equal(a.from, 100);
    assert.equal(a.to, 200);
  } finally {
    cleanup(root);
  }
});

// ---- curated effective dates (change-dates.json) ----------------------------
test("change-dates.json remaps a change's date and preserves observed_on", () => {
  const s1 = snap("2026-04-01", [entry({ plan: "Basic", price_usd: 10, limits: [lim({ value: 100 })] })]);
  const s2 = snap("2026-05-01", [entry({ plan: "Basic", price_usd: 12, limits: [lim({ value: 100 })] })]);
  const changeDates = { rules: [{ kind: "price_changed", provider: "TestCo", plan: "Basic", from: 10, to: 12, date: "2026-04-10" }] };
  const root = setupRoot({ snapshots: [s1, s2], changeDates });
  try {
    runBuild(root);
    const { changes } = readData(root);
    const price = changes.find((c) => c.kind === "price_changed" && planOf(c) === "Basic");
    assert.ok(price, "expected the price change");
    assert.equal(price.date, "2026-04-10", "date remapped to curated effective date");
    assert.equal(price.observed_on, "2026-05-01", "original observed date preserved");
  } finally {
    cleanup(root);
  }
});

// ---- pre-rendered HTML + SEO outputs ---------------------------------------
test("pre-renders the HTML build blocks and writes robots.txt, sitemap.xml, changes.xml", () => {
  const s1 = snap("2026-01-01", [entry({ plan: "Basic", price_usd: 10, limits: [lim({ value: 100 })] })]);
  const s2 = snap("2026-02-01", [entry({ plan: "Basic", price_usd: 12, limits: [lim({ value: 100 })] })]);
  const root = setupRoot({ snapshots: [s1, s2] });
  try {
    runBuild(root);
    const html = readFile(root, "index.html");

    // markers preserved and filled
    assert.match(html, /<!-- BUILD:stats:start -->[\s\S]*providers[\s\S]*<!-- BUILD:stats:end -->/);
    assert.match(html, /<!-- BUILD:latest:start -->[\s\S]*Basic[\s\S]*<!-- BUILD:latest:end -->/);
    assert.match(html, /<!-- BUILD:latest:start -->[\s\S]*class="pmark"[\s\S]*<!-- BUILD:latest:end -->/);
    assert.match(html, /<!-- BUILD:changelog:start -->[\s\S]*price[\s\S]*<!-- BUILD:changelog:end -->/);

    const robots = readFile(root, "robots.txt");
    assert.match(robots, /Sitemap: https:\/\/limitwatch\.southforgeai\.com\/sitemap\.xml/);

    const sitemap = readFile(root, "sitemap.xml");
    assert.match(sitemap, /<loc>https:\/\/limitwatch\.southforgeai\.com\/<\/loc>/);

    const rss = readFile(root, "changes.xml");
    assert.match(rss, /<rss version="2\.0">/);
    assert.match(rss, /<title>LimitWatch changes<\/title>/);
    assert.match(rss, /<item>/);
  } finally {
    cleanup(root);
  }
});

// ---- per-provider SEO landing pages ----------------------------------------
test("generates per-provider pages, links them from the footer, and lists them in the sitemap", () => {
  const s1 = snap("2026-01-01", [
    entry({ provider: "Anthropic", plan: "Pro", price_usd: 20, limits: [lim({ value: 45, window: "5h" })] }),
    entry({ provider: "OpenAI", plan: "Plus", price_usd: 20, limits: [lim({ value: 160, window: "3h" })] }),
  ]);
  const s2 = snap("2026-02-01", [
    entry({ provider: "Anthropic", plan: "Pro", price_usd: 24, limits: [lim({ value: 45, window: "5h" })] }), // price change
    entry({ provider: "OpenAI", plan: "Plus", price_usd: 20, limits: [lim({ value: 160, window: "3h" })] }),
  ]);
  const root = setupRoot({ snapshots: [s1, s2] });
  try {
    runBuild(root);

    // Known providers get product-name slugs.
    const claude = readFile(root, "claude.html");
    assert.match(claude, /<link rel="canonical" href="https:\/\/limitwatch\.southforgeai\.com\/claude">/);
    assert.match(claude, /Anthropic plan limits/);
    assert.match(claude, /<strong>Pro<\/strong>/);
    assert.match(claude, /application\/ld\+json/, "should embed JSON-LD");
    assert.match(claude, /Pro \$20 -&gt; \$24/, "provider changelog should show the price move");

    const chatgpt = readFile(root, "chatgpt.html");
    assert.match(chatgpt, /OpenAI plan limits/);

    // Homepage footer links to each provider page (crawlable internal links).
    const html = readFile(root, "index.html");
    assert.match(html, /<!-- BUILD:providerlinks:start -->[\s\S]*href="\/claude"[\s\S]*<!-- BUILD:providerlinks:end -->/);
    assert.match(html, /href="\/chatgpt"/);

    // Sitemap includes the homepage and every provider page.
    const sitemap = readFile(root, "sitemap.xml");
    assert.match(sitemap, /<loc>https:\/\/limitwatch\.southforgeai\.com\/<\/loc>/);
    assert.match(sitemap, /<loc>https:\/\/limitwatch\.southforgeai\.com\/claude<\/loc>/);
    assert.match(sitemap, /<loc>https:\/\/limitwatch\.southforgeai\.com\/chatgpt<\/loc>/);
  } finally {
    cleanup(root);
  }
});

test("changelog block shows the empty-state message with a single snapshot", () => {
  const root = setupRoot({ snapshots: [snap("2026-01-01", [entry({ plan: "Basic" })])] });
  try {
    runBuild(root);
    const html = readFile(root, "index.html");
    assert.match(html, /<!-- BUILD:changelog:start -->[\s\S]*No changes yet[\s\S]*<!-- BUILD:changelog:end -->/);
  } finally {
    cleanup(root);
  }
});

// ---- validation fails loudly ------------------------------------------------
test("build fails (non-zero exit) when a required field is missing", () => {
  const bad = snap("2026-01-01", [{ ...entry({ plan: "Basic" }), quote: undefined }]);
  const root = setupRoot({ snapshots: [bad] });
  try {
    assert.throws(
      () => execFileSync(process.execPath, [BUILD], { env: { ...process.env, LIMITWATCH_ROOT: root }, stdio: "pipe" }),
      (err) => {
        assert.notEqual(err.status, 0, "build should exit non-zero on invalid data");
        const out = `${err.stderr ?? ""}${err.stdout ?? ""}${err.message ?? ""}`;
        assert.match(out, /missing quote/);
        return true;
      },
    );
  } finally {
    cleanup(root);
  }
});
