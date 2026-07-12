import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "checkin.mjs");

test("checkin --help exits 0", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /claude-account/);
});

test("checkin Claude flag mode emits stubs and summary", () => {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, "--claude-account", "personal", "--claude-week", "50", "--claude-5h", "25"],
    { encoding: "utf8", cwd: root },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /=== Summary ===/);
  assert.match(r.stdout, /Claude Max \(personal\) week: 50%/);
  assert.match(r.stdout, /usage-reports\.json stubs/);
  assert.match(r.stdout, /"provider": "Anthropic"/);
  assert.match(r.stdout, /"observed": 50/);
  assert.match(r.stdout, /"window": "week"/);
});
