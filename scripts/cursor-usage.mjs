#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const REQUIRED_COLUMNS = [
  "Date",
  "Kind",
  "Model",
  "Input (w/ Cache Write)",
  "Input (w/o Cache Write)",
  "Cache Read",
  "Output Tokens",
  "Total Tokens",
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (quoted) {
      if (c === '"' && n === '"') {
        value += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        value += c;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(value);
      value = "";
    } else if (c === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (c !== "\r") {
      value += c;
    }
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v !== ""));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      args._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const toNumber = (value, label) => {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(n)) throw new Error(`${label} must be numeric`);
  return n;
};

const addTo = (bucket, row) => {
  bucket.rows++;
  bucket.total_tokens += row.total_tokens;
  bucket.input_with_cache_write += row.input_with_cache_write;
  bucket.input_without_cache_write += row.input_without_cache_write;
  bucket.cache_read += row.cache_read;
  bucket.output_tokens += row.output_tokens;
};

const emptyBucket = () => ({
  rows: 0,
  total_tokens: 0,
  input_with_cache_write: 0,
  input_without_cache_write: 0,
  cache_read: 0,
  output_tokens: 0,
});

function summarize(rows) {
  const total = emptyBucket();
  const byKind = new Map();
  const dates = [];

  for (const row of rows) {
    addTo(total, row);
    if (row.date) dates.push(row.date);
    if (!byKind.has(row.kind)) byKind.set(row.kind, emptyBucket());
    addTo(byKind.get(row.kind), row);
  }

  return { total, byKind, dates: dates.sort() };
}

const isApiModel = (model) => model !== "auto" && !model.startsWith("composer-");

function measuredBlock(summary, opts) {
  const included = summary.byKind.get("Included") ?? emptyBucket();
  const free = summary.byKind.get("Free") ?? emptyBucket();
  const errored = summary.byKind.get("Errored, No Charge") ?? emptyBucket();
  const aborted = summary.byKind.get("Aborted, Not Charged") ?? emptyBucket();

  let apiTokens = 0;
  let autoComposerTokens = 0;
  // Re-walk raw rows so API vs Auto excludes free/no-charge rows.
  for (const row of opts.rows) {
    if (row.kind !== "Included") continue;
    if (isApiModel(row.model)) apiTokens += row.total_tokens;
    else autoComposerTokens += row.total_tokens;
  }

  const block = {
    confidence: opts.confidence ?? "crowdsourced",
    source: opts.source ?? "Cursor dashboard screenshot + usage CSV export",
    period: opts.period ?? "UNKNOWN",
    as_of: opts.asOf ?? summary.dates.at(-1)?.slice(0, 10) ?? "UNKNOWN",
    realized_tokens_month: included.total_tokens,
    api_pool_usd_stated: toNumber(opts.apiPool, "--api-pool"),
    api_pool_usd_observed: toNumber(opts.apiPoolObserved ?? opts.apiPool, "--api-pool-observed"),
  };

  const includedSpend = toNumber(opts.includedSpend, "--included-spend");
  const onDemandSpend = toNumber(opts.onDemandSpend, "--on-demand-spend");
  if (includedSpend != null) block.included_spend_usd_observed = includedSpend;
  if (onDemandSpend != null) block.on_demand_spend_usd_observed = onDemandSpend;

  block.breakdown = [
    { item: "API", tokens: apiTokens },
    { item: "Auto + Composer", tokens: autoComposerTokens },
  ];
  const apiPct = toNumber(opts.apiPct, "--api-pct");
  const autoPct = toNumber(opts.autoPct, "--auto-pct");
  if (apiPct != null) block.breakdown[0].pct = apiPct;
  if (autoPct != null) block.breakdown[1].pct = autoPct;

  const excluded = [];
  if (free.total_tokens) excluded.push(`${fmt(free.total_tokens)} Free tokens`);
  if (errored.total_tokens) excluded.push(`${fmt(errored.total_tokens)} errored/no-charge tokens`);
  if (aborted.rows) excluded.push(`${aborted.rows} aborted/no-charge rows`);
  block.notes = [
    "Cursor usage CSV import. This is a measured billing-period receipt, not a published cap.",
    includedSpend != null ? `Dashboard included spend: $${includedSpend}.` : null,
    onDemandSpend != null ? `Dashboard on-demand spend: $${onDemandSpend}.` : null,
    `Included-token total: ${fmt(included.total_tokens)} (${fmt(apiTokens)} API-model tokens; ${fmt(autoComposerTokens)} Auto/Composer tokens).`,
    excluded.length ? `Excluded from the included monthly receipt: ${excluded.join(", ")}.` : null,
    "Per-model dollar rates are not derived unless the export includes precise per-model dollar charges.",
  ].filter(Boolean).join(" ");

  return block;
}

const fmt = (n) => Number(n).toLocaleString("en-US");

function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!file || args.help) {
    console.log(`Usage: npm run cursor-usage -- <usage-events.csv> --period "May 10 - Jun 08, 2026" --api-pool 70 --included-spend 512.83 --on-demand-spend 0 --api-pct 100 --auto-pct 100

Reads a Cursor usage-events CSV export and prints a measured-block JSON stub for data/snapshots.
Rows with Kind=Included become realized_tokens_month; Free and no-charge rows are excluded.`);
    process.exit(file ? 0 : 1);
  }

  const table = parseCsv(readFileSync(file, "utf8"));
  if (table.length < 2) throw new Error(`${basename(file)} has no data rows`);
  const [header, ...rawRows] = table;
  const index = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const col of REQUIRED_COLUMNS) if (index[col] == null) throw new Error(`${basename(file)} missing required column "${col}"`);

  const rows = rawRows.map((r) => ({
    date: r[index.Date],
    kind: r[index.Kind],
    model: r[index.Model],
    input_with_cache_write: toNumber(r[index["Input (w/ Cache Write)"]], "Input (w/ Cache Write)") ?? 0,
    input_without_cache_write: toNumber(r[index["Input (w/o Cache Write)"]], "Input (w/o Cache Write)") ?? 0,
    cache_read: toNumber(r[index["Cache Read"]], "Cache Read") ?? 0,
    output_tokens: toNumber(r[index["Output Tokens"]], "Output Tokens") ?? 0,
    total_tokens: toNumber(r[index["Total Tokens"]], "Total Tokens") ?? 0,
  }));
  const summary = summarize(rows);
  const block = measuredBlock(summary, {
    ...args,
    rows,
    asOf: args["as-of"],
    apiPool: args["api-pool"],
    apiPoolObserved: args["api-pool-observed"],
    includedSpend: args["included-spend"],
    onDemandSpend: args["on-demand-spend"],
    apiPct: args["api-pct"],
    autoPct: args["auto-pct"],
  });

  console.log(JSON.stringify(block, null, 2));
}

main();
