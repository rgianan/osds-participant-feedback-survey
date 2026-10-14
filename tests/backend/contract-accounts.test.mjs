import { test } from "node:test";
import assert from "node:assert/strict";
import { PROXY_TOKEN, QUESTIONS, appsScript, flatQuestions, json, newBackend, withoutKeys } from "./contract-harness.mjs";

/**
 * Contract tests for the last six actions: users, survey questions, the
 * audit log and signature uploads. Same pattern as the others: the same
 * requests to the real Code.gs and to the new backend, the same replies and
 * the same data afterwards.
 */

const dropIds = (reply) => (reply.ok ? { ...reply, data: withoutKeys([reply.data], "user_id", "created_at", "updated_at")[0] } : reply);

test("contract: Users", async () => {
  const apps = appsScript();
  const next = await newBackend();
  const both = async (who, gasCall, request) => {
    apps.as(who);
    next.as(who);
    return [await request(), gasCall()];
  };
  const listsMatch = async (what) => {
    apps.as("boss");
    next.as("boss");
    // New accounts get a random user ID, and every save stamps today's date:
    // compared separately below.
    assert.deepEqual(withoutKeys(await next.call("adminGetUsers"), "user_id", "created_at", "updated_at"),
      withoutKeys(json(apps.gas.adminGetUsers("tok")), "user_id", "created_at", "updated_at"), `users after: ${what}`);
  };

  const [refused, gasRefused] = await both("helper", () => apps.run("adminGetUsers", "tok"), () => next.reply("adminGetUsers"));
  assert.deepEqual(refused, gasRefused);
  assert.equal(refused.error, "Forbidden: superadmin access required.");

  apps.as("boss");
  next.as("boss");
  assert.deepEqual(await next.call("adminGetUsers"), json(apps.gas.adminGetUsers("tok")), "the full list, IDs and dates included");

  const saves = [
    ["a new account with a short password", { email: "carol@example.com", name: "Carol", role: "admin", password: "short" }],
    ["a new account", { email: "Carol@Example.com", name: "Carol Diaz", role: "admin", password: "a long enough password", active: true }],
    ["promote an account", { email: "helper@example.com", name: "Helper", role: "superadmin" }],
    ["demote yourself", { email: "boss@example.com", name: "Boss", role: "admin" }],
    ["deactivate yourself", { email: "boss@example.com", name: "Boss", role: "superadmin", active: "false" }],
    ["deactivate an account", { email: "helper@example.com", name: "Helper", role: "admin", active: false }],
    ["a short new password", { email: "helper@example.com", name: "Helper", role: "admin", password: "short" }],
    ["no name", { email: "dan@example.com", name: " ", role: "admin", password: "a long enough password" }],
    ["a bad email", { email: "dan@example", name: "Dan", role: "admin", password: "a long enough password" }],
    ["an unknown role", { email: "dan@example.com", name: "Dan", role: "owner", password: "a long enough password" }],
  ];
  for (const [what, payload] of saves) {
    const [actual, expected] = await both("boss", () => apps.run("adminSaveUser", payload, "tok"), () => next.reply("adminSaveUser", { payload }));
    assert.deepEqual(dropIds(actual), dropIds(expected), `reply: ${what}`);
    await listsMatch(what);
  }
  const users = await next.call("adminGetUsers");
  assert.equal(users.find((u) => u.email === "helper@example.com").user_id, "U-HELP0001", "existing accounts keep their IDs");
  assert.match(users.find((u) => u.email === "carol@example.com").user_id, /^U-[0-9a-f]{8}$/, "new accounts get one in the same form");
});

