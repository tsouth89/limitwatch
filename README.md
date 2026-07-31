# LimitWatch (ai-limit-tracker)

Tracks AI model subscription **plans, prices, and usage limits over time** — with a coding-agent focus:
what a $20 / $100 / $200 sub buys in **API-equivalent token value**, measured from real burn.

Snapshot pricing pages exist everywhere. Nobody charts how limits *drift*, or what opaque caps are
worth at API rates. This repo keeps dated snapshots and usage receipts so we can show both.

The history + measured floors are the moat. Sticker tables are copyable; a 6-month time series and
real (%, burn) pairs are not.

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
4. `site/index.html` — static page. Leads with **API value by price band** ($20 / $100 / $200) for
   coding agents, then measured receipts, value/$, drift, and the published-limits table as reference.
   Also: What's new (events + radar), resets, price-history sparklines, changelog + email/RSS. All
   numbers link back to their source.

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

- **Weekly, in CI:** `.github/workflows/watch.yml` runs every Monday at 13:17 UTC, including
  headed Patchright + Xvfb for the bot-protected sources. It maintains one rolling source-watch
  triage issue when text moves. A residential proxy is optional for pages Cloudflare still blocks.
- **Weekly, on this PC:** the `LimitWatch Weekly Watch` scheduled task runs
  `scripts/watch-and-report.ps1` every Monday at 10:00 AM local time while you are signed in.
  This is the independent headed-browser fallback for OpenAI or other pages that reject cloud runs.

## Discover new announcements

`npm run watch` only diffs pages you already track, so it can't catch a *new* announcement (e.g.
"Copilot moves to usage-based billing"). `npm run discover` (`scripts/discover.mjs`) polls the
provider news/changelog sources in `data/feeds.json` and reports items it hasn't seen before. Two
source kinds: `format: "rss"` parses an RSS/Atom feed (GitHub, OpenAI), and `format: "html"` scrapes
article links matching `link_pattern` off a server-rendered index page (Anthropic, which has no
feed). Only verified sources are listed; remaining gaps are recorded in `no_feed`. State lives in
`data/discover-state.json`; the first run seeds a silent baseline.

- **Without an API key:** lists the new items for manual triage.
- **With `ANTHROPIC_API_KEY`:** one batched classify call (Sonnet by default, override with
  `ANTHROPIC_CLASSIFY_MODEL`) keeps only items that change a **named consumer plan's** limit / quota /
  price, drops enterprise/metrics/SDK/dev-tool noise, and appends the survivors to the on-site news
  radar (`data/news.json`). High-certainty, quote-verified items are auto-published to
  `data/auto-events.json` (the quote must appear verbatim in the source, so a hallucinated fact can't
  ship); everything else stays on the radar as an unverified lead.

**The radar self-curates** — no manual queue. Items auto-expire after `RADAR_TTL_DAYS` (default 21),
and the build drops any radar item whose link already became a published event, so leads roll off on
their own instead of piling up. New feeds are seeded into `data/discover-state.json` so adding a
source doesn't flood the radar with its back-catalog.

**In CI, off your PC:** `.github/workflows/discover.yml` runs this daily. Add the
`ANTHROPIC_API_KEY` repo secret to turn on relevance filtering; with it, irrelevant items do not
create work and relevant leads are added to one rolling triage issue. Without it, the queue still
gets the raw items for manual review. Feeds are plain HTTP, so no headed browser is needed — the
Cloudflare-protected pages stay on the diff-based `watch` path.

## Capture measured usage (subscription caps)

The 5-hour and weekly subscription caps (Claude.ai/Claude Code, ChatGPT) are **not exposed by any
API** — only an in-product `%` indicator. The moat is pairing that reading with how much you actually
burned to reach it.

### One-command check-in (preferred)

When you glance at any agent’s usage UI, run:

```
npm run checkin
# or non-interactive:
npm run checkin -- --claude-account personal --claude-5h 47 --claude-week 83
npm run checkin -- --codex-5h-left 58 --codex-week-left 93
npm run checkin -- --cursor path/to/usage-events.csv --cursor-api-pool 20 --cursor-period "May 10 - Jun 08, 2026"
npm run checkin -- --claude-account personal --claude-week 83 --write   # append stubs with observed %
```

`scripts/checkin.mjs` wraps the existing collectors (Claude transcripts, Codex local rollouts, optional
Cursor CSV), prints a one-line API-equiv summary per window, and emits ready-to-append
`usage-reports.json` stubs. Prefer **cap-hit** and mid-window points over daily noise. No separate
token-tracker repo — this stays in LimitWatch as maintainer tooling.

### Lower-level collectors

