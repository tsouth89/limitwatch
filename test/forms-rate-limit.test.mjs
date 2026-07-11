import test from "node:test";
import assert from "node:assert/strict";
import { allowRequest, clientIp, verifyTurnstile } from "../functions/api/_lib.js";

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
  };
}

test("clientIp prefers CF-Connecting-IP", () => {
  const req = { headers: { get: (k) => (k === "CF-Connecting-IP" ? "1.2.3.4" : null) } };
  assert.equal(clientIp(req), "1.2.3.4");
});

test("clientIp falls back to first x-forwarded-for hop", () => {
  const req = {
    headers: {
      get: (k) => (k === "x-forwarded-for" ? "9.9.9.9, 8.8.8.8" : null),
    },
  };
  assert.equal(clientIp(req), "9.9.9.9");
});

test("clientIp returns unknown when no IP headers", () => {
  const req = { headers: { get: () => null } };
  assert.equal(clientIp(req), "unknown");
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

test("verifyTurnstile skips when secret unset", async () => {
  const r = await verifyTurnstile({}, undefined, "1.1.1.1");
  assert.deepEqual(r, { ok: true, skipped: true });
});

test("verifyTurnstile rejects missing token when secret set", async () => {
  const r = await verifyTurnstile({ TURNSTILE_SECRET_KEY: "sec" }, "", "1.1.1.1");
  assert.equal(r.ok, false);
});

test("verifyTurnstile accepts siteverify success", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ success: true }) });
  try {
    const r = await verifyTurnstile({ TURNSTILE_SECRET_KEY: "sec" }, "tok", "1.1.1.1");
    assert.equal(r.ok, true);
  } finally {
    globalThis.fetch = orig;
  }
});

test("verifyTurnstile treats fetch failure as reject", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network"); };
  try {
    const r = await verifyTurnstile({ TURNSTILE_SECRET_KEY: "sec" }, "tok", "1.1.1.1");
    assert.equal(r.ok, false);
  } finally {
    globalThis.fetch = orig;
  }
});
