import { test } from "node:test";
import assert from "node:assert/strict";
import { handler } from "../../netlify/functions/gas-proxy.mjs";

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
        error: "The database is not configured. Set SUPABASE_DB_URL in Netlify.",
      });
      assert.equal(fetched, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  }));
