import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAction } from "../../netlify/backend/actions.mjs";
import { APPS_SCRIPT_TIMEOUT, APPS_SCRIPT_WAIT_MS } from "../../netlify/backend/apps-script.mjs";
import { handler } from "../../netlify/functions/gas-proxy.mjs";
import { freshDatabase, seedAdmin, seedSession } from "./helpers.mjs";

/**
 * Netlify stops a function after 30 seconds and answers with its own error
 * page, which the browser can only call "a webpage instead of API data". So
 * every wait on Apps Script ends sooner, in a reply the browser can read.
 */

const timedOut = () => Promise.reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("Apps Script is given 25 seconds, under Netlify's 30, and a timeout reads as one", () => {
  assert.equal(APPS_SCRIPT_WAIT_MS, 25_000);
  // The browser retries messages that read as momentary (src/lib/api.js), as it did for the old abort.
  assert.match(APPS_SCRIPT_TIMEOUT, /timeout/i);
});

test("a slow Apps Script behind the proxy ends in a readable reply, and the log names the action, not the request", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { GAS_WEB_APP_URL: "https://script.google.com/macros/s/TEST/exec", SUBMIT_SHARED_TOKEN: "t".repeat(64), BACKEND: "" });
  const logged = [];
  const realLog = console.log;
  console.log = (line) => logged.push(line);
  try {
    const reply = await withFetch(timedOut, () =>
      handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "adminGetDashboard", adminToken: "secret-token" }) }));
    assert.equal(reply.statusCode, 504);
    assert.deepEqual(JSON.parse(reply.body), { ok: false, error: APPS_SCRIPT_TIMEOUT });
    const line = JSON.parse(logged.at(-1));
    assert.deepEqual(Object.keys(line).sort(), ["action", "error", "ms", "ok"]);
    assert.equal(line.action, "adminGetDashboard");
    assert.ok(!logged.join(" ").includes("secret-token"), "the log never holds the request's contents");
  } finally {
    console.log = realLog;
    process.env = saved;
  }
});

test("a slow Apps Script during a signature upload ends in the same readable error", async () => {
  const { db } = await freshDatabase();
  await seedAdmin(db, { email: "boss@example.com", hash: "x" });
  await seedSession(db, "boss@example.com", "tok");
  const reply = await handleAction(
    { action: "adminUploadSignature", adminToken: "tok", payload: { filename: "sig.png", mimeType: "image/png", base64: "AAAA" } },
    { db, now: new Date(), appsScript: { gasUrl: "https://script.google.com/macros/s/TEST/exec", proxyToken: "p".repeat(64), workerToken: "w".repeat(96) },
      fetch: timedOut },
  );
  assert.deepEqual(reply, { ok: false, error: APPS_SCRIPT_TIMEOUT });
});
