import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as proxy from "../../api/gas-proxy.mjs";
import * as worker from "../../api/worker.mjs";
import { APPS_SCRIPT_WAIT_MS } from "../../netlify/backend/apps-script.mjs";
import { LIMIT_MS } from "../../netlify/backend/db.mjs";
import { MAINTENANCE_MESSAGE } from "../../netlify/functions/gas-proxy.mjs";

/** The same functions on Vercel: api/*.mjs wrap netlify/functions/*.mjs, and vercel.json routes to them. */

const vercel = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
const SITE = "https://ched-feedback-survey.vercel.app";

async function withEnv(values, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    process.env = saved;
  }
}

test("vercel.json sends the old paths to the same functions, in Singapore, with time to spare", () => {
  assert.deepEqual(vercel.rewrites[0], { source: "/.netlify/functions/:name", destination: "/api/:name" });
  assert.deepEqual(vercel.rewrites.at(-1), { source: "/(.*)", destination: "/index.html" }, "the app's own routes, after the functions");
  assert.deepEqual(vercel.regions, ["sin1"]);
  const allowed = vercel.functions["api/*.mjs"].maxDuration * 1000;
  assert.ok(allowed > APPS_SCRIPT_WAIT_MS && allowed > LIMIT_MS, "our own limits answer first, never Vercel's timeout page");
  assert.equal(vercel.buildCommand, "npm run build:vercel");
});

test("Vercel serves the same security headers as config/_headers, which Netlify reads", () => {
  const fromNetlify = readFileSync(new URL("../../config/_headers", import.meta.url), "utf8")
    .split("\n").slice(1).map((line) => line.trim()).filter(Boolean)
    .map((line) => ({ key: line.slice(0, line.indexOf(":")), value: line.slice(line.indexOf(":") + 1).trim() }));
  assert.deepEqual(vercel.headers, [{ source: "/(.*)", headers: fromNetlify }]);
});

test("a request through Vercel reaches the proxy as on Netlify, and its reply comes back unchanged", () =>
  withEnv({ GAS_WEB_APP_URL: "https://script.google.com/macros/s/TEST/exec", SUBMIT_SHARED_TOKEN: "t".repeat(64),
    BACKEND: "", MAINTENANCE_MODE: "on" }, async () => {
    const refused = await proxy.POST(new Request(`${SITE}/api/gas-proxy`, {
      method: "POST", headers: { "content-type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "submitFeedback" }),
    }));
    assert.equal(refused.status, 503);
    assert.match(refused.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await refused.json(), { ok: false, error: MAINTENANCE_MESSAGE, maintenance: true });
    assert.equal((await proxy.GET(new Request(`${SITE}/api/gas-proxy`))).status, 405);

    // A read goes on to Apps Script, carrying Vercel's request ID as Netlify's.
    process.env.MAINTENANCE_MODE = "";
    const realFetch = globalThis.fetch;
    let sent;
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true, data: [] }));
    };
    try {
      const reply = await proxy.POST(new Request(`${SITE}/api/gas-proxy`, {
        method: "POST", headers: { "x-vercel-id": "sin1::abc-123" }, body: JSON.stringify({ action: "getActivityData" }),
      }));
      assert.deepEqual(await reply.json(), { ok: true, data: [] });
      assert.deepEqual(sent.requestContext, { requestId: "sin1::abc-123" });
    } finally {
      globalThis.fetch = realFetch;
    }
  }));

test("Apps Script's JSON requests reach the worker endpoint exactly as sent", () =>
  withEnv({ WORKER_TOKEN: "w".repeat(96), SUPABASE_DB_URL: "" }, async () => {
    const call = (authorization) => worker.POST(new Request(`${SITE}/api/worker`, {
      method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ action: "workerPing" }),
    }));
    assert.equal((await call()).status, 401);
    const configured = await call(`Bearer ${"w".repeat(96)}`);
    assert.deepEqual(await configured.json(), { ok: false, error: "The database is not configured. Set SUPABASE_DB_URL in the site's environment variables." });
  }));

test("REDIRECT_TO turns a Netlify site into a permanent redirect, so old QR codes keep verifying", async () => {
  const { execFile } = await import("node:child_process");
  const { mkdtempSync, readFileSync: read, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { promisify } = await import("node:util");
  const dir = mkdtempSync(join(tmpdir(), "headers-test-"));
  const emit = (REDIRECT_TO) => promisify(execFile)(process.execPath, ["scripts/headers.mjs", "emit", "--force"], {
    env: { PATH: process.env.PATH, HEADERS_DIST_DIR: dir, REDIRECT_TO } }).catch((error) => error);
  try {
    await emit("https://ched-feedback-survey.vercel.app/");
    assert.equal(read(join(dir, "_redirects"), "utf8"), "/*  https://ched-feedback-survey.vercel.app/:splat  301!\n");
    assert.ok(read(join(dir, "_headers"), "utf8").includes("Content-Security-Policy"));
    const refused = await emit("ched-feedback-survey.vercel.app/admin");
    assert.equal(refused.code, 1, "only a plain https:// address is accepted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
