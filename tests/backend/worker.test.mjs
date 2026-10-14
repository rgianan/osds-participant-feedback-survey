import { test } from "node:test";
import assert from "node:assert/strict";
import { handler } from "../../netlify/functions/worker.mjs";
import { handleAction } from "../../netlify/backend/actions.mjs";
import { handleWorkerRequest } from "../../netlify/backend/worker.mjs";
import { freshDatabase, seedActivity, seedAdmin, seedResponse, seedSession } from "./helpers.mjs";

/** Phase 2: the certificate worker's endpoint. */

const PORTAL = "https://portal.test";
const NOW = new Date("2026-08-24T02:00:00Z");

async function setup() {
  const { db } = await freshDatabase();
  const activity = await seedActivity(db, { code: "A-FORUM", title: "Leadership Forum" });
  await db.query(
    `update portal.activities set template_url = 'https://drive.google.com/file/d/TEMPLATE00000000000000/view',
       signatory_name = 'Maria Santos', signatory_designation = 'Director', given_date = '2026-08-25',
       signature_url = 'https://drive.google.com/file/d/SIGNATURE0000000000000/view'`);
  const worker = async (action, body = {}) => {
    const reply = await handleWorkerRequest({ action, ...body }, { db, now: NOW, portalBaseUrl: PORTAL });
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  };
  const status = async (id) =>
    (await db.query(`select certificate_status::text as s, attempts, certificate_error as e from portal.responses where id = $1`, [id]))[0];
  // Makes every current claim look `minutes` old, as if that much time had passed.
  const age = (minutes) => db.query(`update portal.responses set claimed_at = claimed_at - ($1 || ' minutes')::interval where claimed_at is not null`, [String(minutes)]);
  return { db, activity, worker, status, age };
}

test("only the worker token opens the endpoint; a browser's request is refused", async () => {
  const saved = process.env.WORKER_TOKEN;
  process.env.WORKER_TOKEN = "w".repeat(96);
  try {
    const call = (authorization) => handler({ httpMethod: "POST", headers: authorization ? { authorization } : {}, body: '{"action":"workerPing"}' });
    assert.equal((await call()).statusCode, 401);
    assert.equal((await call("Bearer guess")).statusCode, 401);
    assert.equal((await call(`Bearer ${"w".repeat(95)}x`)).statusCode, 401);
    assert.equal((await handler({ httpMethod: "GET", headers: {} })).statusCode, 405);
    process.env.WORKER_TOKEN = "";
    assert.match(JSON.parse((await call(`Bearer ${"w".repeat(96)}`)).body).error, /WORKER_TOKEN is not set/);
  } finally {
    process.env.WORKER_TOKEN = saved;
  }
  // And the browser-facing backend does not know the worker's actions at all.
  const { db } = await freshDatabase();
  assert.deepEqual(await handleAction({ action: "workerClaimCertificateJobs" }, { db }), { ok: false, error: "Unknown action: workerClaimCertificateJobs" });
});

test("a claim hands over everything a certificate needs, at most 10 at a time, never an ended activity's", async () => {
  const { db, activity, worker } = await setup();
  const ended = await seedActivity(db, { code: "A-ENDED", active: false });
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push((await seedResponse(db, activity, { email: `p${i}@example.com`, name: `Person ${i}` })).id);
  await seedResponse(db, ended, { email: "held@example.com" });

  const first = await worker("workerClaimCertificateJobs", { batchSize: 50 });
  assert.equal(first.jobs.length, 10, "capped at 10 however many are asked for");
  const [job] = first.jobs;
  assert.deepEqual({ ...job, claimToken: undefined, verificationCode: undefined, verificationUrl: undefined }, {
    responseId: ids[0], claimToken: undefined, attempt: 1, name: "Person 0", email: "p0@example.com",
    verificationCode: undefined, verificationUrl: undefined,
    title: "Leadership Forum", venue: "CHED Auditorium", fromDate: "2026-08-24", toDate: "2026-08-24", givenDate: "2026-08-25",
    templateUrl: "https://drive.google.com/file/d/TEMPLATE00000000000000/view", signatory: "Maria Santos", designation: "Director",
    signature: "https://drive.google.com/file/d/SIGNATURE0000000000000/view",
  });
  assert.equal(job.verificationUrl, `${PORTAL}/verification?code=${job.verificationCode}`);
  const second = await worker("workerClaimCertificateJobs", {});
  assert.deepEqual(second.jobs.map((j) => j.responseId), ids.slice(10), "the next run gets the rest, never a job already taken");
  assert.equal((await worker("workerClaimCertificateJobs", {})).jobs.length, 0, "the ended activity's job stays held");
});

