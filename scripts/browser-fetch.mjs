// Render a bot-protected page with patchright (stealth-patched Chromium) and return
// its visible text. OpenAI's help/pricing pages sit behind Cloudflare; plain fetch
// gets 403. patchright strips the automation leaks Cloudflare fingerprints.
//
// Stealth rules that actually matter here:
//  - launchPersistentContext (a real profile) beats launch() — fewer headless tells.
//  - do NOT set a custom user-agent or extra headers; that reintroduces leaks.
//  - let the Cloudflare interstitial resolve, then read the real DOM text.
import { chromium } from "patchright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CF_MARKERS = [
  "just a moment",
  "verifying you are human",
  "checking your browser",
  "cf-challenge",
  "enable javascript and cookies",
];

const looksBlocked = (t) => {
  const s = t.slice(0, 4000).toLowerCase();
  return CF_MARKERS.some((m) => s.includes(m));
};

// Returns { ok, text, status, note }
export async function fetchRendered(url, { timeoutMs = 90000, headless = true } = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), "lw-chrome-"));
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(userDataDir, {
      channel: "chrome", // use real Chrome if present — strongest fingerprint
      headless,
      viewport: { width: 1280, height: 800 },
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const status = resp?.status() ?? 0;

    // Wait out the Cloudflare challenge: poll until markers clear or timeout.
    const deadline = Date.now() + timeoutMs;
    let text = await page.evaluate(() => document.body?.innerText ?? "");
    while (looksBlocked(text) && Date.now() < deadline) {
      await page.waitForTimeout(1500);
      text = await page.evaluate(() => document.body?.innerText ?? "");
    }

    if (looksBlocked(text)) return { ok: false, text, status, note: "still on Cloudflare challenge after wait" };
    if (!text || text.length < 200) return { ok: false, text, status, note: "page text too short / empty" };
    return { ok: true, text, status, note: "" };
  } catch (e) {
    return { ok: false, text: "", status: 0, note: e.message };
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

// CLI: node scripts/browser-fetch.mjs <url> [--headed]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2];
  const headless = !process.argv.includes("--headed");
  if (!url) { console.error("usage: node scripts/browser-fetch.mjs <url> [--headed]"); process.exit(1); }
  const r = await fetchRendered(url, { headless });
  console.log(`status=${r.status} ok=${r.ok} len=${r.text.length} note=${r.note || "-"}`);
  console.log("---- first 600 chars ----");
  console.log(r.text.slice(0, 600));
}
