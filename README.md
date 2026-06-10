# LimitWatch (ai-limit-tracker)

Tracks AI model subscription **plans, prices, and usage limits over time**.

Snapshot pricing pages exist everywhere. Nobody charts how limits *drift*. This repo
keeps dated snapshots so we can show "Claude Pro was 45 msg/5hr in Jan, X in June" and
compare $/value across Claude, Codex/ChatGPT, Gemini, etc.

The history is the moat. Snapshots are copyable; a 6-month time series is not.

## How it works

1. `data/snapshots/YYYY-MM-DD.json` — one dated snapshot per file. Append, never edit history.
2. `npm run build` (`scripts/build.mjs`) — merges every snapshot into `site/data.json` **and
   derives the changelog**. Diffs run **per provider**, comparing each snapshot to the previous
   one that *covers* the same provider, so partial historical snapshots can interleave by date
   (e.g. a Cursor-only Feb snapshot between two Google snapshots) and still attribute changes to
   the right dates. A same-date remove+add of one limit slot that only swapped models (e.g. a
   plan's 160 msgs/3h budget moving GPT-5.3 → GPT-5.5) is collapsed into a single `model_changed`.
3. `data/events.json` (optional) — time-bounded promos/boosts/throttles (spans, not point-in-time
   facts). Passed through to `site/data.json`; the page computes active/upcoming/ended from today.
4. `site/index.html` — static page. Renders a slim "Live" status bar with a roadmap, a **What's new**
   card (live events with countdowns + headline changes), the latest limits, value-per-dollar bars,
   a cross-provider token estimate, real measured receipts, a **price-history sparkline per plan**
   (every plan in 2+ snapshots), and the derived changelog. All numbers link back to their source.

No backend. Hosted as a static site on Cloudflare Pages.

Providers tracked: OpenAI/ChatGPT, Anthropic/Claude, Google/Gemini, xAI/Grok, Perplexity,
Cursor, GitHub Copilot, Replit.

## Add a snapshot

Copy the newest file in `data/snapshots/`, rename to today's date, update numbers, set a
`source` URL for each entry. Then:

```
npm run build
```

## Track a special event

Temporary limit changes (e.g. "Claude Code weekly limit +50% through Jul 13") go in
`data/events.json`, not a snapshot — they're spans. Add an entry with `starts_on`/`ends_on`
(null end = permanent), a verbatim `quote`, and a `source`, then `npm run build`. The page shows
active events with a live countdown, surfaces upcoming ones on their start date, and folds ended
ones into history automatically — no redeploy needed to expire them. See `data/schema.md`.

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

## Discover new announcements

`npm run watch` only diffs pages you already track, so it can't catch a *new* announcement (e.g.
"Copilot moves to usage-based billing"). `npm run discover` (`scripts/discover.mjs`) polls the
provider news/changelog sources in `data/feeds.json` and reports items it hasn't seen before. Two
source kinds: `format: "rss"` parses an RSS/Atom feed (GitHub, OpenAI), and `format: "html"` scrapes
article links matching `link_pattern` off a server-rendered index page (Anthropic, which has no
feed). Only verified sources are listed; remaining gaps are recorded in `no_feed`. State lives in
`data/discover-state.json`; the first run seeds a silent baseline.

- **Without an API key:** lists the new items for manual triage.
- **With `ANTHROPIC_API_KEY`:** one cheap batched call filters to just the items that change a
  subscription limit / quota / price, and drafts an `events.json` stub for each (verify the quote
  against the source before merging — it never auto-publishes).

**In CI, off your PC:** `.github/workflows/discover.yml` runs this daily and opens an issue when
something new appears. Add the `ANTHROPIC_API_KEY` repo secret to turn on relevance filtering;
without it the issue still lists raw items. Feeds are plain HTTP, so no headed browser is needed —
the Cloudflare-protected pages stay on the diff-based `watch` path.

## Capture measured usage (subscription caps)

The 5-hour and weekly subscription caps (Claude.ai/Claude Code, ChatGPT) are **not exposed by any
API** — only an in-product `%` indicator. The moat is pairing that reading with how much you actually
burned to reach it. `scripts/cc-usage.mjs` reads every Claude Code session transcript
(`~/.claude/projects/**/*.jsonl`) across all projects, dedupes assistant turns by `message.id`, and
sums exact per-turn tokens priced at API list rates per model.