test("results land only under the claim that took the job", async () => {
  const { db, activity, worker, status, age } = await setup();
  const issued = await seedResponse(db, activity, { email: "a@example.com" });
  const failed = await seedResponse(db, activity, { email: "b@example.com" });
  const [a, b] = (await worker("workerClaimCertificateJobs", {})).jobs;

  assert.deepEqual(await worker("workerCompleteCertificateJob", {
    responseId: a.responseId, claimToken: a.claimToken, ok: true, certificateUrl: "https://drive/a.pdf",
    emailedAt: "2026-08-24T02:05:00.000Z", note: "" }), { recorded: true });
  const [row] = await db.query(
    `select certificate_status::text as s, certificate_url, emailed_at = '2026-08-24T02:05:00Z'::timestamptz as emailed, claim_token
       from portal.responses where id = $1`, [issued.id]);
  assert.deepEqual(row, { s: "issued", certificate_url: "https://drive/a.pdf", emailed: true, claim_token: null });

  await worker("workerCompleteCertificateJob", { responseId: b.responseId, claimToken: b.claimToken, ok: false, error: "No certificate template" });
  assert.deepEqual(await status(failed.id), { s: "failed", attempts: 1, e: "No certificate template" });

  // Reporting twice, or with someone else's claim, changes nothing.
  assert.deepEqual(await worker("workerCompleteCertificateJob", { responseId: a.responseId, claimToken: a.claimToken, ok: false, error: "late" }), { recorded: false });
  assert.deepEqual(await worker("workerCompleteCertificateJob", { responseId: a.responseId, claimToken: b.claimToken, ok: true }), { recorded: false });
  assert.equal((await status(issued.id)).s, "issued");
  await age(0);
});

test("a run killed mid-batch recovers on its own once its claims run out", async () => {
  const { db, activity, worker, status, age } = await setup();
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push((await seedResponse(db, activity, { email: `k${i}@example.com` })).id);
  const dying = (await worker("workerClaimCertificateJobs", {})).jobs;
  for (const job of dying.slice(0, 3))
    await worker("workerCompleteCertificateJob", { responseId: job.responseId, claimToken: job.claimToken, ok: true, certificateUrl: "https://drive/x.pdf" });
  // The run dies here: 7 jobs are left processing under its claims.

  assert.equal((await worker("workerClaimCertificateJobs", {})).jobs.length, 0, "a run 5 minutes in may still be working");
  await age(16);
  const recovery = (await worker("workerClaimCertificateJobs", {})).jobs;
  assert.deepEqual(recovery.map((j) => j.responseId), ids.slice(3), "after the lease, the 7 come back");
  assert.ok(recovery.every((j) => j.attempt === 2));
  // The dead run's late report for one of them is ignored; the new claim's is not.
  assert.deepEqual(await worker("workerCompleteCertificateJob", { responseId: dying[5].responseId, claimToken: dying[5].claimToken, ok: true }), { recorded: false });
  for (const job of recovery)
    await worker("workerCompleteCertificateJob", { responseId: job.responseId, claimToken: job.claimToken, ok: true, certificateUrl: "https://drive/y.pdf" });
  for (const id of ids) assert.equal((await status(id)).s, "issued");
});

test("a job that kills its run every time fails after 5 tries, and an admin retry gives it 5 more", async () => {
  const { db, activity, worker, status, age } = await setup();
  const poison = await seedResponse(db, activity, { email: "poison@example.com" });
  for (let i = 0; i < 5; i++) {
    assert.equal((await worker("workerClaimCertificateJobs", {})).jobs.length, 1, `claim ${i + 1}`);
    await age(16); // ...and the run dies
  }
  assert.equal((await worker("workerClaimCertificateJobs", {})).jobs.length, 0);
  assert.deepEqual(await status(poison.id), {
    s: "failed", attempts: 5,
    e: "Stopped after 5 attempts that never finished. Check the template and the Apps Script executions log, then retry.",
  });

  await seedAdmin(db, { email: "boss@example.com", hash: "x" });
  await seedSession(db, "boss@example.com", "tok");
  const retried = await handleAction({ action: "adminRetryCertificates", adminToken: "tok", payload: { rows: [poison.id] } }, { db, now: NOW });
  assert.deepEqual(retried.data, { requeued: 1, skipped: [] });
  assert.deepEqual(await status(poison.id), { s: "pending", attempts: 0, e: null });
});

test("a job the run had no time to start goes straight back, not counted as an attempt", async () => {
  const { db, activity, worker, status } = await setup();
  const late = await seedResponse(db, activity, { email: "late@example.com" });
  const [job] = (await worker("workerClaimCertificateJobs", {})).jobs;
  assert.deepEqual(await worker("workerReleaseCertificateJob", { responseId: job.responseId, claimToken: job.claimToken }), { released: true });
  assert.deepEqual(await status(late.id), { s: "pending", attempts: 0, e: null });
  assert.equal((await worker("workerClaimCertificateJobs", {})).jobs.length, 1, "and the next run takes it at once");
});

test("without PORTAL_BASE_URL no job is claimed, since certificates would have no verification link", async () => {
  const { db, activity } = await setup();
  await seedResponse(db, activity, { email: "a@example.com" });
  const reply = await handleWorkerRequest({ action: "workerClaimCertificateJobs" }, { db, now: NOW, portalBaseUrl: "" });
  assert.match(reply.error, /PORTAL_BASE_URL/);
  assert.equal((await db.query(`select certificate_status::text as s from portal.responses`))[0].s, "pending");
});

test("the rollback export refuses a database the import never filled", async () => {
  const { db } = await freshDatabase();
  const reply = await handleWorkerRequest({ action: "workerReplayExport", afterAuditHash: "" }, { db, now: NOW, portalBaseUrl: PORTAL });
  assert.deepEqual(reply, { ok: false, error: "This database was not filled by the import (scripts/import-sheets.mjs), so there is nothing to replay." });
});
