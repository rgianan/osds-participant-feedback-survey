import { getAdminSession } from "./auth.mjs";
import { everyQuestion } from "./questions.mjs";
import { dateKey, isFeedbackWindowOpen } from "./time.mjs";

/**
 * The admin read screens: Activities, Responses, Certificates, Analytics and
 * the dashboard that combines the first and the last. Each returns the shape
 * the Apps Script action of the same name returns, so AdminViews.jsx works
 * against either backend unchanged.
 */

const FORBIDDEN = "Forbidden: administrator authorization required.";
const trim = (value) => String(value ?? "").trim();

export async function requireAdmin(context, token) {
  const session = await getAdminSession(context, token);
  if (!session) throw new Error(FORBIDDEN);
  return session;
}

/** Database status → the state names the admin screens group by (certificateState_ in Code.gs). */
const STATE = { pending: "QUEUED", processing: "PROCESSING", issued: "ISSUED", failed: "FAILED" };
const STATUS = Object.fromEntries(Object.entries(STATE).map(([status, state]) => [state, status]));

/** 'yyyy-MM-dd HH:mm' in Manila, or '' — the format the sheet's timestamps were shown in. */
const minuteStamp = (column) =>
  `coalesce(to_char(${column} at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI'), '')`;

/** The sheet's "Email Sent" cell: when it went, then any note (a sharing warning, or no recipient). */
const emailSent = (row) => [row.emailed_at, row.email_note].filter(Boolean).join(" ");

const round = (value, places) => Number(value.toFixed(places));

// --- Activities ---------------------------------------------------------------

/**
 * Every activity, oldest first, with `canManage` for the signed-in admin.
 * `id` is now the activity's permanent ID. Apps Script used the sheet row
 * number, which shifted when a row above was deleted.
 */
export async function adminGetActivities(body, context) {
  const session = await requireAdmin(context, body?.adminToken);
  const rows = await context.db.query(
    `select id::text as id, code, title, venue, from_date::text as from_date,
            coalesce(to_date::text, '') as to_date, coalesce(given_date::text, '') as given_date,
            region, signatory_name, signatory_designation, signature_url, template_url,
            coalesce(created_by, '') as created_by, active, ${minuteStamp("updated_at")} as updated
       from portal.activities
      order by created_at, code`,
  );
  const today = dateKey(context.now);
  const superadmin = session.role === "superadmin";
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    venue: row.venue,
    fromDate: row.from_date,
    toDate: row.to_date,
    template: row.template_url,
    inCharge: row.signatory_name,
    region: row.region,
    signatoryDesignation: row.signatory_designation,
    signature: row.signature_url,
    Timestamp: row.updated,
    givenDate: row.given_date,
    activityId: row.code,
    createdBy: row.created_by,
    active: row.active,
    windowOpen: isFeedbackWindowOpen(row.from_date, row.to_date, today),
    // Edit, End and Delete re-check this rule on the server.
    canManage: superadmin || (!!row.created_by && row.created_by === session.email),
  }));
}

// --- Responses ------------------------------------------------------------------

/** Participant responses, newest first. filters: {activityId, query, state, limit}. */
export async function adminGetResponses(body, context) {
  await requireAdmin(context, body?.adminToken);
  const filters = body?.filters || {};
  const wantState = trim(filters.state).toUpperCase();
  if (wantState && !STATUS[wantState]) return { entries: [], total: 0 };
  const limit = Math.min(500, Math.max(25, Number(filters.limit) || 200));
  const [questions, rows] = await Promise.all([
    everyQuestion(context.db),
    context.db.query(
      `select r.id::int as id, ${minuteStamp("r.submitted_at")} as submitted_at, r.name, r.email, r.sex,
              r.age::text as age, r.activity_code, r.activity_title, r.activity_date, r.takeaways, r.suggestions,
              r.certificate_status::text as status, coalesce(r.certificate_error, '') as error,
              coalesce(r.certificate_url, '') as certificate_url, r.verification_code,
              ${minuteStamp("r.emailed_at")} as emailed_at, coalesce(r.email_note, '') as email_note,
              count(*) over ()::int as total,
              coalesce((select json_agg(json_build_object('q', a.question_id, 'v', a.value))::text
                          from portal.answers a where a.response_id = r.id), '[]') as answers
         from portal.responses r
        where ($1 = '' or lower(r.activity_code) = $1)
          and ($2 = '' or r.certificate_status::text = $2)
          and ($3 = '' or strpos(lower(r.name || ' ' || r.email || ' ' || r.activity_title || ' ' || r.activity_code), $3) > 0)
        order by r.id desc
        limit $4`,
      [trim(filters.activityId).toLowerCase(), STATUS[wantState] || "", trim(filters.query).toLowerCase(), limit],
    ),
  ]);
  const entries = rows.map((row) => {
    const given = new Map(JSON.parse(row.answers).map((a) => [a.q, a.v]));
    let ratingTotal = 0;
    let ratingCount = 0;
    // Every question on the survey now, numbered as participants see it, then
    // any retired question this participant answered: their answer stays
    // under the question they were asked.
    const answers = questions
      .filter((question) => !question.retired || given.has(question.id))
      .map((question, i) => {
        const value = given.get(question.id) ?? "";
        const score = Number(value);
        if (question.type === "rating" && score >= 1 && score <= 5) {
          ratingTotal += score;
          ratingCount++;
        }
        return {
          number: question.retired ? null : i + 1,
          type: question.type,
          value,
          questionId: question.id,
          question: question.text,
          section: question.section_name,
          retired: question.retired,
        };
      });
    return {
      row: row.id,
      submittedAt: row.submitted_at,
      name: row.name,
      email: row.email,
      sex: row.sex,
      age: row.age,
      activityId: row.activity_code,
      title: row.activity_title,
      activityDate: row.activity_date,
      takeaways: row.takeaways,
      suggestions: row.suggestions,
      answers,
      averageRating: ratingCount ? round(ratingTotal / ratingCount, 2) : 0,
      certificateState: STATE[row.status],
      certificateError: row.error,
      certificateUrl: row.certificate_url,
      verificationCode: row.verification_code,
      emailSent: emailSent(row),
    };
  });
  return { entries, total: rows[0]?.total ?? 0 };
}

