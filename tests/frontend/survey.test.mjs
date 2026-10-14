import { test } from "node:test";
import assert from "node:assert/strict";
import { answerFields, normalizeSurvey, savePayload, surveyPages, surveyProblem } from "../../src/lib/survey.js";

/** The survey model the pages share, fed by either backend. */

const appsScriptSurvey = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [
  [`question${i + 1}`, `Question ${i + 1}`], [`type${i + 1}`, i === 14 ? "text" : i === 13 ? "yesno" : "rating"],
]).flat());

test("Apps Script's 15 questions become three fixed sections of five, as the survey has always paged them", () => {
  const survey = normalizeSurvey(appsScriptSurvey);
  assert.equal(survey.adjustable, false);
  assert.deepEqual(survey.sections.map((s) => [s.name, s.questions.length]),
    [["Program content", 5], ["Event experience", 5], ["Overall reflection", 5]]);
  assert.deepEqual(survey.sections[2].questions[4], { key: "position-15", id: null, text: "Question 15", type: "text" });
  // The editor's reply (a list of 15) reads the same way.
  assert.deepEqual(normalizeSurvey(Array.from({ length: 15 }, (_, i) => ({ text: `Question ${i + 1}`, type: "rating" }))).sections.length, 3);
});

test("the new backend's sections are kept as they are, empty ones included for the editor", () => {
  const survey = normalizeSurvey({ sections: [
    { id: "s1", name: "Content", questions: [{ id: "q1", text: "Clear?", type: "rating" }, { id: "q2", text: "Again?", type: "yesno" }] },
    { id: "s2", name: "Later", questions: [] },
  ] });
  assert.equal(survey.adjustable, true);
  assert.deepEqual(survey.sections[0].questions[1], { key: "q2", id: "q2", text: "Again?", type: "yesno" });
  assert.deepEqual(surveyPages(survey).map((s) => s.name), ["Content"], "a participant never sees an empty page");
});

test("a submission carries its answers both ways, so either backend can read it", () => {
  const legacy = normalizeSurvey(appsScriptSurvey);
  const fields = answerFields(legacy, { "position-1": 5, "position-15": "Great" });
  assert.equal(fields.answer1, 5);
  assert.equal(fields.answer15, "Great");
  assert.deepEqual(fields.answers, {}, "Apps Script questions have no IDs");

  const sections = normalizeSurvey({ sections: [{ id: "s1", name: "A", questions: [{ id: "q1", text: "x", type: "rating" }, { id: "q2", text: "y", type: "text" }] }] });
  assert.deepEqual(answerFields(sections, { q1: 4, q2: " " }), { answer1: 4, answer2: " ", answers: { q1: 4 } },
    "blank answers are not sent by ID");
});

test("the editor saves in each backend's own shape", () => {
  const legacy = normalizeSurvey(appsScriptSurvey);
  const list = savePayload(legacy);
  assert.equal(list.length, 15);
  assert.deepEqual(list[13], { text: "Question 14", type: "yesno" });

  const survey = normalizeSurvey({ sections: [{ id: "s1", name: "A", questions: [{ id: "q1", text: "x", type: "rating" }] }] });
  survey.sections.push({ id: null, name: "New page", questions: [{ key: "new-1", id: null, text: "y", type: "text" }] });
  assert.deepEqual(savePayload(survey), { sections: [
    { id: "s1", name: "A", questions: [{ id: "q1", text: "x", type: "rating" }] },
    { id: undefined, name: "New page", questions: [{ id: undefined, text: "y", type: "text" }] },
  ] });
});

test("the editor names what blocks a save", () => {
  const survey = (questions, name = "A") => ({ adjustable: true, sections: [{ id: null, name, questions }] });
  const q = (text) => ({ key: text, id: null, text, type: "rating" });
  assert.equal(surveyProblem(survey([])), "Add at least one question.");
  assert.equal(surveyProblem(survey(Array.from({ length: 31 }, (_, i) => q(`Q${i}`)))), "The survey can have at most 30 questions; this has 31.");
  assert.equal(surveyProblem(survey([q("a")], " ")), "Every section needs a name.");
  assert.equal(surveyProblem(survey([q("a"), q(" ")])), "Question 2 is blank.");
  assert.equal(surveyProblem(survey([q("a")])), "");
});
