# Snapshot schema (v3)

> v3 adds two optional, backward-compatible things: per-limit `confidence`/`source` overrides,
> and an entry-level `measured` block for observed-consumption data (see end).

Core rule: **store only as-published facts. Derive everything (per-day, $/unit, cross-provider) at display time.**
A snapshot never holds a computed number presented as a fact.

```jsonc
{
  "schema": 3,
  "date": "2026-06-07",          // ISO date this snapshot was recorded
  "entries": [
    {
      "provider": "OpenAI",
      "product": "ChatGPT",
      "plan": "Plus",
      "price_usd": 20,
      "period": "month",          // "month" | "year"
      "surface": null,            // optional (v3): which product surface this entry's limits apply to
                                  //   e.g. "Agent SDK", "Claude Code". null/absent = the default interactive
                                  //   subscription. Limits on the same plan but different surface are tracked
                                  //   as distinct rows (part of the limit identity key).
      "includes_code": true,      // bundles a coding agent (Codex / Claude Code)?

      // A plan can have MULTIPLE limits (session + weekly + model-specific).
      "limits": [
        {
          "value": 160,           // numeric, or null if provider gives only a multiplier/range
          "unit": "messages",     // "messages" | "tokens" | "requests" | "usd_credit" | "multiplier"
                                  //   usd_credit = included $ of metered model usage (e.g. Cursor)
          "window": "3h",         // "3h" | "5h" | "day" | "week" | "month" | null
          "model": "GPT-5.5",     // which model this limit applies to, or null for whole plan
          "baseline": null,       // multiplier unit only: what the Nx is relative to ("Pro", "Free", "AI Pro"). null ⇒ defaults to "Pro" on the site.
          "kind": "primary"       // "primary" | "secondary" | "weekly_cap"
        }
      ],

      // PROVENANCE — every entry must carry these.
      "confidence": "official",   // official | announced | community | crowdsourced
      "quote": "ChatGPT Plus users can send up to 160 messages with GPT-5.5 every 3 hours.",
      "source": "https://help.openai.com/en/articles/11909943-gpt-5-in-chatgpt",
      "as_of": "2026-06-07",      // date the SOURCE states/was published
      "effective_on": null,        // optional: when an announced future change takes effect
      "verified_on": "2026-06-07",// date WE last confirmed the source still says this
      "notes": ""
    }
  ]
}
```

## `measured` block (v3, optional) — observed consumption, not a cap

For plans that publish only a dollar credit (Cursor, Replit), the official number is opaque:
it doesn't say what the $ buys in tokens. The `measured` block records what a real maxed-out
account actually consumed in a billing month, plus anything derived from it. It is rendered in
its own "Measured usage" section and is **never** mixed into the official ceiling/value tables.

```jsonc
"measured": {
  "confidence": "crowdsourced",         // crowdsourced (own account) | community (3rd-party)
  "source": "Cursor dashboard, account-owner screenshot",
  "period": "May 28 - Jun 28, 2026",
  "as_of": "2026-06-28",
  "realized_tokens_month": 294100000,   // total tokens consumed in the month (observed, not a cap)
  "realized_tokens_month_range": [a, b],// optional: spread across multiple observed months
  "api_pool_usd_stated": 20,            // the official "$X of usage" figure
  "api_pool_usd_observed": 33,          // back-calculated real pool (null if it matches stated)
  "included_spend_usd_observed": 512.83,// optional: dashboard total consumed from included pools
  "on_demand_spend_usd_observed": 0,    // optional: dashboard post-included overage
  "breakdown": [ { "item": "API", "tokens": 48500000, "pct": 73.9 } ],
  "derived_usd_per_mtok": [ { "model": "gpt-5.5-medium", "usd_per_mtok": 0.47 } ],
  "notes": "How the numbers were derived; anomalies excluded."
}
```

Method: the dashboard's per-row `Usage %` is the share of that pool's **dollar** budget. With the
official pool $ known, `$/token = (pct/100 × pool$) ÷ tokens`. Cross-validate one model across
months; if it agrees, the method holds and any divergence in the stated pool $ is a floor, not the
real ceiling.

For Cursor usage CSV exports, `realized_tokens_month` is the sum of `Kind=Included` rows only. Free,
errored/no-charge, and aborted rows are excluded from the measured monthly receipt; record them in
`notes` when relevant. Dashboard spend totals, when available, go in
`included_spend_usd_observed` / `on_demand_spend_usd_observed` because they are receipt facts, not
published caps.

## Confidence tiers (badged + colored on the site)

| Tier | Meaning | Example |
|---|---|---|
| `official` | Stated on a provider-owned page | OpenAI help center "160 msg/3h" |
| `announced` | Provider blog / exec post, not a stable doc | "Boris doubled limits May 6" tweet |
| `community` | Measured/estimated by a third party | TokenMix "~88k tok/5h" |
| `crowdsourced` | Aggregated user reports (our form) | "I hit limit at N" |

