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
  workerPing: async (_body, { now }) => ({ time: now.toISOString() }),

  async workerClaimCertificateJobs(body, { db, portalBaseUrl }) {
    const base = trim(portalBaseUrl).replace(/\/+$/, "");
    if (!/^https?:\/\//.test(base))
      throw new Error("PORTAL_BASE_URL is not set in Netlify, so certificates cannot carry a verification link.");
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
