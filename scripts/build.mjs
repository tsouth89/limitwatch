#!/usr/bin/env node
// Merge every data/snapshots/*.json into site/data.json for the static site.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapDir = join(root, "data", "snapshots");

const files = readdirSync(snapDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

const snapshots = files.map((f) => {
  const snap = JSON.parse(readFileSync(join(snapDir, f), "utf8"));
  if (!snap.date) throw new Error(`${f}: missing date`);
  if (!Array.isArray(snap.entries)) throw new Error(`${f}: entries not array`);
  for (const e of snap.entries) {
    if (!e.source) throw new Error(`${f}: entry ${e.provider}/${e.plan} missing source`);
  }
  return snap;
});

const out = {
  generated_at: new Date().toISOString(),
  snapshot_count: snapshots.length,
  date_range: snapshots.length
    ? [snapshots[0].date, snapshots[snapshots.length - 1].date]
    : [],
  snapshots,
};

writeFileSync(join(root, "site", "data.json"), JSON.stringify(out, null, 2));
console.log(`built site/data.json from ${snapshots.length} snapshot(s)`);
