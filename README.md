# ai-limit-tracker

Tracks AI model subscription **plans, prices, and usage limits over time**.

Snapshot pricing pages exist everywhere. Nobody charts how limits *drift*. This repo
keeps dated snapshots so we can show "Claude Pro was 45 msg/5hr in Jan, X in June" and
compare $/value across Claude, Codex/ChatGPT, Gemini, etc.

The history is the moat. Snapshots are copyable; a 6-month time series is not.

## How it works

1. `data/snapshots/YYYY-MM-DD.json` — one dated snapshot per file. Append, never edit history.
2. `node scripts/build.mjs` — merges every snapshot into `site/data.json`.
3. `site/index.html` — static page, renders charts from `site/data.json` (Chart.js via CDN).

No backend. Host on GitHub Pages / Netlify free tier.

## Add a snapshot

Copy the newest file in `data/snapshots/`, rename to today's date, update numbers, set a
`source` URL for each entry. Then:

```
node scripts/build.mjs
```

## Record schema

Each snapshot is `{ "date": "YYYY-MM-DD", "entries": [ ... ] }`. See `data/schema.md`.

## Status

MVP. Manual weekly updates. Automate scraping later only if traffic justifies it.
