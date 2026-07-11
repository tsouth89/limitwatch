import test from "node:test";
import assert from "node:assert/strict";
import { allowRequest, clientIp } from "../functions/api/_lib.js";

function mockKv() {
  const map = new Map();
  return {
    async get(key, type) {
      const v = map.get(key);
      if (v == null) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      map.set(key, value);
    },
    _map: map,
  };
}

test("clientIp prefers CF-Connecting-IP", () => {
  const req = { headers: { get: (k) => (k === "CF-Connecting-IP" ? "1.2.3.4" : null) } };
  assert.equal(clientIp(req), "1.2.3.4");
});

test("allowRequest enforces a fixed window limit", async () => {
  const kv = mockKv();
  assert.equal(await allowRequest(kv, "t:ip", { limit: 2, windowSeconds: 3600 }), true);
  assert.equal(await allowRequest(kv, "t:ip", { limit: 2, windowSeconds: 3600 }), true);
  assert.equal(await allowRequest(kv, "t:ip", { limit: 2, windowSeconds: 3600 }), false);
});

test("allowRequest without store denies", async () => {
  assert.equal(await allowRequest(null, "x", { limit: 5, windowSeconds: 60 }), false);
});
