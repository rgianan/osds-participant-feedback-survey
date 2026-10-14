import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAction } from "../../netlify/backend/actions.mjs";
import { freshDatabase, seedActivity, seedAdmin, seedQuestions, seedSession } from "./helpers.mjs";

const NOW = new Date("2026-08-24T02:00:00Z"); // 10:00 on 24 Aug in Manila
const BOSS = "tok-boss";
const HELPER = "tok-helper";

async function call(db, action, token, extra = {}) {
  const reply = await handleAction({ action, adminToken: token, ...extra }, { db, now: NOW });
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

/**
 * Two activities and three responses, small enough that every number below
 * can be checked by hand. Questions 1-13 are 1-5 ratings, 14 is yes/no and 15
 * is written.
 *   R1  Forum     all 5s, "Yes", written answer   issued
 *   R2  Forum     all 4s, "No",  no written answer failed
 *   R3  Workshop  all 1s, "yes", written answer   pending, Workshop since ended
 */
async function fixture() {
  const { db } = await freshDatabase();
  await seedQuestions(db, 15, { 14: "yesno" });
  await seedAdmin(db, { email: "boss@example.com", role: "superadmin", hash: "x" });
  await seedAdmin(db, { email: "helper@example.com", name: "Helper", role: "admin", hash: "x" });
  await seedSession(db, "boss@example.com", BOSS);
  await seedSession(db, "helper@example.com", HELPER);
  const forum = await seedActivity(db, { code: "A-FORUM", title: "Leadership Forum" });
  const workshop = await seedActivity(db, { code: "A-WORK", title: "Data Workshop", from_date: "2026-08-20", to_date: "2026-08-26" });
  await db.query(`update portal.activities set created_by = 'helper@example.com' where code = 'A-FORUM'`);
  await db.query(`update portal.activities set created_by = 'boss@example.com' where code = 'A-WORK'`);

  const submit = async (activity, email, rating, yesNo, written) => {
    const answers = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`answer${i + 1}`, rating]));
    const reply = await handleAction({ action: "submitFeedback", payload: {
      name: email.split("@")[0], email, sex: "Female", age: "30", activityId: activity.code,
      ...answers, answer14: yesNo, answer15: written,
    } }, { db, now: NOW });
    return reply.data.queueRow;
  };
  const r1 = await submit(forum, "ana@example.com", 5, "Yes", "Great sessions");
  const r2 = await submit(forum, "bo@example.com", 4, "No", "");
  const r3 = await submit(workshop, "cy@example.com", 1, "yes", "Too long");
  await db.query(
    `update portal.responses set certificate_status = 'issued', certificate_url = 'https://drive/r1',
            emailed_at = '2026-08-24T02:30:00Z' where id = $1`, [r1]);
  await db.query(
    `update portal.responses set certificate_status = 'failed', certificate_error = 'No certificate template' where id = $1`, [r2]);
  await db.query(`update portal.activities set active = false where code = 'A-WORK'`);
  return { db, forum, workshop, r1, r2, r3 };
}

test("every admin screen refuses a missing or expired session", async () => {
  const { db } = await fixture();
  await seedSession(db, "boss@example.com", "tok-old", "2026-01-01T00:00:00Z");
  for (const action of ["adminGetActivities", "adminGetResponses", "adminGetCertificateQueue", "adminGetFeedbackAnalytics", "adminGetDashboard"])
    for (const token of ["", "tok-unknown", "tok-old"])
      assert.deepEqual(await handleAction({ action, adminToken: token }, { db, now: NOW }),
        { ok: false, error: "Forbidden: administrator authorization required." }, `${action} with "${token}"`);
});