// --- Certificates ---------------------------------------------------------------

/**
 * Certificate generation grouped as an admin acts on it: tab counts, the rows
 * in one tab (newest first, up to 300), and the activities whose queued
 * certificates are held because the activity is ended.
 */
export async function adminGetCertificateQueue(body, context) {
  await requireAdmin(context, body?.adminToken);
  const filters = body?.filters || {};
  const wantState = trim(filters.state).toUpperCase() || "FAILED";
  const activity = trim(filters.activityId).toLowerCase();
  const scope = `($1 = '' or lower(r.activity_code) = $1)`;
  const [counted, held, rows] = await Promise.all([
    context.db.query(
      `select r.certificate_status::text as status, count(*)::int as n
         from portal.responses r where ${scope} group by 1`,
      [activity],
    ),
    context.db.query(
      `select r.activity_title as title
         from portal.responses r join portal.activities a on a.id = r.activity_id
        where ${scope} and not a.active and r.certificate_status = 'pending' and r.activity_title <> ''
        group by r.activity_title
        order by min(r.id)`,
      [activity],
    ),
    STATUS[wantState]
      ? context.db.query(
          `select r.id::int as id, r.name, r.email, r.activity_code, r.activity_title, r.activity_date,
                  ${minuteStamp("r.submitted_at")} as submitted_at, r.certificate_status::text as status,
                  coalesce(r.certificate_error, '') as error, coalesce(r.certificate_url, '') as certificate_url,
                  ${minuteStamp("r.emailed_at")} as emailed_at, coalesce(r.email_note, '') as email_note,
                  (a.id is not null and not a.active and r.certificate_status = 'pending') as held
             from portal.responses r left join portal.activities a on a.id = r.activity_id
            where ${scope} and r.certificate_status::text = $2
            order by r.id desc
            limit 300`,
          [activity, STATUS[wantState]],
        )
      : [],
  ]);
  const counts = { QUEUED: 0, PROCESSING: 0, ISSUED: 0, FAILED: 0 };
  for (const row of counted) counts[STATE[row.status]] = row.n;
  return {
    entries: rows.map((row) => ({
      row: row.id,
      name: row.name,
      email: row.email,
      activityId: row.activity_code,
      title: row.activity_title,
      activityDate: row.activity_date,
      submittedAt: row.submitted_at,
      state: STATE[row.status],
      error: row.error,
      held: row.held,
      certificateUrl: row.certificate_url,
      emailSent: emailSent(row),
    })),
    counts,
    heldActivities: held.map((row) => row.title),
  };
}

// --- Analytics ------------------------------------------------------------------

/** Scores and certificate health for one activity (by code) or all of them. */
export async function adminGetFeedbackAnalytics(body, context) {
  await requireAdmin(context, body?.adminToken);
  return feedbackAnalytics(context.db, trim(body?.activityId));
}