test("contract: survey questions", async () => {
  const apps = appsScript();
  const next = await newBackend();
  apps.as("helper");
  assert.deepEqual(await next.reply("adminGetQuestions"), apps.run("adminGetQuestions", "tok"), "an admin who is not a superadmin");

  apps.as("boss");
  next.as("boss");
  assert.deepEqual(flatQuestions(await next.call("adminGetQuestions")), flatQuestions(json(apps.gas.adminGetQuestions("tok"))));

  const edited = QUESTIONS.map((text, i) => ({ text, type: i === 13 ? "yesno" : i === 14 ? "text" : "rating" }));
  edited[0] = "  The objectives were clear.  "; // a plain string, as older clients sent
  edited[2] = { text: "The speakers explained things well.", type: "rating" };
  edited[6] = { text: "What would you change?", type: "Long Text" };
  edited[9] = { text: "Was registration easy?", type: "Yes/No" };
  for (const [what, questions] of [
    ["an edit", edited],
    ["14 questions", edited.slice(0, 14)],
    ["a blank question", edited.map((q, i) => (i === 4 ? { text: " ", type: "rating" } : q))],
  ]) {
    assert.deepEqual(await next.reply("adminSaveQuestions", { questions }), apps.run("adminSaveQuestions", structuredClone(questions), "tok"), `reply: ${what}`);
    assert.deepEqual(flatQuestions(await next.call("adminGetQuestions")), flatQuestions(json(apps.gas.adminGetQuestions("tok"))), `editor after: ${what}`);
    assert.deepEqual(flatQuestions(await next.call("getQuestions")), flatQuestions(json(apps.gas.getQuestions())), `survey after: ${what}`);
  }
});

test("contract: the audit log, filtered and verified", async () => {
  const apps = appsScript();
  const next = await newBackend();
  apps.as("helper");
  assert.deepEqual(await next.reply("adminGetAuditLog", { filters: {} }), apps.run("adminGetAuditLog", {}, "tok"));

  apps.as("boss");
  next.as("boss");
  for (const filters of [{}, { action: "login" }, { outcome: "FAILURE" }, { query: "HELPER" }, { limit: 25 }, { limit: "all" }])
    assert.deepEqual(await next.call("adminGetAuditLog", { filters }), json(apps.gas.adminGetAuditLog(filters, "tok")), JSON.stringify(filters));
  assert.equal((await next.call("adminGetAuditLog", { filters: {} })).integrity.valid, true);

  // The latest entries deleted: the recorded head no longer matches.
  apps.properties.set("AUDIT_HEAD_HASH", "not-the-last-entry");
  await next.db.query(`update portal.settings set value = 'not-the-last-entry' where key = 'audit_head_hash'`);
  const tampered = await next.call("adminGetAuditLog", { filters: {} });
  assert.deepEqual(tampered, json(apps.gas.adminGetAuditLog({}, "tok")));
  assert.deepEqual(tampered.integrity, { valid: false, checkedRows: 4 });
});

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

test("contract: a signature upload lands in Drive exactly as Apps Script saves it", async () => {
  const direct = appsScript();
  const relay = appsScript();
  const next = await newBackend({ appsScript: relay });
  const file = { filename: "signature.png", mimeType: "image/png", base64: png };
  const expected = direct.run("adminUploadSignature", structuredClone(file), "tok");
  const actual = await next.reply("adminUploadSignature", { payload: file });
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.data, { id: "drive-1", name: "signature.png", url: "https://drive.google.com/file/d/drive-1/view" });
  assert.deepEqual(relay.drive, direct.drive, "the same bytes, type and name reach Drive");

  for (const [what, bad] of [
    ["no file", {}],
    ["a PDF", { ...file, mimeType: "application/pdf" }],
    ["over 2 MB", { ...file, base64: "A".repeat(2800001) }],
  ])
    assert.deepEqual(await next.reply("adminUploadSignature", { payload: bad }), direct.run("adminUploadSignature", bad, "tok"), what);
  assert.equal(relay.drive.length, 1, "a refused file never reaches Apps Script");
});

test("the worker action cannot be reached without the worker token, even through the proxy", async () => {
  const apps = appsScript();
  const file = { filename: "signature.png", mimeType: "image/png", base64: png };
  // What gas-proxy forwards for any browser: the proxy token, nothing more.
  assert.deepEqual(apps.post({ action: "workerUploadSignature", proxyToken: PROXY_TOKEN, payload: file }),
    { ok: false, error: "Forbidden: invalid worker token." });
  assert.deepEqual(apps.post({ action: "workerUploadSignature", proxyToken: PROXY_TOKEN, workerToken: "guess", payload: file }),
    { ok: false, error: "Forbidden: invalid worker token." });
  assert.equal(apps.drive.length, 0);

  const next = await newBackend({ appsScript: apps });
  next.useWorkerToken("stale-token");
  assert.deepEqual(await next.reply("adminUploadSignature", { payload: file }), { ok: false, error: "Forbidden: invalid worker token." },
    "a wrong WORKER_TOKEN in Netlify is reported, not hidden");
});
