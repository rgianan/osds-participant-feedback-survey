import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAction } from "../../netlify/backend/actions.mjs";
import { freshDatabase, seedActivity, seedAdmin, seedResponse, seedSession } from "./helpers.mjs";

/**
 * Where the new backend deliberately departs from Code.gs. The contract
 * tests prove everything else matches; these pin down the differences.
 */

const NOW = new Date("2026-08-24T02:00:00Z");
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60e3).toISOString();
const fields = {
  title: "Regional Forum", venue: "Hall C", fromDate: "2026-08-24", toDate: "2026-08-25", givenDate: "2026-08-26",
  template: "https://drive/t", inCharge: "Maria Santos", region: "NCR", signatoryDesignation: "Director", signature: "https://drive/s",
};

async function setup() {
  const { db } = await freshDatabase();
  await seedAdmin(db, { email: "boss@example.com", role: "superadmin", hash: "x" });
  await seedSession(db, "boss@example.com", "tok");
  const call = (action, extra = {}) =>
    handleAction({ action, adminToken: "tok", ...extra }, { db, now: NOW, secrets: { auditSecret: "audit-secret" } });
  return { db, call };
}

test("deleting an activity fails its waiting certificates with a reason, and keeps every response", async () => {
  const { db, call } = await setup();
  const activity = await seedActivity(db, { code: "A-GONE" });
  await seedResponse(db, activity, { email: "a@example.com", status: "pending" });
  await seedResponse(db, activity, { email: "b@example.com", status: "issued" });
  assert.deepEqual(await call("adminDeleteActivity", { id: activity.id, activityId: "A-GONE" }), { ok: true, data: "OK" });
  const rows = await db.query(
    `select email, certificate_status::text as status, certificate_error, activity_id, activity_code
       from portal.responses order by email`);
  assert.deepEqual(rows, [
    { email: "a@example.com", status: "failed", certificate_error: "The activity was deleted before its certificate was issued.",
      activity_id: null, activity_code: "A-GONE" },
    { email: "b@example.com", status: "issued", certificate_error: null, activity_id: null, activity_code: "A-GONE" },
  ]);
});

test("a stuck certificate can be retried only once its run's claim has run out", async () => {
  const { db, call } = await setup();
  const activity = await seedActivity(db);
  const running = await seedResponse(db, activity, { email: "r@example.com", status: "processing", claimed_at: minutesAgo(5) });
  const dead = await seedResponse(db, activity, { email: "d@example.com", status: "processing", claimed_at: minutesAgo(20) });
  const reply = await call("adminRetryCertificates", { payload: { rows: [running.id, dead.id] } });
  assert.deepEqual(reply.data, { requeued: 1, skipped: [running.id] }, "a run 5 minutes in may still be working");
  const [row] = await db.query(`select certificate_status::text as status, claimed_at, claim_token from portal.responses where id = $1`, [dead.id]);
  assert.deepEqual(row, { status: "pending", claimed_at: null, claim_token: null });
});

test("a failed certificate is not retried once its participant has submitted again", async () => {
  const { db, call } = await setup();
  const activity = await seedActivity(db);
  const failed = await seedResponse(db, activity, { email: "ana@example.com", status: "failed" });
  await seedResponse(db, activity, { email: "ANA@example.com", status: "pending" }); // the resubmission
  const reply = await call("adminRetryCertificates", { payload: { rows: [failed.id] } });
  assert.deepEqual(reply.data, { requeued: 0, skipped: [failed.id] }, "retrying it would issue a second certificate");
});

test("activity codes stay unique, and editing never changes one", async () => {
  const { db, call } = await setup();
  await seedActivity(db, { code: "A-TAKEN" });
  assert.deepEqual(await call("adminSaveActivity", { payload: { ...fields, activityId: "A-TAKEN" } }),
    { ok: false, error: "Another activity already uses this activity ID." });
  assert.equal((await call("adminSaveActivity", { payload: fields })).ok, true);
  const [created] = await db.query(`select id::text as id, code from portal.activities where title = 'Regional Forum'`);
  assert.match(created.code, /^A-[0-9a-f]{8}$/, "a code is made when none is given");
  // Code.gs replaced a blank code on edit with a fresh one; the code is kept here.
  assert.equal((await call("adminSaveActivity", { payload: { ...fields, id: created.id, activityId: "" } })).ok, true);
  assert.equal((await db.query(`select code from portal.activities where id = $1`, [created.id]))[0].code, created.code);
});

test("dates must be real dates, and unknown IDs are refused", async () => {
  const { call } = await setup();
  assert.deepEqual(await call("adminSaveActivity", { payload: { ...fields, givenDate: "next Friday" } }),
    { ok: false, error: "Dates must be written as yyyy-MM-dd." });
  assert.deepEqual(await call("adminSaveActivity", { payload: { ...fields, id: "7" } }), { ok: false, error: "Activity does not exist." });
  assert.deepEqual(await call("adminSetActivityStatus", { payload: { id: "00000000-0000-4000-8000-000000000000", active: false } }),
    { ok: false, error: "Activity does not exist." });
  assert.deepEqual(await call("adminDeleteActivity", { id: "" }), { ok: false, error: "Row does not exist." });
});

test("every change is audited with Code.gs's labels and details", async () => {
  const { db, call } = await setup();
  await call("adminSaveActivity", { payload: { ...fields, activityId: "A-NEW" } });
  const [{ id }] = await db.query(`select id::text as id from portal.activities where code = 'A-NEW'`);
  await call("adminSaveActivity", { payload: { ...fields, id, activityId: "A-NEW" } });
  await call("adminSetActivityStatus", { payload: { id, active: false } });
  await call("adminRetryCertificates", { payload: { rows: [] } });
  await call("adminDeleteActivity", { id, activityId: "A-NEW" });
  const entries = await db.query(`select action, outcome, actor_email, target_type, target_id, details from portal.audit_log order by id`);
  assert.deepEqual(entries, [
    { action: "ACTIVITY_SAVE", outcome: "SUCCESS", actor_email: "boss@example.com", target_type: "activity", target_id: "A-NEW",
      details: '{"operation":"create","title":"Regional Forum"}' },
    { action: "ACTIVITY_SAVE", outcome: "SUCCESS", actor_email: "boss@example.com", target_type: "activity", target_id: "A-NEW",
      details: '{"operation":"update","title":"Regional Forum"}' },
    { action: "ACTIVITY_STATUS", outcome: "SUCCESS", actor_email: "boss@example.com", target_type: "activity", target_id: id,
      details: '{"operation":"disable"}' },
    { action: "CERTIFICATE_RETRY", outcome: "FAILURE", actor_email: "boss@example.com", target_type: "certificate", target_id: "",
      details: '{"error":"Select at least one certificate to retry."}' },
    { action: "ACTIVITY_DELETE", outcome: "SUCCESS", actor_email: "boss@example.com", target_type: "activity", target_id: id,
      details: "{}" },
  ]);
});