### Claim basis (per-limit `basis`, v3)

`confidence` answers *how trusted is the source*. A second, orthogonal question is *what kind of
claim is the number*. Optional per-limit `basis`:

| `basis` | Meaning |
|---|---|
| `published` (default) | A stated hard figure on a provider page. Omit the field. |
| `estimate` | The provider's own soft "expect around N" guidance, not a hard cap. |
| `derived` | Computed by us from a multiplier or other figure. |
| `measured` | Our observed burn data (usually lives in the `measured` block instead). |
| `unpublished` | Honestly absent; show `?`. |

Rules:
- **Never store a number we derived as `published`.** If we did the math, it's `derived`.
- A provider's *own* published estimate is `confidence: official` + `basis: estimate` — official
  source, soft claim. Example: Anthropic's "≈45 / ≥225 / ≥900 messages per 5h" for Pro / Max 5x /
  20x. These come from the now-retired usage articles (ids 8324991, 11014257 — live URLs 404 as of
  2026-06-07); we cite the Wayback snapshots and set `as_of` to the snapshot date.
- `estimate` and `measured` limits are **excluded from the value-per-dollar / cross-provider
  tables** — those compare hard caps only.

Per-limit `confidence`, `source`, `quote`, `as_of`, and `basis` override the entry-level values
for that one limit (used when a single plan mixes a hard multiplier with a soft archived estimate).

## Partial snapshots (`covers`, optional)

A snapshot may set top-level `"covers": ["Google", "Cursor"]` to declare it only records those
providers. Used for **historical backfills** where archives (Wayback) only let us verify some
providers for a given date. The changelog diff between two snapshots is scoped to providers
covered by **both**, so a partial snapshot never fabricates "added"/"removed" rows for the
providers it simply didn't record. A snapshot without `covers` is authoritative for every
provider it lists (a normal full snapshot). Within a covered provider you must still list **every**
plan that existed then, or omitted plans will read as drift.

Backfill values must come verbatim from a dated archive capture (cite the
`http://web.archive.org/web/<timestamp>/<url>` URL as `source`, set `as_of`/`verified_on` to the
capture date). If a number can't be read from the capture, leave it `null` (unpublished) — never guess.

## Events (`data/events.json`, optional)

Time-bounded changes — promos, temporary boosts, throttles — that are **spans**, not point-in-time
facts, so they live in their own file instead of a snapshot. The site computes active / upcoming /
ended from `today` vs `starts_on`/`ends_on`, so an event **auto-expires with no redeploy** and a
future-dated one reveals itself on its start date.

```jsonc
{
  "schema": 1,
  "events": [
    {
      "id": "anthropic-claudecode-weekly-plus50-2026", // stable unique id
      "provider": "Anthropic",
      "product": "Claude",
      "surface": "Claude Code",      // optional, same meaning as snapshot surface
      "applies_to": ["Pro", "Max 5x", "Max 20x"],
      "title": "Claude Code weekly limit +50%",
      "kind": "limit_boost",         // limit_boost | limit_cut | promo | …
      "factor": 1.5,                 // 1.5 ⇒ +50%, 2 ⇒ 2×
      "window": "week",
      "starts_on": "2026-05-13",
      "ends_on": "2026-07-13",       // null ⇒ standing/permanent (no countdown)
      "permanent": false,
      "confidence": "announced",     // same tiers as snapshots
      "quote": "Claude Code weekly limits are increasing 50%, now through July 13. …",
      "source": "https://…",
      "note": ""
    }
  ]
}
```

Required: `id`, `provider`, `title`, `kind`, `starts_on`, `confidence`, `quote`, `source`. Same rule
as everything else: **record the published wording verbatim and cite a source**; if you can't verify
the window/end-date, don't publish the event.

## Hard rules

- **Never edit a past snapshot.** Wrong-then is still the record. Drift is the product.
- Every entry needs `source`, `confidence`, `quote`, `as_of`, `verified_on`.
- Use `effective_on` for announced future changes. Do not put the future effective date in
  `as_of`; `as_of` is the date the source was observed/published.
- `quote` is the exact sentence the number came from. No paraphrase.
- If a provider only gives a multiplier ("Max = 20x Pro"), store `unit: "multiplier", value: 20`, and set `baseline` to what it is relative to (e.g. `"Pro"`, `"Free"`). Do NOT invent a token count.
- Split distinct limits into separate `limits[]` rows (5h session vs weekly cap = two rows).
- `value: null` is allowed and honest when the real number is unpublished. Show "?" on site, not a guess.

## Derived metrics (computed at display, never stored)

- per-window is the atom (what users actually hit). per-day/week only within the same unit, labeled "if sustained."
- `$/unit` = price ÷ (value × windows-per-month). Always labeled **ceiling, not typical**.
- Cross-unit comparison only behind a visible, user-adjustable `tokens_per_message` knob.
