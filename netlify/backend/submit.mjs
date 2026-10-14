import { newVerificationCode } from "./crypto.mjs";
import { liveQuestions } from "./questions.mjs";
import { dateKey, isFeedbackWindowOpen } from "./time.mjs";

/**
 * A participant's survey submission, ported from Code.gs submitFeedback with
 * the same statuses and messages: QUEUED, BAD_REQUEST, DUP or CLOSED.
 *
 * Apps Script held a spreadsheet-wide lock while it scanned every response
 * for a duplicate. Here the duplicate rule is a unique index, so two
 * submissions arriving at once are settled by the database: one is saved,
 * the other comes back DUP.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ONE_PER_EMAIL = "responses_one_per_activity_email";
const trim = (value) => String(value ?? "").trim();
const constraintOf = (error) => error?.constraint_name || error?.constraint || "";
const badRequest = (message) => ({ status: "BAD_REQUEST", message });

export async function submitFeedback(body, { db, now }) {
  const form = body?.payload || body || {};
  // The honeypot: a field people never see. Anything in it is a bot; it is
  // told "received" so it does not learn it was caught.
  if (trim(form.website)) return { status: "QUEUED", message: "Feedback received." };

  const name = trim(form.name);
  const email = trim(form.email);
  const sex = trim(form.sex);
  const age = parseInt(form.age, 10);
  const activityCode = trim(form.activityId || form.activity_id);
  const activityTitle = trim(form.title || form.activityTitle);

  if (!activityCode && !activityTitle) return badRequest("Activity selection is required.");
  if (!name || name.length > 160) return badRequest("Name is required.");
  if (!EMAIL.test(email) || email.length > 254) return badRequest("A valid email is required.");
  if (!sex || sex.length > 40) return badRequest("Sex is required.");
  if (!age || age < 1 || age > 120) return badRequest("Age must be between 1 and 120.");

  // By code first, then by title, as findActivityByIdOrTitle_.
  const [activity] = await db.query(
    `select id, code, title, venue, active, from_date::text as from_date, to_date::text as to_date
       from portal.activities
      where ($1 <> '' and lower(code) = lower($1)) or ($2 <> '' and lower(title) = lower($2))
      order by (lower(code) = lower($1)) desc, created_at
      limit 1`,
    [activityCode, activityTitle],
  );

  if (activity) {
    const [existing] = await db.query(
      `select 1 from portal.responses
        where activity_id = $1 and lower(email) = lower($2) and certificate_status <> 'failed' limit 1`,
      [activity.id, email],
    );
    if (existing) return { status: "DUP", by: "email" };
  } else {
    return badRequest("Selected activity not found. Please re-select the activity.");
  }

  // The switch and the date window, checked again here: the browser may have
  // loaded the list days ago, or before an administrator ended the activity.
  const today = dateKey(now);
  if (!activity.active)
    return {
      status: "CLOSED",
      message: "This activity has been closed by its organizer. Feedback is no longer being collected.",
    };
  if (!isFeedbackWindowOpen(activity.from_date, activity.to_date, today))
    return {
      status: "CLOSED",
      message: today < activity.from_date
        ? `Feedback for this activity opens on ${activity.from_date}.`
        : "The feedback period for this activity has ended.",
    };

  const answers = await answersOf(db, form);

  // Title, venue and date come from the activity itself rather than the
  // browser, so a crafted request cannot put other words on the record.
  const activityDate =
    activity.to_date && activity.to_date !== activity.from_date
      ? `${activity.from_date} – ${activity.to_date}`
      : activity.from_date;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const id = await db.transaction(async (tx) => {
        const [row] = await tx.query(
          `insert into portal.responses
             (submitted_at, activity_id, activity_code, activity_title, venue, activity_date,
              name, email, sex, age, takeaways, suggestions, verification_code)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           returning id::int as id`,
          [now.toISOString(), activity.id, activity.code, activity.title, activity.venue, activityDate,
           name, email, sex, age, trim(form.takeaways).slice(0, 2000), trim(form.suggestions).slice(0, 2000),
           newVerificationCode()],
        );
        for (const answer of answers)
          await tx.query(
            `insert into portal.answers (response_id, question_id, value) values ($1, $2, $3)`,
            [row.id, answer.questionId, answer.value],
          );
        return row.id;
      });
      return {
        status: "QUEUED",
        queueRow: id,
        message: "Feedback received. Your certificate will be emailed after processing.",
      };
    } catch (error) {
      const constraint = constraintOf(error);
      // A second submission that arrived at the same moment as the first.
      if (constraint === ONE_PER_EMAIL) return { status: "DUP", by: "email" };
      // An 80-bit verification code collided: draw another.
      if (constraint === "responses_verification_code_key") continue;
      throw error;
    }
  }
  throw new Error("Could not allocate a verification code. Please submit again.");
}

/**
 * The answers to store, each tied to its question.
 *
 * The survey sends `answers` keyed by question ID. A question retired while
 * the participant had the form open still takes its answer: it was on the
 * form they saw. Unknown IDs are dropped. Without `answers` (an older client,
 * or the Apps Script shape), answer1…answerN are matched to the live
 * questions in survey order.
 */
async function answersOf(db, form) {
  const value = (raw) => trim(raw).slice(0, 2000);
  if (form.answers && typeof form.answers === "object" && !Array.isArray(form.answers)) {
    const known = new Set((await db.query(`select id::text as id from portal.questions`)).map((q) => q.id));
    return Object.entries(form.answers)
      .filter(([questionId]) => known.has(questionId))
      .map(([questionId, raw]) => ({ questionId, value: value(raw) }))
      .filter((answer) => answer.value);
  }
  const questions = await liveQuestions(db);
  return questions
    .map((question, i) => ({ questionId: question.id, value: value(form[`answer${i + 1}`] ?? form[`question${i + 1}`]) }))
    .filter((answer) => answer.value);
}
