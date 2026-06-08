// Render scripts/og-card.html to site/og.png (1200x630) using the patchright Chromium
// we already have. Run after editing the card: node scripts/make-og.mjs
import { chromium } from "patchright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cardUrl = pathToFileURL(join(root, "scripts", "og-card.html")).href;
const out = join(root, "site", "og.png");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(cardUrl, { waitUntil: "networkidle" });
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();
console.log(`wrote ${out}`);
