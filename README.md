# LimitWatch (ai-limit-tracker)

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

## Deploy (Cloudflare Pages)

Static site, no server. Hosted on Cloudflare Pages at `limitwatch.southforgeai.com`.

Dashboard setup (one time):
1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → pick the repo.
3. Build command: `npm run build` · Build output directory: `site` · root: repo root.
4. Deploy. Then Custom domains → add `limitwatch.southforgeai.com` (DNS is already on Cloudflare, so it auto-wires).

CLI alternative (no GitHub needed):
```
npm run build
npx wrangler pages deploy site --project-name=limitwatch
```

Every push to `main` redeploys. To update data: add a snapshot, `npm run build`, commit, push.

## Status

MVP. Manual weekly updates. Automate scraping later only if traffic justifies it.
