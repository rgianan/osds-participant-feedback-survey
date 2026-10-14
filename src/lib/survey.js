/**
 * The survey's questions as the pages use them, whichever backend answered.
 *
 * Until the Supabase cutover, Apps Script serves exactly 15 questions
 * (question1…question15 to the survey, a list of 15 to the editor). The new
 * backend serves named sections of 1 to 30 questions, each with a permanent
 * ID. Both become one model here, so the pages need no "which backend?"
 * branches:
 *
 *   { adjustable, sections: [{ id, name, questions: [{ key, id, text, type }] }] }
 *
 * `adjustable` is true only for the new backend: Apps Script cannot store
 * added, removed or reordered questions, so the editor offers that only then.
 * `key` is what the page tracks an answer by: the question's ID, or its
 * position for Apps Script.
 */

export const QUESTION_LIMITS = { min: 1, max: 30 };
export const QUESTION_TYPES = ["rating", "text", "yesno"];
/** How Apps Script's 15 questions have always been paged: five to a section. */
export const LEGACY_SECTIONS = ["Program content", "Event experience", "Overall reflection"];

export const normalizeType = (type) => {
  const value = String(type ?? "").toLowerCase();
  return QUESTION_TYPES.includes(value) ? value : "rating";
};

export function normalizeSurvey(reply) {
  if (reply && Array.isArray(reply.sections))
    return {
      adjustable: true,
      sections: reply.sections.map((section) => ({
        id: section.id ?? null,
        name: String(section.name ?? ""),
        questions: (section.questions || []).map((question) => ({
          key: question.id,
          id: question.id,
          text: String(question.text ?? "").trim(),
          type: normalizeType(question.type),
        })),
      })),
    };
  const list = Array.isArray(reply)
    ? reply
    : Array.from({ length: 15 }, (_, i) => ({ text: reply?.[`question${i + 1}`], type: reply?.[`type${i + 1}`] }));
  return {
    adjustable: false,
    sections: LEGACY_SECTIONS.map((name, s) => ({
      id: null,
      name,
      questions: list.slice(s * 5, s * 5 + 5).map((question, j) => ({
        key: `position-${s * 5 + j + 1}`,
        id: null,
        text: String((typeof question === "object" ? question?.text : question) ?? "").trim(),
        type: normalizeType(typeof question === "object" ? question?.type : "rating"),
      })),
    })),
  };
}

export const allQuestions = (survey) => survey.sections.flatMap((section) => section.questions);

/** The pages a participant steps through: sections that have questions. */
export const surveyPages = (survey) => survey.sections.filter((section) => section.questions.length);

/**
 * A submission's answer fields, both ways at once: `answers` by question ID
 * for the new backend, and answer1…answerN by position for Apps Script. Each
 * backend reads its own and ignores the other.
 */
export function answerFields(survey, answers) {
  const questions = allQuestions(survey);
  const byPosition = Object.fromEntries(questions.map((question, i) => [`answer${i + 1}`, answers[question.key]]));
  const byId = Object.fromEntries(
    questions
      .filter((question) => question.id && String(answers[question.key] ?? "").trim() !== "")
      .map((question) => [question.id, answers[question.key]]),
  );
  return { ...byPosition, answers: byId };
}

/** The editor's save, in the shape the answering backend expects. */
export function savePayload(survey) {
  if (!survey.adjustable) return allQuestions(survey).map(({ text, type }) => ({ text, type }));
  return {
    sections: survey.sections.map((section) => ({
      id: section.id || undefined,
      name: section.name,
      questions: section.questions.map(({ id, text, type }) => ({ id: id || undefined, text, type })),
    })),
  };
}

/** What would stop the editor saving, worded for the person editing, or "" when it can save. */
export function surveyProblem(survey) {
  const questions = allQuestions(survey);
  if (questions.length < QUESTION_LIMITS.min) return "Add at least one question.";
  if (questions.length > QUESTION_LIMITS.max) return `The survey can have at most ${QUESTION_LIMITS.max} questions; this has ${questions.length}.`;
  if (survey.sections.some((section) => !section.name.trim())) return "Every section needs a name.";
  const blank = questions.findIndex((question) => !question.text.trim());
  if (blank >= 0) return `Question ${blank + 1} is blank.`;
  return "";
}
