import {
  LEGACY_QUESTION_COUNT,
  QUESTION_LIMITS,
  liveQuestions,
  liveSurvey,
  normalizeQuestionType,
} from "./questions.mjs";
import { requireSuperadmin } from "./users.mjs";

/**
 * The Questions editor (superadmins). The survey is named sections of
 * questions, 1 to 30 in all; each section is one page of the form.
 *
 * Saving keeps history intact:
 *   - a question or section left out of the save is retired, not deleted,
 *     so its answers stay in Responses and Analytics;
 *   - rewording a question keeps its ID (and its answers);
 *   - changing the TYPE of a question that already has answers retires it and
 *     starts a new one, since "4" from a rating would mean nothing as yes/no.
 */

export const DEFAULT_SECTIONS = ["Program content", "Event experience", "Overall reflection"];
const OUT_OF_DATE = "The questions changed since this page loaded. Reload and try again.";
const trim = (value) => String(value ?? "").trim();

export async function adminGetQuestions(body, context) {
  await requireSuperadmin(context, body?.adminToken);
  return { sections: await liveSurvey(context.db, { includeEmpty: true }), limits: QUESTION_LIMITS };
}

export async function adminSaveQuestions(body, context) {
  await requireSuperadmin(context, body?.adminToken);
  const input = body?.questions || body?.payload?.questions || body?.payload || [];
  // The old shape gets the old reply: the cleaned list, as Code.gs returns it.
  if (Array.isArray(input)) return saveLegacyList(context, input);
  await saveSections(context, input?.sections);
  return { sections: await liveSurvey(context.db, { includeEmpty: true }), limits: QUESTION_LIMITS };
}

/** Validates and tidies the editor's sections, or throws the message to show. */
function cleanSections(sections) {
  if (!Array.isArray(sections) || !sections.length) throw new Error("Add at least one section.");
  const cleaned = sections.map((section) => ({
    id: trim(section?.id) || null,
    name: trim(section?.name),
    questions: (Array.isArray(section?.questions) ? section.questions : []).map((question) => ({
      id: trim(question?.id) || null,
      text: trim(question?.text),
      type: normalizeQuestionType(question?.type),
    })),
  }));
  if (cleaned.some((section) => !section.name)) throw new Error("Every section needs a name.");
  if (cleaned.some((section) => section.name.length > 120)) throw new Error("Section names must be 120 characters or fewer.");
  const questions = cleaned.flatMap((section) => section.questions);
  if (questions.length < QUESTION_LIMITS.min || questions.length > QUESTION_LIMITS.max)
    throw new Error(`The survey needs ${QUESTION_LIMITS.min} to ${QUESTION_LIMITS.max} questions; this has ${questions.length}.`);
  if (questions.some((question) => !question.text)) throw new Error("Questions cannot be blank.");
  if (questions.some((question) => question.text.length > 500)) throw new Error("Questions must be 500 characters or fewer.");
  const ids = [...cleaned.map((s) => s.id), ...questions.map((q) => q.id)].filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error(OUT_OF_DATE);
  return cleaned;
}

async function saveSections(context, sections) {
  const cleaned = cleanSections(sections);
  const now = context.now.toISOString();
  await context.db.transaction(async (tx) => {
    // Everyone saving the survey takes turns, so two editors cannot interleave.
    await tx.query(`select 1 from pg_advisory_xact_lock(hashtext('portal.survey'))`);
    const liveSections = new Set((await tx.query(`select id::text as id from portal.survey_sections where retired_at is null`)).map((r) => r.id));
    const liveQuestionRows = await tx.query(
      `select q.id::text as id, q.type::text as type, exists (select 1 from portal.answers a where a.question_id = q.id) as answered
         from portal.questions q where q.retired_at is null`,
    );
    const live = new Map(liveQuestionRows.map((q) => [q.id, q]));
    // An ID the editor sends must be one still on the survey: anything else
    // means another editor saved in between.
    for (const section of cleaned) {
      if (section.id && !liveSections.has(section.id)) throw new Error(OUT_OF_DATE);
      for (const question of section.questions) if (question.id && !live.has(question.id)) throw new Error(OUT_OF_DATE);
    }

    const keptSections = new Set();
    const keptQuestions = new Set();
    for (const [si, section] of cleaned.entries()) {
      let sectionId = section.id;
      if (sectionId) {
        await tx.query(`update portal.survey_sections set name = $2, position = $3 where id = $1`, [sectionId, section.name, si + 1]);
      } else {
        [{ id: sectionId }] = await tx.query(
          `insert into portal.survey_sections (name, position, created_at) values ($1, $2, $3) returning id::text as id`,
          [section.name, si + 1, now]);
      }
      keptSections.add(sectionId);
      for (const [qi, question] of section.questions.entries()) {
        const existing = question.id ? live.get(question.id) : null;
        if (existing && !(existing.answered && existing.type !== question.type)) {
          await tx.query(
            `update portal.questions set section_id = $2, position = $3, text = $4, type = $5 where id = $1`,
            [existing.id, sectionId, qi, question.text, question.type]);
          keptQuestions.add(existing.id);
        } else {
          // New, or an answered question changing type: a fresh question.
          await tx.query(
            `insert into portal.questions (section_id, position, text, type, created_at) values ($1, $2, $3, $4, $5)`,
            [sectionId, qi, question.text, question.type, now]);
        }
      }
    }
    for (const id of liveSections)
      if (!keptSections.has(id)) await tx.query(`update portal.survey_sections set retired_at = $2 where id = $1`, [id, now]);
    for (const id of live.keys())
      if (!keptQuestions.has(id)) await tx.query(`update portal.questions set retired_at = $2 where id = $1`, [id, now]);
  });
}

/**
 * Apps Script's shape: exactly 15 {text, type} (or plain strings, from the
 * oldest clients). Questions 1-15 are edited in place, as the sheet did.
 */
async function saveLegacyList(context, list) {
  if (list.length !== LEGACY_QUESTION_COUNT) throw new Error("Exactly 15 questions are required.");
  const questions = list.map((question) => {
    const isObject = question && typeof question === "object";
    return { text: trim(isObject ? question.text : question), type: normalizeQuestionType(isObject ? question.type : "rating") };
  });
  if (questions.some((question) => !question.text)) throw new Error("Questions cannot be blank.");
  if (questions.some((question) => question.text.length > 500)) throw new Error("Questions must be 500 characters or fewer.");
  const now = context.now.toISOString();
  await context.db.transaction(async (tx) => {
    await tx.query(`select 1 from pg_advisory_xact_lock(hashtext('portal.survey'))`);
    const sections = await tx.query(`select id from portal.survey_sections where retired_at is null order by position, created_at`);
    if (!sections.length)
      for (const [i, name] of DEFAULT_SECTIONS.entries())
        sections.push((await tx.query(
          `insert into portal.survey_sections (name, position, created_at) values ($1, $2, $3) returning id`, [name, i + 1, now]))[0]);
    const live = await liveQuestions(tx);
    for (const [i, question] of questions.entries()) {
      if (live[i]) {
        await tx.query(`update portal.questions set text = $2, type = $3 where id = $1`, [live[i].id, question.text, question.type]);
      } else {
        // Five to a section, in order, as the survey has always paged them.
        const section = sections[Math.min(Math.floor(i / 5), sections.length - 1)];
        await tx.query(
          `insert into portal.questions (section_id, position, text, type, created_at) values ($1, $2, $3, $4, $5)`,
          [section.id, i, question.text, question.type, now]);
      }
    }
  });
  return questions;
}