`scripts/cc-usage.mjs` reads every Claude Code session transcript
(`~/.claude/projects/**/*.jsonl`) across all projects, dedupes assistant turns by `message.id`, and
sums exact per-turn tokens priced at API list rates per model.

```
npm run usage -- --account personal                    # auto: scope + since-last-reset from accounts.json
npm run usage -- --since 2026-06-03T21:00:00Z          # anchor to your weekly reset
npm run usage -- --days 7                              # trailing window
npm run usage -- --account personal --report           # emit a usage-reports.json entry stub
npm run usage -- --since <reset-iso> --json            # machine-readable totals
```

**No continuous daemon needed.** Transcripts are durable on disk (Claude Code keeps `cleanupPeriodDays`,
default 30), so burn for any past window is reconstructable after the fact — you don't have to log
continuously. The valuable data point is the **(observed %, burn) pair**, and the % is always a manual
read. `scripts/burn-log.*` remains available for a dense Claude burn curve but is optional.

Workflow: when you read the in-app weekly `%`, run check-in (or `usage` with `--since <reset moment>`),
then append a `data/usage-reports.json` entry pairing `observed: <pct>` with the measured token/$ floor.
Captures at several `%` across one window show whether the cap is token- or dollar-weighted:
flat $/% ⇒ token cap, bending ⇒ $-weighted.

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

## Crowdsourced readings (on-site form)

The **Submit a reading** card (hero → `#contribute`) posts to a Cloudflare Pages Function
(`functions/api/receipt.js`) that emails a ready-to-verify `usage-reports.json` stub via Cloudflare
Email Sending,
**with the screenshot attached**. A screenshot of the usage screen is **required** (max 1.5&nbsp;MB);
an optional Cursor usage CSV helps exclude Free/promo rows. Nothing is auto-published; a human still
verifies every reading. If the function isn't configured or is unreachable, the form falls back to
the GitHub issue template (also requires screenshot evidence).

To turn it on, set four env vars in the Cloudflare Pages project (Settings → Environment variables):

- `CLOUDFLARE_EMAIL_API_TOKEN` (secret) — an API token with Email Sending Write only.
- `CLOUDFLARE_ACCOUNT_ID` — the Cloudflare account that owns the sending domain.
- `RECEIPT_TO` — where leads are emailed (your inbox).
- `RECEIPT_FROM` — a Cloudflare Email Sending sender. `limitwatch.dev` is onboarded, so use
  `LimitWatch <receipts@limitwatch.dev>`.

Abuse controls (always on when the function can send mail):

- Per-IP rate limit (5 / hour) before Email Sending is called. Uses the `SUBS` KV binding when present,
  otherwise the Cache API.
- Honeypot field on the form (unchanged).
- Optional Cloudflare Turnstile: set Pages secret `TURNSTILE_SECRET_KEY`, then add
  `<meta name="cf-turnstile-sitekey" content="YOUR_SITE_KEY">` in `site/index.html`. When the
  secret is set, missing/invalid tokens are rejected (403).

## Email change alerts (double opt-in)

The "Get changes by email" form on the Changelog card lets visitors subscribe to a digest that fires
when a tracked plan's limits or price move. All in Cloudflare Pages Functions + Email Sending + KV, with
double opt-in (subscribe → confirm email → confirmed) so nobody can sign up someone else, and a
one-click unsubscribe on every email.

- `functions/api/subscribe.js` — stores a pending subscriber in KV, sends the confirm email.
- `functions/api/confirm.js` / `unsubscribe.js` — flip status / remove (token links).
- `functions/api/notify.js` — diffs the live `data.json` changelog against a KV marker and emails
  confirmed subscribers any new entries. Idempotent (no new changes → no email).
- `.github/workflows/alerts.yml` — pokes `/api/notify` daily (needs the `NOTIFY_SECRET` repo secret).

Setup (one time):

1. KV namespace `limitwatch-subscribers` already exists (id `7adec8a72aea4860b180ef7afdf3733c`). In the
   Pages project → Settings → Functions → **KV namespace bindings**, bind it as **`SUBS`**.
2. Pages env vars: `ALERT_FROM` = `LimitWatch <alerts@limitwatch.dev>`, plus the
   `CLOUDFLARE_EMAIL_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` values from above.
   Set `NOTIFY_SECRET` to a separate long random value; do not reuse an API token.
3. GitHub repo secret `NOTIFY_SECRET` = the same value, so the daily workflow can authenticate.

Until the KV binding + env vars are set, the form degrades to pointing at the RSS feed.

Abuse controls on `/api/subscribe` (when configured):

- Honeypot field (unchanged).
- Per-IP (5 / hour) and per-email (3 / hour) rate limits in `SUBS` KV before confirm mail sends.
- Optional Turnstile — same `TURNSTILE_SECRET_KEY` + site-key meta as the receipt form.

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