async function feedbackAnalytics(db, activityCode) {
  const [{ n: everyResponse }] = await db.query(`select count(*)::int as n from portal.responses`);
  if (!everyResponse)
    return {
      totalResponses: 0, averageScore: 0, completionRate: 0,
      certificates: { queued: 0, processing: 0, issued: 0, failed: 0 },
      distribution: [0, 0, 0, 0, 0], questions: [],
    };

  // Apps Script compared the activity code exactly, case included.
  const scope = `($1 = '' or r.activity_code = $1)`;
  const [questions, statuses, tallies, [complete]] = await Promise.all([
    everyQuestion(db),
    db.query(`select r.certificate_status::text as status, count(*)::int as n from portal.responses r where ${scope} group by 1`, [activityCode]),
    // Rating and yes/no answers, counted per question and value; written
    // answers count toward completion only, so they are not fetched.
    db.query(
      `select a.question_id::text as question, a.value, ${scope} as in_scope, count(*)::int as n
         from portal.answers a
         join portal.responses r on r.id = a.response_id
         join portal.questions q on q.id = a.question_id
        where q.type <> 'text'
        group by 1, 2, 3`,
      [activityCode],
    ),
    // A complete scorecard answered every question that was on the form when
    // it was submitted. Questions added or retired since do not change that.
    db.query(
      `select count(*)::int as n from portal.responses r
        where ${scope}
          and not exists (
            select 1 from portal.questions q join portal.survey_sections s on s.id = q.section_id
             where q.created_at <= r.submitted_at
               and (q.retired_at is null or q.retired_at > r.submitted_at)
               and (s.retired_at is null or s.retired_at > r.submitted_at)
               and not exists (select 1 from portal.answers a where a.response_id = r.id and a.question_id = q.id))`,
      [activityCode],
    ),
  ]);

  const stats = new Map(questions.map((q) => [q.id, { total: 0, count: 0, yes: 0, yesNo: 0 }]));
  const byId = new Map(questions.map((q) => [q.id, q]));
  const distribution = [0, 0, 0, 0, 0];
  let overallTotal = 0;
  let overallCount = 0;
  for (const tally of tallies) {
    const question = byId.get(tally.question);
    const s = stats.get(tally.question);
    if (!question) continue;
    if (question.type === "yesno") {
      if (!tally.in_scope) continue;
      s.yesNo += tally.n;
      if (/^y(es)?$/i.test(tally.value)) s.yes += tally.n;
      continue;
    }
    const score = Number(tally.value);
    if (!(score >= 1 && score <= 5)) continue;
    overallTotal += score * tally.n;
    overallCount += tally.n;
    if (!tally.in_scope) continue;
    s.total += score * tally.n;
    s.count += tally.n;
    distribution[Math.round(score) - 1] += tally.n;
  }

  const certificates = { queued: 0, processing: 0, issued: 0, failed: 0 };
  const key = { pending: "queued", processing: "processing", issued: "issued", failed: "failed" };
  for (const row of statuses) certificates[key[row.status]] = row.n;
  const totalResponses = statuses.reduce((sum, row) => sum + row.n, 0);
  const all = [...stats.values()];
  const totalScore = all.reduce((sum, q) => sum + q.total, 0);
  const totalAnswers = all.reduce((sum, q) => sum + q.count, 0);
  const averageScore = totalAnswers ? round(totalScore / totalAnswers, 2) : 0;
  const overallAverage = overallCount ? round(overallTotal / overallCount, 2) : 0;

  const summary = (question, label) => {
    const s = stats.get(question.id);
    return {
      label,
      type: question.type,
      responses: question.type === "yesno" ? s.yesNo : s.count,
      average: s.count ? round(s.total / s.count, 2) : 0,
      yesRate: s.yesNo ? round((s.yes / s.yesNo) * 100, 1) : 0,
      questionId: question.id,
      text: question.text,
      section: question.section_name,
      retired: question.retired,
    };
  };
  const live = questions.filter((q) => !q.retired);
  // Retired questions stay in Analytics while they hold answers for this scope.
  const retired = questions.filter((q) => q.retired).map((q) => summary(q, "Earlier question")).filter((q) => q.responses);

  return {
    scope: activityCode || "all",
    totalResponses,
    averageScore,
    overallAverage,
    overallResponses: everyResponse,
    scoreDelta: round(averageScore - overallAverage, 2),
    completionRate: totalResponses ? round((complete.n / totalResponses) * 100, 1) : 0,
    certificateIssueRate: totalResponses ? round((certificates.issued / totalResponses) * 100, 1) : 0,
    positiveRate: totalAnswers ? round(((distribution[3] + distribution[4]) / totalAnswers) * 100, 1) : 0,
    certificates,
    distribution,
    questions: [...live.map((q, i) => summary(q, `Question ${i + 1}`)), ...retired],
  };
}

// --- Dashboard ------------------------------------------------------------------

/** The dashboard's first paint in one request: every activity, plus analytics for the filter. */
export async function adminGetDashboard(body, context) {
  await requireAdmin(context, body?.adminToken);
  const [activities, analytics] = await Promise.all([
    adminGetActivities(body, context),
    feedbackAnalytics(context.db, trim(body?.filters?.activityId)),
  ]);
  return { activities, analytics };
}
