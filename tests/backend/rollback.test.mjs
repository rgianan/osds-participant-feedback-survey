import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionTokenHash } from "../../netlify/backend/crypto.mjs";
import { AUDIT_SECRET, NOW, WORKER_TOKEN, appsScript, json } from "./contract-harness.mjs";
import { backendThread } from "./backend-thread.mjs";
import { exportFromAppsScript } from "./import-helpers.mjs";

/**
 * Phase 4: the rollback. After cutover the new backend does real work; if it
 * has to be switched off within the first day, replayFromNewBackend() in
 * Code.gs copies that work into the sheets and the old portal carries on.
 * Code.gs runs for real against stand-in sheets, and reaches the new backend
 * through its worker endpoint, as it would on the day.
 */

const PORTAL = "https://portal.test";
const WORKER_URL = `${PORTAL}/.netlify/functions/worker`;
const LATER = new Date("2026-08-24T03:00:00Z"); // 11:00 in Manila, an hour after the import
const TEMPLATE_URL = "https://drive.google.com/file/d/TEMPLATE00000000000000/view";

/** The fixture's sheets exported and imported (the cutover), and Code.gs pointed at the new backend's worker endpoint. */
function cutover() {
  const apps = appsScript();
  const { exported } = exportFromAppsScript(apps);
  const api = backendThread({ portalBaseUrl: PORTAL });
  const imported = api.importSheets(exported, { auditSecret: AUDIT_SECRET, now: NOW });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  api.sql(`insert into portal.admin_sessions (token_hash, email, expires_at) values ($1, 'boss@example.com', '2099-01-01')`,
    [sessionTokenHash("boss-token")]);
  apps.properties.set("WORKER_API_URL", WORKER_URL);
  apps.gas.UrlFetchApp = {
    fetch: (url, options) => {
      assert.equal(url, WORKER_URL);
      assert.equal(options.headers.Authorization, `Bearer ${WORKER_TOKEN}`);
      const reply = api.worker(JSON.parse(options.payload));
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(reply) };
    },
  };
  const admin = (action, extra = {}) => {
    const reply = api.action({ action, adminToken: "boss-token", ...extra }, LATER, { auditSecret: AUDIT_SECRET });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.data;
  };
  const submit = (payload) => {
    const reply = api.action({ action: "submitFeedback", payload }, LATER);
    assert.equal(reply.data?.status, "QUEUED", JSON.stringify(reply));
  };
  /** One run of the certificate worker: claim, then report what `outcomes` says for each participant (left unreported if absent). */
  const certificates = (outcomes) => {
    const { jobs } = api.worker({ action: "workerClaimCertificateJobs" }).data;
    for (const job of jobs)
      if (outcomes[job.email])
        api.worker({ action: "workerCompleteCertificateJob", responseId: job.responseId, claimToken: job.claimToken, ...outcomes[job.email] });
    return jobs.map((job) => job.name).sort();
  };
  const cells = (sheet, header) => {
    const rows = apps.sheets[sheet].rows;
    const column = rows[0].findIndex((h) => String(h).toLowerCase() === header.toLowerCase());
    return rows.slice(1).map((row) => row[column]);
  };
  return { apps, api, admin, submit, certificates, cells };
}

const issued = (who) => ({ ok: true, certificateUrl: `https://drive.google.com/file/d/pdf-${who}/view`, emailedAt: "2026-08-24T03:05:00.000Z" });
const counts = ({ responsesAdded, responsesUpdated, auditEntriesAdded, activitiesAdded, activitiesUpdated, administratorsUpdated, questionsUpdated }) =>
  ({ responsesAdded, responsesUpdated, auditEntriesAdded, activitiesAdded, activitiesUpdated, administratorsUpdated, questionsUpdated });

