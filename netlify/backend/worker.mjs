/**
 * The certificate worker's side of the API (migration plan, phase 2).
 *
 * Apps Script still builds certificates: it fills the Slides template, saves
 * the PDF to Drive and emails it from the office account. It no longer reads
 * the spreadsheet. Every minute it asks here for work:
 *
 *   workerClaimCertificateJobs     up to 10 jobs, each with everything its
 *                                  certificate needs, and a claim token
 *   workerCompleteCertificateJob   the result, recorded only while the claim
 *                                  is still that run's
 *   workerReleaseCertificateJob    a job the run had no time to start
 *   workerPing                     a connection check for the editor
 *   workerReplayExport             for a rollback: what the sheets need to
 *                                  carry on from this database
 *
 * Only the WORKER_TOKEN opens these (netlify/functions/worker.mjs checks it),
 * so Apps Script never holds database credentials.
 */

const LEASE = "15 minutes"; // longer than any Apps Script run (6 minutes)
const trim = (value) => String(value ?? "").trim();

export async function handleWorkerRequest(body, context) {
  const action = trim(body?.action);
  const handler = HANDLERS[action];
  if (!Object.hasOwn(HANDLERS, action)) return { ok: false, error: `Unknown worker action: ${action}` };
  try {
    return { ok: true, data: await handler(body, context) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

const HANDLERS = {
  /**
   * A connection check (checkWorkerApi() in Code.gs, npm run check:setup).
   * Also reports what a setup check cannot see from outside: whether the
   * database answers from inside the function, how long one round trip takes
   * (a few milliseconds when both are in Singapore, about 200 when the
   * functions run in the United States), and which settings are present.
   * Present or not, never their values.
   */
  async workerPing(_body, { db, now, setup = {} }) {
    const database = { reachable: false };
    try {
      await db.query("select 1"); // the first query also opens the connection
      const started = performance.now();
      await db.query("select 1");
      database.roundTripMs = Math.round(performance.now() - started);
      database.reachable = true;
    } catch (error) {
      database.error = error?.message || String(error);
    }
    return { time: now.toISOString(), database, ...setup };
  },

  async workerClaimCertificateJobs(body, { db, portalBaseUrl }) {
    const base = trim(portalBaseUrl).replace(/\/+$/, "");
    if (!/^https?:\/\//.test(base))
      throw new Error("PORTAL_BASE_URL is not set in the site's environment variables, so certificates cannot carry a verification link.");
    const batchSize = Math.min(10, Math.max(1, parseInt(body?.batchSize, 10) || 10));
    const claimed = await db.query(
      `select claim_token::text as claim_token from portal.claim_certificate_jobs($1, $2::interval)`,
      [batchSize, LEASE],
    );
    if (!claimed.length) return { leaseMinutes: 15, jobs: [] };
    // A second statement, so it sees the claim's own updates (the attempt count).
    const rows = await db.query(
      `select r.id::int as response_id, r.claim_token::text as claim_token,
              r.name, r.email, r.verification_code, r.attempts,
              a.title, a.venue, a.from_date::text as from_date, coalesce(a.to_date::text, '') as to_date,
              coalesce(a.given_date::text, '') as given_date, a.template_url, a.signatory_name,
              a.signatory_designation, a.signature_url
         from portal.responses r
         join portal.activities a on a.id = r.activity_id
        where r.claim_token = any(string_to_array($1, ',')::uuid[])
        order by r.id`,
      [claimed.map((row) => row.claim_token).join(",")],
    );
    return {
      leaseMinutes: 15,
      jobs: rows.map((row) => ({
        responseId: row.response_id,
        claimToken: row.claim_token,
        attempt: row.attempts,
        name: row.name,
        email: row.email,
        verificationCode: row.verification_code,
        verificationUrl: `${base}/verification?code=${encodeURIComponent(row.verification_code)}`,
        // The activity as it stands now, as the Sheets queue read it.
        title: row.title,
        venue: row.venue,
        fromDate: row.from_date,
        toDate: row.to_date,
        givenDate: row.given_date,
        templateUrl: row.template_url,
        signatory: row.signatory_name,
        designation: row.signatory_designation,
        signature: row.signature_url,
      })),
    };
  },

  /**
   * Records a job's result. It lands only while the job is still processing
   * under THIS claim: a run that outlived its lease, whose job was taken
   * again, cannot overwrite the newer run's result. {recorded:false} says so.
   */
  async workerCompleteCertificateJob(body, { db }) {
    const id = parseInt(body?.responseId, 10);
    const claim = trim(body?.claimToken);
    if (!id || !claim) throw new Error("responseId and claimToken are required.");
    const done = body?.ok === true
      ? await db.query(
          `update portal.responses
              set certificate_status = 'issued', certificate_url = $3, certificate_error = null,
                  emailed_at = nullif($4, '')::timestamptz, email_note = nullif($5, ''),
                  claimed_at = null, claim_token = null
            where id = $1 and claim_token = $2::uuid and certificate_status = 'processing'
            returning id`,
          [id, claim, trim(body.certificateUrl), trim(body.emailedAt), trim(body.note).slice(0, 300)],
        )
      : await db.query(
          `update portal.responses
              set certificate_status = 'failed', certificate_error = $3, claimed_at = null, claim_token = null
            where id = $1 and claim_token = $2::uuid and certificate_status = 'processing'
            returning id`,
          [id, claim, trim(body?.error).slice(0, 450) || "The certificate could not be made."],
        );
    return { recorded: done.length > 0 };
  },

  /**
   * Rollback (migration plan, "Cutover and rollback"): everything the sheets
   * need to carry on from this database, for replayFromNewBackend() in
   * Code.gs. Read-only.
   *
   * `afterAuditHash` is the Audit sheet's last entry. The database's log
   * continues from it, so the entries after it are the ones Sheets lacks.
   */
  async workerReplayExport(body, { db, portalBaseUrl }) {
    const settings = Object.fromEntries((await db.query(
      `select key, value from portal.settings where key in ('imported_at', 'imported_questions')`)).map((r) => [r.key, r.value]));
    if (!settings.imported_at)
      throw new Error("This database was not filled by the import (scripts/import-sheets.mjs), so there is nothing to replay.");
    const importedAt = settings.imported_at;
    const answerColumns = JSON.parse(settings.imported_questions || "[]"); // question IDs for Answer1…Answer15

    const audit = await db.query(
      `select logged_at, audit_id, actor_email, actor_role, action, target_type, target_id, outcome, details,
              request_id, previous_hash, entry_hash
         from portal.audit_log order by id`);
    const afterHash = trim(body?.afterAuditHash);
    let from = 0;
    if (afterHash) {
      const at = audit.findIndex((entry) => entry.entry_hash === afterHash);
      if (at < 0)
        throw new Error("The Audit sheet's last entry is not in the new backend's log, so the two have parted. Nothing was replayed; run auditChainDiagnose() and compare the two logs.");
      from = at + 1;
    }

    const base = trim(portalBaseUrl).replace(/\/+$/, "");
    const iso = (column) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    const responses = await db.query(
      `select r.legacy_sheet_row, ${iso("r.submitted_at")} as submitted_at, r.name, r.email, r.sex, r.age::int as age,
              r.activity_code, r.activity_title, r.venue, r.activity_date, r.takeaways, r.suggestions,
              r.certificate_status::text as status, coalesce(r.certificate_error, '') as error,
              coalesce(r.certificate_url, '') as certificate_url, r.verification_code,
              coalesce(to_char(r.emailed_at at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI'), '') as emailed_at,
              coalesce(r.email_note, '') as email_note,
              coalesce((select json_object_agg(a.question_id, a.value) from portal.answers a where a.response_id = r.id)::text, '{}') as answers
         from portal.responses r order by r.id`);
    // The sheet's own words for a certificate's state (certificateState_). A
    // job a run held when the backend stopped goes back in the queue.
    const cStatus = (row) =>
      row.status === "issued" ? "OK" : row.status === "failed" ? `ERROR: ${row.error}` : "PENDING";

    const activities = await db.query(
      `select code, title, venue, from_date::text as from_date, coalesce(to_date::text, '') as to_date,
              coalesce(given_date::text, '') as given_date, template_url, signatory_name, region, signatory_designation,
              signature_url, coalesce(created_by, '') as created_by, active, ${iso("updated_at")} as updated_at
         from portal.activities order by created_at, code`);
    const users = await db.query(
      `select email, name, role::text as role, active, created_at >= $1::timestamptz as is_new
         from portal.admin_users order by created_at, email`, [importedAt]);
    const survey = await db.query(
      `select q.id::text as id, q.text, q.type::text as type
         from portal.questions q join portal.survey_sections s on s.id = q.section_id
        where q.retired_at is null and s.retired_at is null
        order by s.position, s.created_at, q.position, q.created_at`);

    return {
      importedAt,
      auditEntries: audit.slice(from),
      responses: responses.map((row) => {
        const answers = JSON.parse(row.answers);
        return {
          sheetRow: row.legacy_sheet_row,
          submittedAt: row.submitted_at,
          name: row.name,
          email: row.email,
          sex: row.sex,
          age: row.age,
          activityId: row.activity_code,
          title: row.activity_title,
          venue: row.venue,
          activityDate: row.activity_date,
          takeaways: row.takeaways,
          suggestions: row.suggestions,
          answers: answerColumns.map((id) => answers[id] ?? ""),
          // Answers to questions added after cutover: Sheets has no column for them.
          otherAnswers: Object.keys(answers).filter((id) => !answerColumns.includes(id)).length,
          cStatus: cStatus(row),
          certificateUrl: row.certificate_url,
          emailSent: [row.emailed_at, row.email_note].filter(Boolean).join(" "),
          verificationCode: row.verification_code,
          verificationUrl: row.status === "issued" && base ? `${base}/verification?code=${encodeURIComponent(row.verification_code)}` : "",
        };
      }),
      activities: activities.map((row) => ({
        activityId: row.code, title: row.title, venue: row.venue, fromDate: row.from_date, toDate: row.to_date,
        givenDate: row.given_date, template: row.template_url, inCharge: row.signatory_name, region: row.region,
        signatoryDesignation: row.signatory_designation, signature: row.signature_url, createdBy: row.created_by,
        active: row.active, updatedAt: row.updated_at,
      })),
      users: users.map((row) => ({ email: row.email, name: row.name, role: row.role, active: row.active, isNew: row.is_new })),
      // The sheet holds 15 questions in Answer order. Only while the survey is
      // still those 15, in that order, can its wording be copied back.
      survey: {
        sameQuestions: survey.length === answerColumns.length && survey.every((q, i) => q.id === answerColumns[i]),
        questions: survey.map(({ text, type }) => ({ text, type })),
      },
    };
  },

  /** A job the run claimed but had no time to start: straight back to the queue, not counted as an attempt. */
  async workerReleaseCertificateJob(body, { db }) {
    const id = parseInt(body?.responseId, 10);
    const claim = trim(body?.claimToken);
    if (!id || !claim) throw new Error("responseId and claimToken are required.");
    const released = await db.query(
      `update portal.responses
          set certificate_status = 'pending', claimed_at = null, claim_token = null, attempts = greatest(attempts - 1, 0)
        where id = $1 and claim_token = $2::uuid and certificate_status = 'processing'
        returning id`,
      [id, claim],
    );
    return { released: released.length > 0 };
  },
};
