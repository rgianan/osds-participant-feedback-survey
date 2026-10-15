import { test } from "node:test";
import assert from "node:assert/strict";
import { MAINTENANCE_MESSAGE, handler } from "../../netlify/functions/gas-proxy.mjs";

const GAS_URL = "https://script.google.com/macros/s/TEST/exec";
const request = (body) => ({
  httpMethod: "POST",
  body: JSON.stringify(body),
  headers: { "x-nf-request-id": "req-1" },
});

function withEnv(values, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, values);
  return fn().finally(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
}

const baseEnv = { GAS_WEB_APP_URL: GAS_URL, SUBMIT_SHARED_TOKEN: "t".repeat(64), PORTAL_BASE_URL: "https://portal.test" };

test("without BACKEND, requests still go to Apps Script exactly as before", () =>
  withEnv({ ...baseEnv, BACKEND: "" }, async () => {
    const sent = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 });
    };
    try {
      const reply = await handler(request({ action: "getActivityData" }));
      assert.equal(reply.statusCode, 200);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].url, GAS_URL);
      assert.deepEqual(sent[0].body, {
        action: "getActivityData",
        proxyToken: "t".repeat(64),
        portalBaseUrl: "https://portal.test",
        requestContext: { requestId: "req-1" },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  }));

test("BACKEND=supabase answers from the new backend and never calls Apps Script", () =>
  withEnv({ ...baseEnv, BACKEND: "supabase", SUPABASE_DB_URL: "" }, async () => {
    const realFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; throw new Error("should not be called"); };
    try {
      const reply = await handler(request({ action: "getActivityData" }));
      assert.equal(reply.statusCode, 200);
      assert.deepEqual(JSON.parse(reply.body), {
        ok: false,
        error: "The database is not configured. Set SUPABASE_DB_URL in the site's environment variables.",
      });
      assert.equal(fetched, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  }));

test("maintenance mode turns away every change, submissions and sign-ins included, and lets reads through", () =>
  withEnv({ ...baseEnv, BACKEND: "", MAINTENANCE_MODE: "on", TURNSTILE_SECRET_KEY: "secret" }, async () => {
    const sent = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      sent.push({ url, action: JSON.parse(init.body).action });
      return new Response(JSON.stringify({ ok: true, data: { valid: true } }), { status: 200 });
    };
    try {
      for (const action of ["submitFeedback", "adminLogin", "adminSaveActivity", "adminRetryCertificates", "adminSaveUser", "somethingNew"]) {
        const reply = await handler(request({ action, turnstileToken: "token" }));
        assert.equal(reply.statusCode, 503, action);
        assert.deepEqual(JSON.parse(reply.body), { ok: false, error: MAINTENANCE_MESSAGE, maintenance: true });
      }
      assert.deepEqual(sent, [], "neither Turnstile nor Apps Script is called for them");
      for (const action of ["verifyCertificate", "getActivityData", "adminGetResponses", "adminGetAuditLog"])
        assert.equal((await handler(request({ action }))).statusCode, 200, action);
      assert.deepEqual(sent.map((s) => s.action), ["verifyCertificate", "getActivityData", "adminGetResponses", "adminGetAuditLog"]);
      // The browser retries only messages that read as momentary (src/lib/api.js); this one must not be retried.
      assert.ok(!/lock|busy|simultaneous|too many|network|fetch|temporar|timeout/i.test(MAINTENANCE_MESSAGE));
    } finally {
      globalThis.fetch = realFetch;
    }
  }));

test("maintenance is off unless switched on", () =>
  withEnv({ ...baseEnv, BACKEND: "", MAINTENANCE_MODE: "off" }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 });
    try {
      assert.equal((await handler(request({ action: "adminSaveActivity" }))).statusCode, 200);
    } finally {
      globalThis.fetch = realFetch;
    }
  }));
