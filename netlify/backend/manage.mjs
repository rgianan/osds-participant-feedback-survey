import { randomUUID } from "node:crypto";
import { requireAdmin } from "./admin.mjs";

/**
 * The admin actions that change data: save, end or reopen, and delete an
 * activity, and re-queue certificates. Same rules and wording as Code.gs.
 *
 * Activities are addressed by their permanent ID (the `id` adminGetActivities
 * now returns). The client also sends the activity's code; a mismatch is
 * refused as Code.gs refused a shifted row, though with permanent IDs it can
 * only happen if a request is crafted by hand.
 */

const trim = (value) => String(value ?? "").trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const constraintOf = (error) => error?.constraint_name || error?.constraint || "";

/** Code.gs assertCanManageActivity_: the creator, or any superadmin. */
function assertCanManage(session, activity, verb) {
  if (session.role === "superadmin") return;
  const owner = trim(activity.created_by).toLowerCase();
  if (!owner || owner !== session.email)
    throw new Error(`Forbidden: only the administrator who created this activity, or a superadmin, can ${verb} it.`);
}

/** Code.gs assertActivityRowMatches_. */
function assertSameActivity(activity, expectedCode) {
  const expected = trim(expectedCode).toLowerCase();
  if (expected && activity.code.toLowerCase() !== expected)
    throw new Error("The activity list is out of date: that row now holds a different activity. Refresh and try again.");
}

async function findActivity(db, id, missing) {
  if (!UUID.test(trim(id))) throw new Error(missing);
  const [activity] = await db.query(
    `select id::text as id, code, coalesce(created_by, '') as created_by, active
       from portal.activities where id = $1`,
    [trim(id)],
  );
  if (!activity) throw new Error(missing);
  return activity;
}

/** Code.gs makeActivityId_: 'A-' + 8 hex characters. */
const newActivityCode = () => `A-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

export async function adminSaveActivity(body, context) {
  const session = await requireAdmin(context, body?.adminToken);
  const payload = body?.payload || {};
  const fields = {
    title: trim(payload.title),
    venue: trim(payload.venue),
    from: trim(payload.fromDate || payload.date),
    to: trim(payload.toDate),
    given: trim(payload.givenDate),
    template: trim(payload.template),
    signatory: trim(payload.inCharge),
    region: trim(payload.region),
    designation: trim(payload.signatoryDesignation),
    signature: trim(payload.signature),
  };
  if (!fields.title || !fields.venue || !fields.from || !fields.signatory || !fields.template ||
      !fields.region || !fields.designation || !fields.signature)
    throw new Error("Please fill all required activity, region, template, and signatory fields.");
  if (fields.to && fields.to < fields.from) throw new Error("The end date is before the start date.");
  // The sheet took any text; a date column does not, so say so plainly.
  for (const day of [fields.from, fields.to, fields.given])
    if (day && !DATE.test(day)) throw new Error("Dates must be written as yyyy-MM-dd.");

  const values = [fields.title, fields.venue, fields.from, fields.to || null, fields.given || null, fields.template,
    fields.signatory, fields.region, fields.designation, fields.signature, context.now.toISOString()];

  if (trim(payload.id)) {
    const activity = await findActivity(context.db, payload.id, "Activity does not exist.");
    assertCanManage(session, activity, "edit");
    assertSameActivity(activity, payload.activityId);
    // An activity saved before ownership was recorded is adopted by its first
    // editor, as in Code.gs.
    await context.db.query(
      `update portal.activities set title = $2, venue = $3, from_date = $4, to_date = $5, given_date = $6,
              template_url = $7, signatory_name = $8, region = $9, signatory_designation = $10,
              signature_url = $11, updated_at = $12, created_by = coalesce(created_by, $13)
        where id = $1`,
      [activity.id, ...values, session.email],
    );
    return "OK";
  }

  try {
    await context.db.query(
      `insert into portal.activities (title, venue, from_date, to_date, given_date, template_url, signatory_name,
         region, signatory_designation, signature_url, updated_at, created_at, code, created_by, active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13, true)`,
      [...values, trim(payload.activityId) || newActivityCode(), session.email],
    );
  } catch (error) {
    // The sheet allowed two activities with one code; the table does not.
    if (constraintOf(error) === "activities_code_key")
      throw new Error("Another activity already uses this activity ID.");
    throw error;
  }
  return "OK";
}

export async function adminSetActivityStatus(body, context) {
  const session = await requireAdmin(context, body?.adminToken);
  const payload = body?.payload || {};
  const active = payload.active === true || String(payload.active).toLowerCase() === "true";
  const activity = await findActivity(context.db, payload.id, "Activity does not exist.");
  assertCanManage(session, activity, active ? "reopen" : "end");
  assertSameActivity(activity, payload.activityId);
  await context.db.query(
    `update portal.activities set active = $2, updated_at = $3 where id = $1`,
    [activity.id, active, context.now.toISOString()],
  );
  return { id: activity.id, active };
}

/**
 * Responses keep their copied title, venue and date, and are still counted.
 * Any still waiting for a certificate are marked failed with a reason: with
 * the activity gone there is no template to fill, and Code.gs would have
 * failed them anyway when the queue reached them.
 */
export async function adminDeleteActivity(body, context) {
  const session = await requireAdmin(context, body?.adminToken);
  const activity = await findActivity(context.db, body?.id ?? body?.payload?.id, "Row does not exist.");
  assertCanManage(session, activity, "delete");
  assertSameActivity(activity, body?.activityId ?? body?.payload?.activityId);
  await context.db.transaction(async (tx) => {
    await tx.query(
      `update portal.responses
          set certificate_status = 'failed', certificate_error = 'The activity was deleted before its certificate was issued.'
        where activity_id = $1 and certificate_status = 'pending'`,
      [activity.id],
    );
    await tx.query(`delete from portal.activities where id = $1`, [activity.id]);
  });
  return "OK";
}

/** How long a run may hold a job; must match claim_certificate_jobs. */
const LEASE_MINUTES = 15;

/**
 * Put failed certificates back in the queue, and stuck ones whose run died.
 *
 * Code.gs could retry any PROCESSING row because it held the generator's lock
 * while doing it. Here a job is "stuck" only once its claim is older than the
 * lease; a newer one may still be running, so it is left alone. A failed row
 * whose participant has since submitted again is skipped too: retrying it
 * would issue a second certificate, and the unique index refuses it.
 */
export async function adminRetryCertificates(body, context) {
  await requireAdmin(context, body?.adminToken);
  const rows = body?.payload?.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error("Select at least one certificate to retry.");
  if (rows.length > 100) throw new Error("Retry up to 100 certificates at a time.");
  let requeued = 0;
  const skipped = [];
  for (const raw of rows) {
    const id = parseInt(String(raw), 10);
    if (!Number.isFinite(id) || id < 1) {
      skipped.push(raw);
      continue;
    }
    try {
      const updated = await context.db.query(
        `update portal.responses
            set certificate_status = 'pending', certificate_error = null, claimed_at = null, claim_token = null, attempts = 0
          where id = $1
            and (certificate_status = 'failed'
                 or (certificate_status = 'processing'
                     and (claimed_at is null or claimed_at < $2::timestamptz - interval '${LEASE_MINUTES} minutes')))
          returning id`,
        [id, context.now.toISOString()],
      );
      if (updated.length) requeued++;
      else skipped.push(id);
    } catch (error) {
      if (constraintOf(error) !== "responses_one_per_activity_email") throw error;
      skipped.push(id);
    }
  }
  return { requeued, skipped };
}
