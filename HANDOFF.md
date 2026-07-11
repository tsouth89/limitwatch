# Handoff — LimitWatch

_Last updated: 2026-07-11. Living doc; overwrite when state changes. For how the repo works see [README.md](README.md) and [data/schema.md](data/schema.md)._

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

## Account handling (read before touching usage data)

**Maintainer stack (2026-07-11):** 2× Claude Max ($100), ChatGPT Plus ($20), Cursor ($20). No ChatGPT Pro.

Two Claude Max logins on this machine (internally tagged `personal` / `work`). That tag is
**internal bookkeeping only**:
- `data/usage-reports.json` keeps `account` + raw scoping (for attribution).
- `scripts/build.mjs` **strips `account`** from shipped `site/data.json`.
- On-page rollup groups by `provider|plan|window` (NOT account) → both logins' Max readings merge into
  one implied-budget range.
- `note`/`evidence` text must stay generic: "Max plan", "a second login on the same machine". No
  login labels, no internal project names.
- `data/accounts.json`: both `plan: Max`; personal `match: "personal"`; work `exclude: "personal"`;
  resets personal = Wed 17:00 EDT, work = Mon 23:00 EDT (re-verify on Max panels if the day/hour moved).
- Park a login with `active: false` — `burn-log` skips it; `--account` still works for one-offs.

## How to capture the next reading

When you glance at an in-app `%`:

```
npm run usage -- --account personal --report   # or --account work; auto scope + since-last-reset
```

Paste the stub into `data/usage-reports.json`, set `observed: <pct>`, scrub the note/evidence to
generic wording, `npm run build`, commit, push. Pricing lives once in `scripts/lib/usage-core.mjs`
(`PRICES`/`PRICES_AS_OF`) — bump when rates change.

## Open threads / next

- **More mid-range weekly Max points** (not just near-100%) would confirm the linear-cap hypothesis —
  the flatter the $/% line, the more token-based (SOU-73).
- **Second Max account weekly reading** for cross-check once both logins are burning under the restored
  personal/work project proxy (SOU-74). Re-verify weekly reset day/hour on each Max panel if unsure.
- Non-Claude measured: Cursor $20 / ChatGPT Plus when a reading is handy (SOU-86).
- Standing rule: **commit + push after each change** (per user). Site auto-deploys on push to `main`.