test("phase 4: a rollback copies the new backend's work into the sheets, and the old portal then shows exactly what the new one did", () => {
  const { apps, api, admin, submit, certificates, cells } = cutover();
  try {
    // An hour of the new portal: an activity made, one switched back on, two
    // participants, and a certificate run.
    admin("adminSaveActivity", { payload: { title: "Evaluation Clinic", venue: "Room 5", fromDate: "2026-08-24", toDate: "2026-08-24",
      template: TEMPLATE_URL, inCharge: "Maria Santos", region: "NCR", signatoryDesignation: "Director",
      signature: "https://drive.google.com/file/d/SIGNATURE0000000000000/view" } });
    const [clinic] = api.sql(`select code from portal.activities where title = 'Evaluation Clinic'`);
    const [workshop] = api.sql(`select id::text as id from portal.activities where code = 'A-WORK'`);
    admin("adminSetActivityStatus", { payload: { id: workshop.id, activityId: "A-WORK", active: true } });
    const ratings = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`answer${i + 1}`, String(5 - (i % 3))]));
    submit({ activityId: "A-FORUM", name: "Eve", email: "eve@example.com", sex: "Female", age: "41", ...ratings,
      answer14: "Yes", answer15: "Clear and useful", takeaways: "Pacing" });
    submit({ activityId: clinic.code, name: "Fay", email: "fay@example.com", sex: "Male", age: "29", answer1: "4" });
    // Di's certificate was being made when the sheets were exported, and that run never reported back.
    api.sql(`update portal.responses set claimed_at = claimed_at - interval '1 hour' where certificate_status = 'processing'`);
    assert.deepEqual(certificates({
      "cy@example.com": { ok: false, error: "Missing certificate template for selected activity." },
      "di@example.com": issued("di"), "eve@example.com": issued("eve"), "fay@example.com": issued("fay"),
    }), ["Cy", "Di", "Eve", "Fay"]);

    // The rollback. The preview reports, and changes nothing.
    const untouched = JSON.stringify(apps.sheets);
    const preview = json(apps.gas.previewReplayFromNewBackend());
    assert.equal(preview.mode, "PREVIEW: nothing has been changed");
    assert.equal(preview.importedAt, NOW.toISOString());
    const expected = { responsesAdded: 2, responsesUpdated: 2, auditEntriesAdded: 2, activitiesAdded: 1, activitiesUpdated: 1,
      administratorsUpdated: 0, questionsUpdated: 0 };
    assert.deepEqual(counts(preview), expected);
    assert.deepEqual(preview.notCopied, []);
    assert.equal(JSON.stringify(apps.sheets), untouched);

    const replayed = json(apps.gas.replayFromNewBackend());
    assert.deepEqual(counts(replayed), expected);
    assert.equal(replayed.auditChain, "Chain is intact.");
    assert.deepEqual(cells("Responses", "Name"), ["Ana", "Bo", "Cy", "Di", "Eve", "Fay"]);
    assert.deepEqual(cells("Responses", "cStatus"), ["OK", "ERROR: No certificate template", "ERROR: Missing certificate template for selected activity.", "OK", "OK", "OK"]);
    // A certificate issued after cutover verifies in the old portal.
    const [eve] = api.sql(`select verification_code from portal.responses where email = 'eve@example.com'`);
    assert.equal(json(apps.gas.verifyCertificate(eve.verification_code)).valid, true);
    assert.equal(cells("Responses", "Verification URL")[4], `${PORTAL}/verification?code=${eve.verification_code}`);

    // Every screen of the old portal, against the new backend: the same check the import makes.
    const { failures, screens } = api.compare(exportFromAppsScript(apps).exported, { auditSecret: AUDIT_SECRET, now: LATER });
    assert.deepEqual(failures, []);
    assert.ok(screens.includes("Analytics (" + clinic.code + ")") && screens.includes("verification (6 codes)"));

    // Run again, nothing is copied twice.
    assert.deepEqual(counts(json(apps.gas.replayFromNewBackend())), { responsesAdded: 0, responsesUpdated: 0, auditEntriesAdded: 0,
      activitiesAdded: 0, activitiesUpdated: 0, administratorsUpdated: 0, questionsUpdated: 0 });
  } finally {
    api.stop();
  }
});

test("what the sheets cannot hold is listed, a half-done certificate goes back in the queue, and parted audit logs stop the replay", () => {
  const { apps, api, admin, submit, certificates, cells } = cutover();
  try {
    admin("adminSaveUser", { payload: { email: "dan@example.com", name: "Dan", role: "admin", password: "a long enough password" } });
    admin("adminSaveUser", { payload: { email: "helper@example.com", name: "Helper", role: "superadmin" } });
    const [summit] = api.sql(`select id::text as id from portal.activities where code = 'A-NEXT'`);
    admin("adminDeleteActivity", { id: summit.id, activityId: "A-NEXT" });
    api.sql(`insert into portal.questions (section_id, position, text, type)
             select id, 5, 'What should we change?', 'text' from portal.survey_sections where position = 3`);
    submit({ activityId: "A-FORUM", name: "Gus", email: "gus@example.com", sex: "Male", age: "35", answer1: "5", answer16: "More breaks" });
    assert.deepEqual(certificates({}), ["Gus"], "the run takes Gus's certificate, then stops without reporting");

    const summary = json(apps.gas.replayFromNewBackend());
    assert.deepEqual(summary.notCopied, [
      "1 answer(s) to questions added after cutover: the sheet has no column for them.",
      "Activity row 4 was deleted in the new portal. Delete it in the Activity sheet by hand if it should go.",
      "Administrator dan@example.com was added in the new portal. Add them again here; their password cannot be copied.",
      "The survey was changed in the new portal (questions added, removed or moved). This portal keeps the 15 questions it had at cutover.",
    ]);
    assert.equal(summary.administratorsUpdated, 1);
    assert.deepEqual(cells("Users", "Role"), ["superadmin", "superadmin"]);
    assert.deepEqual(cells("Whitelist", "role"), ["superadmin", "superadmin"]);
    assert.equal(summary.auditEntriesAdded, 3);
    assert.equal(summary.auditChain, "Chain is intact.");
    // Gus's half-done job goes back in the old queue, which makes his certificate.
    assert.equal(cells("Responses", "cStatus")[4], "PENDING");
    assert.equal(String(cells("Responses", "Answer1")[4]), "5");

    // Someone signs in to the old portal: its log gains an entry the new one never had.
    const audit = apps.sheets.Audit.rows;
    audit.push(audit.at(-1).map((value, i) => (audit[0][i] === "entry_hash" ? "made-in-the-old-portal" : value)));
    assert.throws(() => apps.gas.previewReplayFromNewBackend(), /the two have parted\. Nothing was replayed/);
  } finally {
    api.stop();
  }
});
