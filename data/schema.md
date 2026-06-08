# Snapshot schema (v2)

Core rule: **store only as-published facts. Derive everything (per-day, $/unit, cross-provider) at display time.**
A snapshot never holds a computed number presented as a fact.

```jsonc
{
  "schema": 2,
  "date": "2026-06-07",          // ISO date this snapshot was recorded
  "entries": [
    {
      "provider": "OpenAI",
      "product": "ChatGPT",
      "plan": "Plus",
      "price_usd": 20,
      "period": "month",          // "month" | "year"
      "includes_code": true,      // bundles a coding agent (Codex / Claude Code)?

      // A plan can have MULTIPLE limits (session + weekly + model-specific).
      "limits": [
        {
          "value": 160,           // numeric, or null if provider gives only a multiplier/range
          "unit": "messages",     // "messages" | "tokens" | "requests" | "usd_credit" | "multiplier"
          "window": "3h",         // "3h" | "5h" | "day" | "week" | "month" | null
          "model": "GPT-5.5",     // which model this limit applies to, or null for whole plan
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

## Confidence tiers (badged + colored on the site)

| Tier | Meaning | Example |
|---|---|---|
| `official` | Stated on a provider-owned page | OpenAI help center "160 msg/3h" |
| `announced` | Provider blog / exec post, not a stable doc | "Boris doubled limits May 6" tweet |
| `community` | Measured/estimated by a third party | TokenMix "~88k tok/5h" |
| `crowdsourced` | Aggregated user reports (our form) | "I hit limit at N" |

## Hard rules

- **Never edit a past snapshot.** Wrong-then is still the record. Drift is the product.
- Every entry needs `source`, `confidence`, `quote`, `as_of`, `verified_on`.
- `quote` is the exact sentence the number came from. No paraphrase.
- If a provider only gives a multiplier ("Max = 20x Pro"), store `unit: "multiplier", value: 20`. Do NOT invent a token count.
- Split distinct limits into separate `limits[]` rows (5h session vs weekly cap = two rows).
- `value: null` is allowed and honest when the real number is unpublished. Show "?" on site, not a guess.

## Derived metrics (computed at display, never stored)

- per-window is the atom (what users actually hit). per-day/week only within the same unit, labeled "if sustained."
- `$/unit` = price ÷ (value × windows-per-month). Always labeled **ceiling, not typical**.
- Cross-unit comparison only behind a visible, user-adjustable `tokens_per_message` knob.
