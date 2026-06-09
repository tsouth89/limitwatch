import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("../scripts/cursor-usage.mjs", import.meta.url));

test("cursor-usage emits a measured block from included Cursor CSV rows", () => {
  const root = mkdtempSync(join(tmpdir(), "lw-cursor-usage-"));
  const csv = join(root, "usage.csv");
  writeFileSync(csv, [
    "Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost",
    '"2026-06-08T20:00:00Z","","","Included","claude-opus-4-8-thinking-high","No","10","20","30","40","100","Included"',
    '"2026-06-08T20:01:00Z","","","Included","gpt-5.5-medium","No","0","20","30","50","100","Included"',
    '"2026-06-08T20:02:00Z","","","Included","auto","No","0","100","150","50","300","Included"',
    '"2026-06-08T20:03:00Z","","","Included","composer-2.5-fast","No","0","100","150","50","300","Included"',
    '"2026-06-08T20:04:00Z","","","Free","auto","No","0","1","2","3","6","Free"',
    "",
  ].join("\n"));

  try {
    const out = execFileSync(process.execPath, [
      SCRIPT,
      csv,
      "--period", "May 10 - Jun 08, 2026",
      "--api-pool", "70",
      "--included-spend", "512.83",
      "--on-demand-spend", "0",
      "--api-pct", "100",
      "--auto-pct", "100",
    ], { encoding: "utf8" });
    const block = JSON.parse(out);

    assert.equal(block.period, "May 10 - Jun 08, 2026");
    assert.equal(block.as_of, "2026-06-08");
    assert.equal(block.realized_tokens_month, 800);
    assert.equal(block.included_spend_usd_observed, 512.83);
    assert.equal(block.on_demand_spend_usd_observed, 0);
    assert.deepEqual(block.breakdown, [
      { item: "API", tokens: 200, pct: 100 },
      { item: "Auto + Composer", tokens: 600, pct: 100 },
    ]);
    assert.match(block.notes, /6 Free tokens/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
