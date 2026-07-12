# Handoff — LimitWatch

_Last updated: 2026-07-11. Living doc; overwrite when state changes. For how the repo works see [README.md](README.md) and [data/schema.md](data/schema.md)._

## What this is

LimitWatch is a **coding-agent API-value decoder** plus limit-drift ledger: in-app `%` readings paired
with real token burn (no API exposes these 5h/weekly caps), shown as $20 / $100 / $200 bands on the
site. Message-cap tables stay as reference/SEO. Static site on Cloudflare Pages, `npm run build` →
`site/data.json`.

## Where we are

Live and deploying from `main`. Product pivot (2026-07-11): hero leads with API-equivalent value by
price band; `npm run checkin` is the maintainer capture path.

## Measured-usage state (the active workstream)

Readings in `data/usage-reports.json` span Anthropic Pro and Max. Cursor Pro / Pro+ have snapshot
`measured` token receipts. ChatGPT/Codex still need solid (%, burn) pairs.

| Window | Readings (observed% → implied/window) | Implied range |
|---|---|---|
| **5h** | 75%→$71, 47%→$53(floor), **100% cap-hit→$69** | **~$53–71** |
| **week** | 78%→$197, 83%→$201, 99%→$257, 99%→$391 | **~$197–391** |

Findings so far:
- **5h ceiling clusters ~$69–71 API-equiv.** Best point is the 100% cap-HIT — a true lower bound.
- **Weekly looks roughly linear/token-based** on Pro; Max readings span a wide range across logins.
- All Claude rows are **floors**: Claude Code transcript burn only, excludes claude.ai web/desktop.

## Account handling (read before touching usage data)

**Maintainer stack (2026-07-11):** 2× Claude Max ($100), ChatGPT Plus ($20), Cursor ($20). No ChatGPT Pro.

Two Claude Max logins on this machine (internally tagged `personal` / `work`). That tag is
**internal bookkeeping only**:
- `data/usage-reports.json` keeps `account` + raw scoping (for attribution).
- `scripts/build.mjs` **strips `account`** from shipped `site/data.json`.
- On-page rollup groups by `provider|plan|window` (NOT account) → both logins' Max readings merge into
  one implied-budget range. Report plan `"Max"` soft-matches snapshot `"Max 5x"` (cheapest Max* tier).
- `note`/`evidence` text must stay generic: "Max plan", "a second login on the same machine". No
  login labels, no internal project names.
- `data/accounts.json`: both `plan: Max`; personal `match: "personal"`; work `exclude: "personal"`;
  resets personal = Wed 17:00 EDT, work = Mon 23:00 EDT (re-verify on Max panels if the day/hour moved).
- Park a login with `active: false` — `burn-log` skips it; `--account` still works for one-offs.

## How to capture the next reading

When you glance at an in-app `%` (any of Claude / Codex / Cursor):

```
npm run checkin
# flag form:
npm run checkin -- --claude-account personal --claude-5h 47 --claude-week 83 --write
npm run checkin -- --codex-5h-left 58 --codex-week-left 93
npm run checkin -- --cursor usage-events.csv --cursor-api-pool 20 --cursor-period "…"
```

Review stubs (scrub login labels), `npm run build`, commit, push. Pricing for Claude lives in
`scripts/lib/usage-core.mjs` (`PRICES`/`PRICES_AS_OF`). Lower-level: `npm run usage`, `codex-checkin`,
`cursor-usage` — checkin wraps them.

## Open threads / next

- **More mid-range weekly Max points** (not just near-100%) would confirm the linear-cap hypothesis
  (SOU-73).
- **Second Max account weekly reading** for cross-check (SOU-74). Re-verify weekly reset day/hour.
- Non-Claude measured: Cursor $20 refresh + ChatGPT Plus/Codex (%, burn) pairs so the $20 hero band
  is not Claude-only (SOU-86).
- Standing rule: **commit + push after each change** (per user). Site auto-deploys on push to `main`.
