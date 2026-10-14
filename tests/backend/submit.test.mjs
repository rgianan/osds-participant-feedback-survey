import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAction } from "../../netlify/backend/actions.mjs";
import { freshDatabase, seedActivity, seedQuestions } from "./helpers.mjs";

const NOW = new Date("2026-08-24T02:00:00Z"); // 10:00 on 24 Aug in Manila
const submit = (db, form, now = NOW) =>
  handleAction({ action: "submitFeedback", payload: form }, { db, now }).then((reply) => {
    assert.equal(reply.ok, true, reply.error);
    return reply.data;
  });

const form = (activity, overrides = {}) => ({
  name: "  Ana Reyes ", email: " Ana@Example.com ", sex: "Female", age: "30",
  activityId: activity.code, title: "anything the browser says", venue: "anywhere",
  ...Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`answer${i + 1}`, 5 - (i % 5)])),
  answer15: "More hands-on sessions, please.",
  takeaways: "x".repeat(2500), suggestions: "",
  ...overrides,
});

test("a submission is queued with its answers tied to their questions", async () => {
  const { db } = await freshDatabase();
  const questionIds = await seedQuestions(db);
  const activity = await seedActivity(db, { title: "Leadership Forum", from_date: "2026-08-24", to_date: "2026-08-26" });

  const reply = await submit(db, form(activity, { answer3: "" }));
  assert.equal(reply.status, "QUEUED");
  assert.equal(reply.message, "Feedback received. Your certificate will be emailed after processing.");

  const [row] = await db.query(
    `select id::int as id, name, email, age, activity_title, activity_date, venue, length(takeaways)::int as takeaways,
            certificate_status::text as status, verification_code
       from portal.responses`,
  );
  assert.equal(reply.queueRow, row.id);
  assert.deepEqual({ ...row, id: undefined, verification_code: undefined }, {
    id: undefined, verification_code: undefined,
    name: "Ana Reyes", email: "Ana@Example.com", age: 30, status: "pending", takeaways: 2000,
    // From the activity record, not from what the browser sent.
    activity_title: "Leadership Forum", activity_date: "2026-08-24 – 2026-08-26", venue: "CHED Auditorium",
  });
  assert.match(row.verification_code, /^CHED-[A-F0-9]{20}$/);

  const answers = await db.query(`select question_id::text as q, value from portal.answers where response_id = $1`, [row.id]);
  const byQuestion = Object.fromEntries(answers.map((a) => [a.q, a.value]));
  assert.equal(answers.length, 14, "the blank answer to question 3 is not stored");
  assert.equal(byQuestion[questionIds[0]], "5");
  assert.equal(byQuestion[questionIds[1]], "4");
  assert.equal(byQuestion[questionIds[2]], undefined);
  assert.equal(byQuestion[questionIds[14]], "More hands-on sessions, please.");
});

test("the honeypot is answered 'received' and nothing is stored", async () => {
  const { db } = await freshDatabase();
  const activity = await seedActivity(db);
  assert.deepEqual(await submit(db, form(activity, { website: "http://spam" })), { status: "QUEUED", message: "Feedback received." });
  assert.equal((await db.query(`select count(*)::int as n from portal.responses`))[0].n, 0);
});

test("validation messages match Code.gs, checked in the same order", async () => {
  const { db } = await freshDatabase();
  const activity = await seedActivity(db);
  const bad = (overrides) => submit(db, form(activity, overrides));
  assert.deepEqual(await bad({ activityId: "", title: "" }), { status: "BAD_REQUEST", message: "Activity selection is required." });
  assert.deepEqual(await bad({ name: " " }), { status: "BAD_REQUEST", message: "Name is required." });
  assert.deepEqual(await bad({ name: "n".repeat(161) }), { status: "BAD_REQUEST", message: "Name is required." });
  assert.deepEqual(await bad({ email: "ana@example" }), { status: "BAD_REQUEST", message: "A valid email is required." });
  assert.deepEqual(await bad({ sex: "" }), { status: "BAD_REQUEST", message: "Sex is required." });
  assert.deepEqual(await bad({ age: "0" }), { status: "BAD_REQUEST", message: "Age must be between 1 and 120." });
  assert.deepEqual(await bad({ age: "121" }), { status: "BAD_REQUEST", message: "Age must be between 1 and 120." });
  assert.deepEqual(await bad({ activityId: "A-nope", title: "" }),
    { status: "BAD_REQUEST", message: "Selected activity not found. Please re-select the activity." });
});

test("the same email cannot submit twice for one activity, unless the first certificate failed", async () => {
  const { db } = await freshDatabase();
  const activity = await seedActivity(db);
  assert.equal((await submit(db, form(activity))).status, "QUEUED");
  assert.deepEqual(await submit(db, form(activity, { email: "ana@example.com", name: "Someone Else" })), { status: "DUP", by: "email" });
  // Same name, different email: two different people.
  assert.equal((await submit(db, form(activity, { email: "ana.reyes@example.com" }))).status, "QUEUED");
  await db.query(`update portal.responses set certificate_status = 'failed' where lower(email) = 'ana@example.com'`);
  assert.equal((await submit(db, form(activity))).status, "QUEUED");
});

test("two submissions at the same moment: the database lets one through and the other is DUP", async () => {
  const { db } = await freshDatabase();
  const activity = await seedActivity(db);
  await submit(db, form(activity));
  // Pretend the duplicate check ran before the first submission was saved,
  // so the second one reaches the insert and meets the unique index.
  const racing = {
    ...db,
    query: (text, params) => (/certificate_status <> 'failed' limit 1/.test(text) ? Promise.resolve([]) : db.query(text, params)),
  };
  assert.deepEqual(await submit(racing, form(activity)), { status: "DUP", by: "email" });
  assert.equal((await db.query(`select count(*)::int as n from portal.responses`))[0].n, 1);
});

test("ended or out-of-window activities answer CLOSED with Code.gs's wording", async () => {
  const { db } = await freshDatabase();
  const ended = await seedActivity(db, { active: false });
  const later = await seedActivity(db, { from_date: "2026-09-01", to_date: "2026-09-02" });
  const past = await seedActivity(db, { from_date: "2026-08-01", to_date: "2026-08-02" });
  assert.deepEqual(await submit(db, form(ended)), {
    status: "CLOSED", message: "This activity has been closed by its organizer. Feedback is no longer being collected.",
  });
  assert.deepEqual(await submit(db, form(later)), { status: "CLOSED", message: "Feedback for this activity opens on 2026-09-01." });
  assert.deepEqual(await submit(db, form(past)), { status: "CLOSED", message: "The feedback period for this activity has ended." });
});

test("an activity can still be found by title when no code is sent", async () => {
  const { db } = await freshDatabase();
  await seedActivity(db, { title: "Leadership Forum" });
  const reply = await submit(db, { ...form({ code: "" }), activityId: "", title: "leadership forum" });
  assert.equal(reply.status, "QUEUED");
});