test("activities: the same fields as Apps Script, permanent IDs, and who may manage each", async () => {
  const { db } = await fixture();
  const asHelper = await call(db, "adminGetActivities", HELPER);
  assert.deepEqual(asHelper.map((a) => [a.activityId, a.active, a.windowOpen, a.canManage]), [
    ["A-FORUM", true, true, true], // the helper created it
    ["A-WORK", false, true, false], // ended, but today is still inside its dates; the boss created it
  ]);
  const forum = asHelper[0];
  assert.match(forum.id, /^[0-9a-f-]{36}$/, "a permanent ID, not a sheet row number");
  assert.deepEqual({ ...forum, id: undefined, Timestamp: undefined }, {
    id: undefined, Timestamp: undefined,
    title: "Leadership Forum", venue: "CHED Auditorium", fromDate: "2026-08-24", toDate: "2026-08-24",
    template: "", inCharge: "", region: "", signatoryDesignation: "", signature: "", givenDate: "",
    activityId: "A-FORUM", createdBy: "helper@example.com", active: true, windowOpen: true, canManage: true,
  });
  assert.match(forum.Timestamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.deepEqual((await call(db, "adminGetActivities", BOSS)).map((a) => a.canManage), [true, true], "a superadmin manages all");
});

test("responses: newest first, 15 numbered answers, and the same filters", async () => {
  const { db, r1, r2, r3 } = await fixture();
  const all = await call(db, "adminGetResponses", HELPER, { filters: {} });
  assert.equal(all.total, 3);
  assert.deepEqual(all.entries.map((e) => e.row), [r3, r2, r1]);

  const first = all.entries.find((e) => e.row === r1);
  assert.equal(first.answers.length, 15);
  const shown = (answer) => ({ ...answer, questionId: undefined });
  assert.deepEqual(shown(first.answers[0]), { number: 1, type: "rating", value: "5", questionId: undefined,
    question: "Question 1", section: "Program content", retired: false });
  assert.deepEqual(shown(first.answers[13]), { number: 14, type: "yesno", value: "Yes", questionId: undefined,
    question: "Question 14", section: "Overall reflection", retired: false });
  assert.deepEqual(shown(first.answers[14]), { number: 15, type: "text", value: "Great sessions", questionId: undefined,
    question: "Question 15", section: "Overall reflection", retired: false });
  assert.equal(first.averageRating, 5, "only the 13 rating answers are averaged");
  assert.equal(first.certificateState, "ISSUED");
  assert.equal(first.emailSent, "2026-08-24 10:30");
  assert.equal(first.certificateUrl, "https://drive/r1");
  assert.match(first.submittedAt, /^2026-08-24 10:00$/);
  assert.equal(all.entries.find((e) => e.row === r2).answers[14].value, "", "an unanswered question reads blank");
  assert.equal(all.entries.find((e) => e.row === r2).certificateError, "No certificate template");

  const rows = async (filters) => (await call(db, "adminGetResponses", HELPER, { filters })).entries.map((e) => e.row);
  assert.deepEqual(await rows({ activityId: "a-forum" }), [r2, r1], "the activity filter ignores case");
  assert.deepEqual(await rows({ state: "FAILED" }), [r2]);
  assert.deepEqual(await rows({ state: "QUEUED" }), [r3]);
  assert.deepEqual(await rows({ query: "WORKSHOP" }), [r3], "the search covers name, email, activity and code");
  assert.deepEqual(await rows({ query: "bo@exa" }), [r2]);
  assert.deepEqual(await rows({ state: "NONSENSE" }), []);
});

test("certificates: tab counts, one tab's rows, and activities whose certificates are held", async () => {
  const { db, r2, r3 } = await fixture();
  const failed = await call(db, "adminGetCertificateQueue", HELPER, { filters: {} });
  assert.deepEqual(failed.counts, { QUEUED: 1, PROCESSING: 0, ISSUED: 1, FAILED: 1 });
  assert.deepEqual(failed.entries.map((e) => [e.row, e.state, e.error, e.held]), [[r2, "FAILED", "No certificate template", false]]);
  assert.deepEqual(failed.heldActivities, ["Data Workshop"], "queued for an ended activity");

  const queued = await call(db, "adminGetCertificateQueue", HELPER, { filters: { state: "QUEUED" } });
  assert.deepEqual(queued.entries.map((e) => [e.row, e.held, e.title]), [[r3, true, "Data Workshop"]]);

  const forumOnly = await call(db, "adminGetCertificateQueue", HELPER, { filters: { activityId: "A-FORUM", state: "ISSUED" } });
  assert.deepEqual(forumOnly.counts, { QUEUED: 0, PROCESSING: 0, ISSUED: 1, FAILED: 1 }, "counts follow the activity filter");
  assert.deepEqual(forumOnly.heldActivities, []);
  assert.equal(forumOnly.entries[0].emailSent, "2026-08-24 10:30");
});

test("analytics for one activity, checked against hand-worked numbers", async () => {
  const { db } = await fixture();
  const forum = await call(db, "adminGetFeedbackAnalytics", HELPER, { activityId: "A-FORUM" });
  assert.deepEqual({ ...forum, questions: undefined }, {
    questions: undefined,
    scope: "A-FORUM",
    totalResponses: 2,
    averageScore: 4.5, // (13×5 + 13×4) / 26
    overallAverage: 3.33, // (13×5 + 13×4 + 13×1) / 39
    overallResponses: 3,
    scoreDelta: 1.17,
    completionRate: 50, // R2 left question 15 blank
    certificateIssueRate: 50,
    positiveRate: 100,
    certificates: { queued: 0, processing: 0, issued: 1, failed: 1 },
    distribution: [0, 0, 0, 13, 13],
  });
  assert.equal(forum.questions.length, 15);
  const score = ({ label, type, responses, average, yesRate, text, retired }) => ({ label, type, responses, average, yesRate, text, retired });
  assert.deepEqual(score(forum.questions[0]), { label: "Question 1", type: "rating", responses: 2, average: 4.5, yesRate: 0, text: "Question 1", retired: false });
  assert.deepEqual(score(forum.questions[13]), { label: "Question 14", type: "yesno", responses: 2, average: 0, yesRate: 50, text: "Question 14", retired: false });
  assert.deepEqual(score(forum.questions[14]), { label: "Question 15", type: "text", responses: 0, average: 0, yesRate: 0, text: "Question 15", retired: false });
});

test("analytics across every activity, and the empty case Apps Script returns", async () => {
  const { db } = await fixture();
  const all = await call(db, "adminGetFeedbackAnalytics", HELPER, { activityId: "" });
  assert.equal(all.scope, "all");
  assert.equal(all.averageScore, 3.33);
  assert.equal(all.scoreDelta, 0);
  assert.equal(all.completionRate, 66.7);
  assert.equal(all.positiveRate, 66.7); // 26 of 39 ratings are 4 or 5
  assert.deepEqual(all.distribution, [13, 0, 0, 13, 13]);
  assert.equal(all.questions[13].yesRate, 66.7, '"Yes" and "yes" both count');
  assert.equal((await call(db, "adminGetFeedbackAnalytics", HELPER, { activityId: "a-forum" })).totalResponses, 0,
    "the activity code is matched exactly, as in Apps Script");

  const empty = await freshDatabase();
  await seedAdmin(empty.db, { email: "boss@example.com", hash: "x" });
  await seedSession(empty.db, "boss@example.com", BOSS);
  assert.deepEqual(await call(empty.db, "adminGetFeedbackAnalytics", BOSS), {
    totalResponses: 0, averageScore: 0, completionRate: 0,
    certificates: { queued: 0, processing: 0, issued: 0, failed: 0 }, distribution: [0, 0, 0, 0, 0], questions: [],
  });
});

test("the dashboard returns both halves in one request, analytics following its filter", async () => {
  const { db } = await fixture();
  const dashboard = await call(db, "adminGetDashboard", HELPER, { filters: { activityId: "A-FORUM" } });
  assert.equal(dashboard.activities.length, 2);
  assert.equal(dashboard.analytics.scope, "A-FORUM");
  assert.equal(dashboard.analytics.totalResponses, 2);
});
