import test from "node:test";
import assert from "node:assert/strict";

import { emailConfigured, sendEmail } from "../functions/api/_lib.js";

const env = {
  CLOUDFLARE_EMAIL_API_TOKEN: "test-token",
  CLOUDFLARE_ACCOUNT_ID: "test-account",
};

test("emailConfigured requires both Cloudflare credentials", () => {
  assert.equal(emailConfigured(env), true);
  assert.equal(emailConfigured({ CLOUDFLARE_EMAIL_API_TOKEN: "test-token" }), false);
  assert.equal(emailConfigured({ CLOUDFLARE_ACCOUNT_ID: "test-account" }), false);
});

test("sendEmail calls Cloudflare Email Sending with the supplied message", async () => {
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const message = {
    from: { address: "alerts@limitwatch.dev", name: "LimitWatch" },
    to: ["reader@example.com"],
    subject: "Test",
    text: "Hello",
    attachments: [
      {
        filename: "proof.png",
        content: "aGVsbG8=",
        type: "image/png",
        disposition: "attachment",
      },
    ],
  };

  try {
    assert.equal(await sendEmail(env, message), true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    call.url,
    "https://api.cloudflare.com/client/v4/accounts/test-account/email/sending/send"
  );
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers.authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(call.options.body), message);
});

test("sendEmail does not call fetch when credentials are missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called");
  };

  try {
    assert.equal(await sendEmail({}, { to: "reader@example.com" }), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