```
npm run usage -- --account personal                    # auto: scope + since-last-reset from accounts.json
npm run usage -- --since 2026-06-03T21:00:00Z          # anchor to your weekly reset
npm run usage -- --days 7                              # trailing window
npm run usage -- --account personal --report           # emit a usage-reports.json entry stub
npm run usage -- --since <reset-iso> --json            # machine-readable totals
```

**No scheduler needed.** Transcripts are durable on disk (Claude Code keeps `cleanupPeriodDays`,
default 30), so burn for any past window is reconstructable after the fact — you don't have to log
continuously. The valuable data point is the **(observed %, burn) pair**, and the % is always a manual
read, so just run the one-command capture when you glance at the in-app indicator. `scripts/burn-log.*`
(continuous per-account logging) remains available for a dense curve but is optional; for weekly cadence
the on-demand path loses nothing.

Workflow: when you read the in-app weekly `%`, run with `--since <reset moment>`, then append a
`data/usage-reports.json` entry pairing `observed: <pct>` with the measured token/$ floor (see the
weekly row already there). Captures at several `%` across one window show whether the cap is
token- or dollar-weighted: flat $/% ⇒ token cap, bending ⇒ $-weighted.

**It is a floor, not the whole story.** Transcripts cover Claude Code only — Claude.ai web/desktop
chat hits the same cap but isn't logged locally. Prices live in the `PRICES` table in the script;
update them when rates change. This complements `npm run ratelimits` (API-tier headers, not sub caps).

**Account attribution is the sharp edge.** A weekly/5h cap is per-account, but transcripts record no
account identity, and Claude Code's login is **global per instance** — not per project. If you ran more
than one Claude login on this machine during the window, summing every project over-counts one account
and invents burn for another. The only proxy is the project (cwd): scope with `--match personal` /
`--exclude work-thing` and inspect with `--by-project`. Treat the result as a soft bound, and when you
can't attribute cleanly (two logins, unknown per-account reset window), record the in-app `%` as an
**observed-only** receipt with `api_equiv_usd: null` rather than publishing a guessed dollar figure.

**Account is internal-only — never site-facing.** A row's `account` (e.g. `personal` / `work`) is a
local bookkeeping tag so *you* can scope captures; site visitors don't know or care which login a
reading came from — they're all the same $20-plan cap. So: keep `account` + raw scoping in
`data/usage-reports.json`, but `scripts/build.mjs` **strips `account`** when emitting `site/data.json`,
the on-page rollup groups by `provider|plan|window` (not account) so multiple logins' readings of the
same plan merge into one implied-budget range, and `note`/`evidence` text must stay generic ("$20 Pro
plan", "a second login on the same machine") — no login labels or internal project names. Map your
logins → project proxy + weekly reset in `data/accounts.json` (e.g. work resets Mon 23:00 EDT).

### Automate the burn curve

`npm run burn-log` (`scripts/burn-log.mjs`) appends one timestamped point **per account** to
`data/burn-log.json`: trailing-24h burn, plus week-to-date since each account's configured weekly
reset. Map your logins → project proxy + reset in `data/accounts.json`. Run it on a schedule
(`scripts/burn-log.ps1` for Windows Task Scheduler, daily or hourly) and the matching measured floor
already exists whenever you read an in-app `%` — pair the reading to the nearest row's
`week_to_date.usd` instead of reconstructing the window by hand. Still a floor, still Claude Code only.
Pricing and aggregation live once in `scripts/lib/usage-core.mjs` (shared with `npm run usage`); bump
`PRICES` / `PRICES_AS_OF` there when rates change.

## Record schema

Each snapshot is `{ "date": "YYYY-MM-DD", "entries": [ ... ] }`. See `data/schema.md`.

## Deploy (Cloudflare Pages)

Static site, no server. Hosted on Cloudflare Pages at `limitwatch.dev`.

Dashboard setup (one time):
1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → pick the repo.
3. Build command: `npm run build` · Build output directory: `site` · root: repo root.
4. Deploy. Then Custom domains → add `limitwatch.dev` (DNS is already on Cloudflare, so it auto-wires).

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
