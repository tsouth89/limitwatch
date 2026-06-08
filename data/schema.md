# Snapshot schema

```jsonc
{
  "date": "2026-06-07",        // ISO date of the snapshot
  "entries": [
    {
      "provider": "Anthropic",  // company
      "product": "Claude",      // product line
      "plan": "Pro",            // plan/tier name
      "price_usd": 20,          // monthly price USD (use yearly/12 if only annual)
      "period": "month",        // "month" | "year"
      "limit_value": 45,        // numeric limit, null if unknown
      "limit_unit": "messages", // "messages" | "tokens" | "requests" | "usd_credit"
      "window": "5h",           // reset window: "5h" | "day" | "week" | "month" | null
      "includes_code": true,    // bundles a coding agent (Claude Code / Codex)?
      "notes": "approx; varies by model and demand",
      "source": "https://..."   // where the number came from (REQUIRED)
    }
  ]
}
```

## Rules

- **Never edit a past snapshot.** Limits change silently; the wrong-then is still the record.
- Every entry needs a `source`. Blog, official page, or `"crowdsourced"` + thread URL.
- Numbers are fuzzy by nature ("~45 messages"). Put the hedge in `notes`, keep `limit_value` as the best point estimate.
- One row per (provider, product, plan, limit_unit). Split message vs token limits into two rows.
