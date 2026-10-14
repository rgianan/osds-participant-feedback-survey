import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAction } from "../../netlify/backend/actions.mjs";
import { freshDatabase, seedActivity, seedAdmin, seedQuestions, seedSession } from "./helpers.mjs";

/** Phase 1b: named sections, 1 to 30 questions, answers kept with their question. */

const start = new Date("2026-08-24T01:00:00Z");
const later = (minutes) => new Date(start.getTime() + minutes * 60e3);

async function setup() {
  const { db } = await freshDatabase();
  await seedQuestions(db, 15, { 14: "yesno" });
  await seedAdmin(db, { email: "boss@example.com", role: "superadmin", hash: "x" });
  await seedSession(db, "boss@example.com", "tok");
  const activity = await seedActivity(db, { code: "A-FORUM" });
  const as = (now) => ({ db, now, secrets: { auditSecret: "audit-secret" } });
  const admin = async (action, extra, now) => {
    const reply = await handleAction({ action, adminToken: "tok", ...extra }, as(now));
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  };
  const editor = (now) => admin("adminGetQuestions", {}, now);
  const save = (sections, now) => admin("adminSaveQuestions", { questions: { sections } }, now);
  // A participant who loads the survey and answers every question on it, by ID, as the survey page does.
  const participant = async (email, now, value = (q, i) => (q.type === "yesno" ? "Yes" : q.type === "text" ? `Note ${i + 1}` : String((i % 5) + 1))) => {
    const survey = (await handleAction({ action: "getQuestions" }, as(now))).data;
    const questions = survey.sections.flatMap((s) => s.questions);
    const answers = Object.fromEntries(questions.map((q, i) => [q.id, value(q, i)]));
    const reply = await handleAction({ action: "submitFeedback", payload: {
      name: email, email, sex: "Female", age: "30", activityId: activity.code, answers } }, as(now));
    assert.equal(reply.data?.status, "QUEUED", reply.error || JSON.stringify(reply.data));
    return { survey, answers };
  };
  const responseOf = async (email, now) =>
    (await admin("adminGetResponses", { filters: { query: email } }, now)).entries[0];
  return { db, admin, editor, save, participant, responseOf };
}

const shapeOf = (survey) => survey.sections.map((s) => [s.name, s.questions.length]);

test("phase 1b exit test: cut to 7 questions in 2 sections, grown to 22 in 4, every older response keeps its answers", async () => {
  const { editor, save, participant, responseOf, admin } = await setup();

  // 1. Fifteen questions in three sections; Ana answers all of them.
  const fifteen = await participant("ana@example.com", later(0));
  assert.deepEqual(shapeOf(fifteen.survey), [["Program content", 5], ["Event experience", 5], ["Overall reflection", 5]]);

  // 2. Cut to 7 questions in 2 sections: keep 1-4 (rewording 2), and 8, 14, 15.
  const before = await editor(later(1));
  const q = before.sections.flatMap((s) => s.questions);
  await save([
    { id: before.sections[0].id, name: "Content", questions: [q[0], { ...q[1], text: "Question 2, reworded" }, q[2], q[3]] },
    { name: "Wrap-up", questions: [q[7], q[13], q[14]] },
  ], later(2));
  const seven = await participant("bo@example.com", later(3));
  assert.deepEqual(shapeOf(seven.survey), [["Content", 4], ["Wrap-up", 3]]);

  // 3. Grow to 22 in 4 sections.
  const cut = await editor(later(4));
  const fresh = (n, prefix) => Array.from({ length: n }, (_, i) => ({ text: `${prefix} ${i + 1}`, type: i % 4 === 3 ? "text" : "rating" }));
  await save([
    { ...cut.sections[0], questions: [...cut.sections[0].questions, ...fresh(3, "Content extra")] },
    { name: "Speakers", questions: fresh(6, "Speaker") },
    { name: "Venue", questions: fresh(6, "Venue") },
    cut.sections[1],
  ], later(5));
  const twentyTwo = await participant("cy@example.com", later(6));
  assert.deepEqual(shapeOf(twentyTwo.survey), [["Content", 7], ["Speakers", 6], ["Venue", 6], ["Wrap-up", 3]]);

  // 4. Every response still shows every answer it gave, each under the question it answered.
  for (const [email, given] of [["ana@example.com", fifteen], ["bo@example.com", seven], ["cy@example.com", twentyTwo]]) {
    const response = await responseOf(email, later(7));
    const stored = Object.fromEntries(response.answers.filter((a) => a.value).map((a) => [a.questionId, a.value]));
    assert.deepEqual(stored, given.answers, `${email}: all of their answers, by question`);
  }
  const ana = await responseOf("ana@example.com", later(7));
  const anaAnswer = (text) => ana.answers.find((a) => a.question === text);
  assert.equal(anaAnswer("Question 2, reworded").value, "2", "a reworded question keeps its answers");
  assert.deepEqual({ ...anaAnswer("Question 5"), questionId: undefined }, {
    number: null, type: "rating", value: "5", questionId: undefined, question: "Question 5", section: "Content", retired: true,
  }, "a retired question's answer stays, under that question (its section was kept and renamed)");
  assert.equal(ana.answers.filter((a) => !a.retired).length, 22, "today's 22 questions are listed, numbered");
  assert.equal(ana.answers.filter((a) => a.retired).length, 8, "plus the 8 retired questions Ana answered");

  // 5. Analytics: every live question, plus retired ones that hold answers;
  //    each scorecard counted complete against the form it was given.
  const analytics = await admin("adminGetFeedbackAnalytics", { activityId: "" }, later(7));
  assert.equal(analytics.questions.filter((x) => !x.retired).length, 22);
  assert.deepEqual(analytics.questions.filter((x) => x.retired).map((x) => x.text).sort(),
    ["Question 10", "Question 11", "Question 12", "Question 13", "Question 5", "Question 6", "Question 7", "Question 9"].sort());
  assert.equal(analytics.completionRate, 100, "Ana answered all 15, Bo all 7, Cy all 22");
});

