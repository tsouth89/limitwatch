import test from "node:test";
import assert from "node:assert/strict";
import { isActiveAccount, findAccount } from "../scripts/lib/accounts.mjs";

test("isActiveAccount treats missing active as on", () => {
  assert.equal(isActiveAccount({ label: "personal" }), true);
  assert.equal(isActiveAccount({ label: "personal", active: true }), true);
});

test("isActiveAccount parks active:false only", () => {
  assert.equal(isActiveAccount({ label: "work", active: false }), false);
  const accounts = [
    { label: "parked", active: false },
    { label: "implied" },
    { label: "on", active: true },
  ];
  assert.deepEqual(accounts.filter(isActiveAccount).map((a) => a.label), ["implied", "on"]);
});

test("findAccount marks parked and preserves scope fields", () => {
  const cfg = {
    accounts: [
      { label: "work", plan: "Max", active: false, exclude: "personal", match: undefined },
    ],
  };
  const acc = findAccount(cfg, "work");
  assert.equal(acc.parked, true);
  assert.equal(acc.plan, "Max");
  assert.equal(acc.exclude, "personal");
  assert.equal(findAccount(cfg, "missing"), null);
});
