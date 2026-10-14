import { liveSurvey } from "./questions.mjs";
import { dateKey, isFeedbackWindowOpen } from "./time.mjs";

/**
 * The three actions anyone can call: the survey's activity list and
 * questions, and certificate verification. Each returns exactly what the
 * Apps Script action of the same name returns, so the React app cannot tell
 * the backends apart.
 */

/** Open activities for the survey's dropdown: switched on and inside their feedback window. */
export async function getActivityData(_body, { db, now }) {
  const rows = await db.query(
    `select code, title, venue, from_date::text as from_date, to_date::text as to_date
       from portal.activities
      where active
      order by created_at, code`,
  );
  const today = dateKey(now);
  return rows
    .filter((row) => isFeedbackWindowOpen(row.from_date, row.to_date, today))
    .map((row) => ({
      id: row.code,
      title: row.title,
      venue: row.venue,
      // Same wording as Code.gs: one date, or "start – end" when they differ.
      date:
        row.to_date && row.to_date !== row.from_date
          ? `${row.from_date} – ${row.to_date}`
          : row.from_date,
    }));
}

/**
 * The survey as participants see it: named sections, each one page, holding
 * its questions in order. Sections with no questions are left out. Each
 * question carries its permanent ID, which the submission answers against.
 *
 * Apps Script serves question1…question15 instead; the survey page reads
 * both shapes (src/lib/survey.js).
 */
export async function getQuestions(_body, { db }) {
  return { sections: await liveSurvey(db) };
}

const VERIFICATION_CODE = /^CHED-[A-F0-9]{20}$/;

/**
 * Is this an issued certificate? One indexed lookup; Apps Script searched the
 * whole verification-code column, which phase 0 measured at 2.5–9.5 s.
 */
export async function verifyCertificate(body, { db }) {
  const code = String(body?.code ?? "").trim().toUpperCase();
  if (!VERIFICATION_CODE.test(code)) return { valid: false };
  const [row] = await db.query(
    `select name, activity_title, activity_date, venue, certificate_url,
            coalesce(to_char(emailed_at at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI'), '') as issued_at
       from portal.responses
      where verification_code = $1 and certificate_status = 'issued'`,
    [code],
  );
  if (!row) return { valid: false };
  return {
    valid: true,
    verificationCode: code,
    name: row.name,
    activity: row.activity_title,
    activityDate: row.activity_date,
    venue: row.venue,
    issuedAt: row.issued_at,
    certificateUrl: row.certificate_url ?? "",
  };
}
