import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACTIONS, HANDLERS, handleAction } from "../../netlify/backend/actions.mjs";
import { freshDatabase, seedActivity, seedResponse } from "./helpers.mjs";

const call = (db, body, now = new Date("2026-08-24T02:00:00Z")) => handleAction(body, { db, now });

test("getActivityData lists only activities that are on and open today in Manila", async () => {
  const { db } = await freshDatabase();
  const today = await seedActivity(db, { code: "A-today", title: "Forum", from_date: "2026-08-24", to_date: "2026-08-24" });
  await seedActivity(db, { code: "A-week", title: "Workshop", from_date: "2026-08-20", to_date: "2026-08-26" });
  await seedActivity(db, { code: "A-later", from_date: "2026-09-01", to_date: "2026-09-01" });
  await seedActivity(db, { code: "A-ended", from_date: "2026-08-24", to_date: "2026-08-24", active: false });

  const reply = await call(db, { action: "getActivityData" });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.data, [
    { id: "A-today", title: "Forum", venue: "CHED Auditorium", date: "2026-08-24" },
    { id: "A-week", title: "Workshop", venue: "CHED Auditorium", date: "2026-08-20 – 2026-08-26" },
  ]);
  assert.ok(today.id, "seeded");
});

test("the feedback day follows Manila's calendar, not the server's", async () => {
  const { db } = await freshDatabase();
  await seedActivity(db, { code: "A-24", from_date: "2026-08-24", to_date: "2026-08-24" });
  // 23:30 on 23 Aug in Manila: not open yet. 00:30 on 24 Aug: open.
  assert.deepEqual((await call(db, { action: "getActivityData" }, new Date("2026-08-23T15:30:00Z"))).data, []);
  assert.equal((await call(db, { action: "getActivityData" }, new Date("2026-08-23T16:30:00Z"))).data.length, 1);
  // 23:59 on 24 Aug is still the last day; 00:01 on 25 Aug is closed.
  assert.equal((await call(db, { action: "getActivityData" }, new Date("2026-08-24T15:59:00Z"))).data.length, 1);
  assert.deepEqual((await call(db, { action: "getActivityData" }, new Date("2026-08-24T16:01:00Z"))).data, []);
});

test("getQuestions serves named sections in order, each with its live questions and their IDs", async () => {
  const { db } = await freshDatabase();
  const [second] = await db.query(`insert into portal.survey_sections (name, position) values ('Event experience', 2) returning id`);
  const [first] = await db.query(`insert into portal.survey_sections (name, position) values ('Program content', 1) returning id`);
  await db.query(`insert into portal.survey_sections (name, position) values ('Not filled in yet', 3)`);
  await db.query(
    `insert into portal.questions (section_id, position, text, type, retired_at) values
       ($1, 1, 'The venue supported learning.', 'rating', null),
       ($2, 2, 'Would you attend again?', 'yesno', null),
       ($2, 1, 'The objectives were clear.', 'rating', null),
       ($2, 3, 'An old question.', 'text', now())`,
    [second.id, first.id],
  );
  const { data } = await call(db, { action: "getQuestions" });
  const shape = data.sections.map((s) => [s.name, s.questions.map((q) => [q.text, q.type])]);
  assert.deepEqual(shape, [
    ["Program content", [["The objectives were clear.", "rating"], ["Would you attend again?", "yesno"]]],
    ["Event experience", [["The venue supported learning.", "rating"]]],
  ], "retired questions and empty sections are left out");
  for (const question of data.sections.flatMap((s) => s.questions)) assert.match(question.id, /^[0-9a-f-]{36}$/);
});

test("verifyCertificate answers for issued certificates only", async () => {
  const { db } = await freshDatabase();
  const activity = await seedActivity(db);
  const issued = await seedResponse(db, activity, {
    status: "issued", certificate_url: "https://drive.google.com/file/d/x", emailed_at: "2026-08-24T02:15:00Z",
  });
  const pending = await seedResponse(db, activity, { email: "bo@example.com" });

  assert.deepEqual((await call(db, { action: "verifyCertificate", code: issued.code.toLowerCase() })).data, {
    valid: true,
    verificationCode: issued.code,
    name: "Ana Reyes",
    activity: "Leadership Forum",
    activityDate: "2026-08-24",
    venue: "CHED Auditorium",
    issuedAt: "2026-08-24 10:15",
    certificateUrl: "https://drive.google.com/file/d/x",
  });
  assert.deepEqual((await call(db, { action: "verifyCertificate", code: pending.code })).data, { valid: false });
});

test("a malformed verification code never reaches the database", async () => {
  let queries = 0;
  const db = { query: async () => { queries++; return []; } };
  assert.deepEqual((await call(db, { action: "verifyCertificate", code: "' or 1=1 --" })).data, { valid: false });
  assert.equal(queries, 0);
});

test("every action Code.gs's doPost accepts has a handler here", () => {
  const code = readFileSync(new URL("../../google-apps-script/Code.gs", import.meta.url), "utf8");
  const doPost = code.slice(code.indexOf("function doPost("), code.indexOf("function jsonResponse_("));
  // workerUploadSignature is the reverse direction: the new backend calls it.
  const gasActions = [...doPost.matchAll(/action === '(\w+)'/g)].map((m) => m[1]).filter((a) => a !== "workerUploadSignature");
  assert.equal(gasActions.length, 22);
  assert.deepEqual([...HANDLERS.keys()].sort(), [...gasActions].sort());
  assert.deepEqual([...ACTIONS].sort(), [...gasActions].sort());
});

test("unknown actions say so; errors become {ok:false}", async () => {
  const { db } = await freshDatabase();
  assert.deepEqual(await call(db, { action: "toString" }), { ok: false, error: "Unknown action: toString" });
  const broken = { query: async () => { throw new Error("connection refused"); } };
  assert.deepEqual(await call(broken, { action: "getActivityData" }), { ok: false, error: "connection refused" });
});
