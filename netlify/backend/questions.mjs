/**
 * The survey's questions: named sections, each one page of the form, holding
 * 1 to 30 questions in total. Every question keeps a permanent ID, and
 * answers are stored against it, so adding, removing or reordering questions
 * never moves an old answer under another question. A removed question or
 * section is retired, not deleted: it leaves the form and keeps its history.
 */
export const QUESTION_LIMITS = { min: 1, max: 30 };

/** The shape Apps Script serves: exactly 15 questions, still accepted from older clients. */
export const LEGACY_QUESTION_COUNT = 15;

/** Code.gs normalizeQuestionType_: the spellings people type into the sheet. */
export function normalizeQuestionType(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["text", "long text", "longtext", "essay"].includes(raw)) return "text";
  if (["yesno", "yes/no", "yes-no", "yn", "boolean"].includes(raw)) return "yesno";
  return "rating";
}

/** The questions on the survey right now, in the order participants see them. */
export function liveQuestions(db) {
  return db.query(
    `select q.id::text as id, q.text, q.type::text as type, s.id::text as section_id, s.name as section_name
       from portal.questions q
       join portal.survey_sections s on s.id = q.section_id
      where q.retired_at is null and s.retired_at is null
      order by s.position, s.created_at, q.position, q.created_at`,
  );
}

/**
 * The survey as sections of questions. The participant's form leaves out a
 * section with no questions; the editor keeps it so it can be filled.
 */
export async function liveSurvey(db, { includeEmpty = false } = {}) {
  const [sections, questions] = await Promise.all([
    db.query(`select id::text as id, name from portal.survey_sections where retired_at is null order by position, created_at`),
    liveQuestions(db),
  ]);
  return sections
    .map((section) => ({
      id: section.id,
      name: section.name,
      questions: questions
        .filter((q) => q.section_id === section.id)
        .map(({ id, text, type }) => ({ id, text, type })),
    }))
    .filter((section) => includeEmpty || section.questions.length);
}

/**
 * Every question ever asked, live ones first in survey order, then retired
 * ones oldest first. Responses and Analytics use this so an answer to a
 * retired question still shows, under the question it answered.
 */
export function everyQuestion(db) {
  return db.query(
    `select q.id::text as id, q.text, q.type::text as type, s.name as section_name,
            (q.retired_at is not null or s.retired_at is not null) as retired
       from portal.questions q
       join portal.survey_sections s on s.id = q.section_id
      order by (q.retired_at is not null or s.retired_at is not null), s.position, s.created_at, q.position, q.created_at`,
  );
}
