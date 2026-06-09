# Handoff — LimitWatch

_Last updated: 2026-06-08. Living doc; overwrite when state changes. For how the repo works see [README.md](README.md) and [data/schema.md](data/schema.md)._

## What this is

LimitWatch tracks AI subscription plans/prices/limits over time, plus a **measured-usage** moat:
in-app `%` cap readings paired with the real token burn it took to get there (no API exposes these
5h/weekly caps). Static site on Cloudflare Pages, `npm run build` → `site/data.json`.

## Where we are

Live and deploying from `main`. Last commits:

- `d912ca3` — site: drop work/personal account labels from usage reports
- `ecb6127` — data: work account weekly floor (99% / ~$387)
- `05f8660` — feat: GitHub Sponsors funding

Working tree has pre-existing unstaged noise (`.claude/launch.json`, `package.json`,
`package-lock.json`) — not ours, leave unless asked.

## Measured-usage state (the active workstream)

8 readings in `data/usage-reports.json`. Two cap windows now have multiple points:

| Window | Readings (observed% → implied/window) | Implied range |
|---|---|---|
| **5h** | 75%→$71, 47%→$53(floor), **100% cap-hit→$69** | **~$53–71** |
| **week** | 78%→$197, 83%→$201, 99%→$257, 99%→$391 | **~$197–391** |

Findings so far:
- **5h ceiling clusters ~$69–71 API-equiv.** Best point is the 100% cap-HIT (`reports[5]`, $69) — a
  true lower bound, not an extrapolation.
- **Weekly looks roughly linear/token-based.** The two close personal points (78%/83%) agree within
  ~3% on implied budget. The two 99% reads come from **different logins** ($257 vs $391) — same $20
  plan, real spread.
- All measured rows are **floors**: Claude Code transcript burn only, excludes claude.ai web/desktop
  chat against the same cap.

## Account handling (just changed — read before touching usage data)

Two separate $20 Pro logins run on this machine (internally tagged `personal` / `work`). That tag is
**internal bookkeeping only**:
- `data/usage-reports.json` keeps `account` + raw scoping (for attribution).
- `scripts/build.mjs` **strips `account`** from shipped `site/data.json`.
- On-page rollup groups by `provider|plan|window` (NOT account) → both logins' readings of the same
  plan merge into one implied-budget range.
- `note`/`evidence` text must stay generic: "$20 Pro plan", "a second login on the same machine". No
  login labels, no internal project names (cssi, folloback, etc).
- Reset anchors live in `data/accounts.json`: personal = Wed 17:00 EDT, **work = Mon 23:00 EDT**.

Verified post-change: `site/data.json` has 0 work/personal/account strings; rendered measured section
shows 0 leaks, 8 verbatim rows, one `Pro · wk ~$197–$391` rollup row.

## How to capture the next reading

When you glance at an in-app `%`:

```
npm run usage -- --account personal --report   # or --account work; auto scope + since-last-reset
```

Paste the stub into `data/usage-reports.json`, set `observed: <pct>`, scrub the note/evidence to
generic wording, `npm run build`, commit, push. Pricing lives once in `scripts/lib/usage-core.mjs`
(`PRICES`/`PRICES_AS_OF`) — bump when rates change.

## Open threads / next

- **More mid-range weekly points** (not just near-100%) would confirm the linear-cap hypothesis —
  the flatter the $/% line, the more token-based.
- **Work weekly reset newly anchored** (Mon 23:00 EDT) but only one anchored work point so far; a
  second work reading would let the anchor-independent delta method cross-check it.
- Standing rule: **commit + push after each change** (per user). Site auto-deploys on push to `main`.