test("the limits: 1 to 30 questions, named sections, and a stale editor is refused", async () => {
  const { editor, admin } = await setup();
  const current = await editor(later(0));
  const save = async (sections) => {
    try {
      await admin("adminSaveQuestions", { questions: { sections } }, later(1));
      return "saved";
    } catch (error) {
      return error.message;
    }
  };
  const many = (n) => Array.from({ length: n }, (_, i) => ({ text: `Q${i + 1}`, type: "rating" }));
  assert.equal(await save([{ name: "Only", questions: [] }]), "The survey needs 1 to 30 questions; this has 0.");
  assert.equal(await save([{ name: "Big", questions: many(31) }]), "The survey needs 1 to 30 questions; this has 31.");
  assert.equal(await save([{ name: " ", questions: many(3) }]), "Every section needs a name.");
  assert.equal(await save([{ name: "S", questions: [{ text: " ", type: "rating" }] }]), "Questions cannot be blank.");
  assert.equal(await save([]), "Add at least one section.");
  const q = current.sections[0].questions[0];
  assert.equal(await save([{ name: "S", questions: [q, q] }]), "The questions changed since this page loaded. Reload and try again.");
  assert.equal(await save([{ name: "S", questions: [{ ...q, id: "00000000-0000-4000-8000-000000000000" }] }]),
    "The questions changed since this page loaded. Reload and try again.");
  assert.equal(await save([{ name: "One", questions: many(1) }]), "saved", "one question is enough");
  assert.equal(await save([{ name: "Thirty", questions: many(30) }]), "saved", "thirty is the most");
});

test("changing the type of an answered question starts a new question; an unanswered one is changed in place", async () => {
  const { editor, save, participant, responseOf } = await setup();
  await participant("ana@example.com", later(0));
  const current = await editor(later(1));
  const [answered] = current.sections[0].questions;
  await save(current.sections.map((s, si) => ({
    ...s, questions: s.questions.map((q, qi) => (si === 0 && qi === 0 ? { ...q, type: "yesno" } : q)),
  })), later(2));
  const after = await editor(later(3));
  const replaced = after.sections[0].questions[0];
  assert.notEqual(replaced.id, answered.id, "a rating's '1' would mean nothing as a yes/no answer");
  assert.equal(replaced.type, "yesno");
  const ana = await responseOf("ana@example.com", later(4));
  assert.equal(ana.answers.find((a) => a.questionId === answered.id).value, "1", "Ana's rating stays with the old question");

  // Nobody has answered the new one yet, so changing it back is done in place.
  await save(after.sections.map((s, si) => ({
    ...s, questions: s.questions.map((q, qi) => (si === 0 && qi === 0 ? { ...q, type: "rating" } : q)),
  })), later(5));
  assert.equal((await editor(later(6))).sections[0].questions[0].id, replaced.id);
});

test("an empty section stays in the editor but not on the survey; a form opened before a change still submits", async () => {
  const { db, editor, save, admin } = await setup();
  const opened = (await handleAction({ action: "getQuestions" }, { db, now: later(0) })).data;
  const current = await editor(later(1));
  await save([...current.sections.slice(0, 2), { name: "Coming soon", questions: [] }], later(2));
  assert.deepEqual(shapeOf(await editor(later(3))), [["Program content", 5], ["Event experience", 5], ["Coming soon", 0]]);
  const survey = (await handleAction({ action: "getQuestions" }, { db, now: later(3) })).data;
  assert.deepEqual(shapeOf(survey), [["Program content", 5], ["Event experience", 5]]);

  // Someone who opened the old 15-question form answers question 15, retired meanwhile.
  const retiredId = opened.sections[2].questions[4].id;
  const reply = await handleAction({ action: "submitFeedback", payload: {
    name: "Di", email: "di@example.com", sex: "Female", age: "30", activityId: "A-FORUM",
    answers: { [retiredId]: "A late answer", "00000000-0000-4000-8000-000000000000": "ignored" } } }, { db, now: later(4) });
  assert.equal(reply.data.status, "QUEUED");
  const di = (await admin("adminGetResponses", { filters: { query: "di@" } }, later(5))).entries[0];
  assert.deepEqual(di.answers.filter((a) => a.value).map((a) => [a.question, a.value, a.retired]),
    [["Question 15", "A late answer", true]], "kept, under the question they saw; the unknown ID is dropped");

  const [entry] = await db.query(`select details from portal.audit_log where action = 'QUESTIONS_SAVE'`);
  assert.equal(entry.details, '{"questionCount":10}');
});
