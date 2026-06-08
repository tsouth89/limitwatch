# LimitWatch (ai-limit-tracker)

Tracks AI model subscription **plans, prices, and usage limits over time**.

Snapshot pricing pages exist everywhere. Nobody charts how limits *drift*. This repo
keeps dated snapshots so we can show "Claude Pro was 45 msg/5hr in Jan, X in June" and
compare $/value across Claude, Codex/ChatGPT, Gemini, etc.

The history is the moat. Snapshots are copyable; a 6-month time series is not.

## How it works

1. `data/snapshots/YYYY-MM-DD.json` — one dated snapshot per file. Append, never edit history.
2. `npm run build` (`scripts/build.mjs`) — merges every snapshot into `site/data.json` **and
   derives the changelog** by diffing consecutive snapshots (limit + price changes).
3. `site/index.html` — static page. Renders the latest limits, value-per-dollar bars, a
   cross-provider token estimate, real measured receipts, and the derived changelog from
   `site/data.json`. All numbers link back to their source.

No backend. Hosted as a static site on Cloudflare Pages.

Providers tracked: OpenAI/ChatGPT, Anthropic/Claude, Google/Gemini, xAI/Grok, Perplexity,
Cursor, GitHub Copilot, Replit.

## Add a snapshot

Copy the newest file in `data/snapshots/`, rename to today's date, update numbers, set a
`source` URL for each entry. Then:

```
npm run build
```

## Backfill history (Wayback)

The changelog only has signal once there are ≥2 dated snapshots. To bootstrap a time series
without waiting months, add **historical** snapshots from the [Wayback Machine](https://web.archive.org):

- Find captures: `http://web.archive.org/cdx/search/cdx?url=<page>&output=json&from=YYYYMMDD&to=YYYYMMDD`
- Read a capture: `curl --compressed "http://web.archive.org/web/<timestamp>id_/<url>"`
- Record values **verbatim** from the capture; cite the `web.archive.org/web/<timestamp>/<url>`
  URL as `source` and set `as_of`/`verified_on` to the capture date. If a number can't be read,
  leave it `null` — never guess.

A backfill usually can't verify every provider for a given date, so historical snapshots set
`"covers": ["Google", "Cursor"]` to declare which providers they're authoritative for. The build
scopes the changelog diff to providers covered by both snapshots, so a partial snapshot never
fabricates "added"/"removed" rows for providers it didn't record. See `data/schema.md`.

## Watch official sources for changes

`npm run watch` (`scripts/fetch.mjs`) hashes each page in `data/sources.json` and flags only
the ones that changed since last check, so you re-verify just what moved. It never edits
snapshots — human stays in the loop. Use `--http-only` to skip the browser sources.

- **HTTP sources** (`method: "http"`) — Anthropic, Google, GitHub, Replit, Cursor, plus the
  xAI/Perplexity community pages we cite. Plain fetch.
- **Browser sources** (`method: "browser"`, `scripts/browser-fetch.mjs`) — OpenAI pages are
  Cloudflare-protected and return 403 to plain fetch. **Headed** patchright clears the block
  (headless still gets 403), so these need a desktop session (a visible browser window flashes).
- Note: `cursor.com/docs/account/pricing` is a JS-rendered SPA that returns almost no text to
  plain HTTP; switch it to `method: "browser"` if you need reliable diffs there.

### Automation

- **Weekly, in CI:** `.github/workflows/watch.yml` runs the HTTP-only subset every Monday
  (13:17 UTC) and opens an issue if any page's text moved. Works even when your PC is off.
- **Full coverage, local:** `scripts/watch-and-report.ps1` (scheduled task) runs all sources
  incl. the headed-browser OpenAI pages.

## Record schema

Each snapshot is `{ "date": "YYYY-MM-DD", "entries": [ ... ] }`. See `data/schema.md`.

## Deploy (Cloudflare Pages)

Static site, no server. Hosted on Cloudflare Pages at `limitwatch.southforgeai.com`.

Dashboard setup (one time):
1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → pick the repo.
3. Build command: `npm run build` · Build output directory: `site` · root: repo root.
4. Deploy. Then Custom domains → add `limitwatch.southforgeai.com` (DNS is already on Cloudflare, so it auto-wires).

CLI alternative (no GitHub needed):
```
npm run build
npx wrangler pages deploy site --project-name=limitwatch
```

Every push to `main` redeploys. To update data: add a snapshot, `npm run build`, commit, push.

## Status

Live. Time series bootstrapped from Wayback (first history: Jan→Jun 2026). Source watching runs
weekly in CI (HTTP) and locally (full). Snapshots are still human-verified before they land —
the watcher only flags what to re-check, it never edits data.
