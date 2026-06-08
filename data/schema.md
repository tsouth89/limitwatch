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
  "breakdown": [ { "item": "API", "tokens": 48500000, "pct": 73.9 } ],
  "derived_usd_per_mtok": [ { "model": "gpt-5.5-medium", "usd_per_mtok": 0.47 } ],
  "notes": "How the numbers were derived; anomalies excluded."
}
```

Method: the dashboard's per-row `Usage %` is the share of that pool's **dollar** budget. With the
official pool $ known, `$/token = (pct/100 × pool$) ÷ tokens`. Cross-validate one model across
months; if it agrees, the method holds and any divergence in the stated pool $ is a floor, not the
real ceiling.

## Confidence tiers (badged + colored on the site)

| Tier | Meaning | Example |
|---|---|---|
| `official` | Stated on a provider-owned page | OpenAI help center "160 msg/3h" |
| `announced` | Provider blog / exec post, not a stable doc | "Boris doubled limits May 6" tweet |
| `community` | Measured/estimated by a third party | TokenMix "~88k tok/5h" |
| `crowdsourced` | Aggregated user reports (our form) | "I hit limit at N" |

### Claim basis (a rule, not yet a field)

`confidence` answers *how trusted is the source*. A second, orthogonal question is *what kind of
claim is the number*: a stated hard figure, the provider's own soft estimate, a value derived from
a multiplier, our measured burn, or honestly absent. Today every entry is a stated figure or `?`,
so we do **not** carry a `basis` field — adding an enum that only restates `?` would be dead
scaffolding.

Add an optional per-limit `basis` (`published` | `estimate` | `derived` | `measured` |
`unpublished`) the first time we ingest an `estimate` or `derived` number, and badge it then.
**Never store a derived number as if it were published** — that is the exact failure this rule
guards against (e.g. Anthropic's circulated "225 / 900 msg per 5h" Max figures are 5×/20× the
Pro estimate, not first-party-published; verified absent across six current Claude help pages on
2026-06-07, so they are not in the dataset).

## Hard rules

- **Never edit a past snapshot.** Wrong-then is still the record. Drift is the product.
- Every entry needs `source`, `confidence`, `quote`, `as_of`, `verified_on`.
- `quote` is the exact sentence the number came from. No paraphrase.
- If a provider only gives a multiplier ("Max = 20x Pro"), store `unit: "multiplier", value: 20`, and set `baseline` to what it is relative to (e.g. `"Pro"`, `"Free"`). Do NOT invent a token count.
- Split distinct limits into separate `limits[]` rows (5h session vs weekly cap = two rows).
- `value: null` is allowed and honest when the real number is unpublished. Show "?" on site, not a guess.

## Derived metrics (computed at display, never stored)

- per-window is the atom (what users actually hit). per-day/week only within the same unit, labeled "if sustained."
- `$/unit` = price ÷ (value × windows-per-month). Always labeled **ceiling, not typical**.
- Cross-unit comparison only behind a visible, user-adjustable `tokens_per_message` knob.
