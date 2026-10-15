import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { handleAction } from "../../netlify/backend/actions.mjs";
import { legacyPasswordHash, v2PasswordHash } from "../../netlify/backend/crypto.mjs";
import { convertExport, importSheets } from "../../scripts/lib/import.mjs";
import { AUDIT, AUDIT_SECRET, NOW, PROXY_TOKEN, RESPONSES, WORKER_TOKEN, appsScript } from "./contract-harness.mjs";
import { asPostgresJs, freshDatabase } from "./helpers.mjs";
import { exportFromAppsScript, manilaDate, setCell } from "./import-helpers.mjs";

/**
 * Phase 3: the sheets into the new database. The export is made by the real
 * exportForMigration() in Code.gs from the contract fixture, so these tests
 * import exactly what Apps Script writes.
 */

const fixture = () => exportFromAppsScript(appsScript());
const run = (db, exported, options = {}) => importSheets(db, exported, { auditSecret: AUDIT_SECRET, now: NOW, ...options });
const tableCounts = async (db) =>
  (await db.query(`select (select count(*) from portal.activities)::int as activities, (select count(*) from portal.responses)::int as responses,
                          (select count(*) from portal.admin_users)::int as admins, (select count(*) from portal.audit_log)::int as audit,
                          (select count(*) from portal.questions)::int as questions`))[0];
const EMPTY = { activities: 0, responses: 0, admins: 0, audit: 0, questions: 0 };

test("the export holds every sheet with its types, and no secret", () => {
  const { exported, file, summary } = fixture();
  assert.match(file.name, /^participant-feedback-export-\d{8}-\d{6}\.json$/);
  assert.equal(file.mimeType, "application/json");
  assert.deepEqual(summary.rows, { Activity: 3, Responses: 4, Questions: 1, Users: 2, Whitelist: 2, Audit: 4 });
  assert.equal(exported.format, "participant-feedback-export");
  assert.equal(exported.timeZone, "Asia/Manila");
  assert.deepEqual(exported.properties, { AUDIT_HEAD_HASH: AUDIT.at(-1).entry_hash });
  for (const secret of [AUDIT_SECRET, WORKER_TOKEN, PROXY_TOKEN]) assert.ok(!file.content.includes(secret), "secrets stay in Script Properties");
  // A date stays a date, a number a number; the Audit sheet is its displayed text.
  const [header, first] = exported.sheets.Responses;
  assert.deepEqual(first[header.indexOf("Timestamp")], { $date: "2026-08-24T01:05:00.000Z" });
  assert.equal(first[header.indexOf("Age")], 30);
  assert.ok(exported.sheets.Audit.flat().every((value) => typeof value === "string"));
});

test("phase 3 exit test: the export imports, and the new database shows every screen as Apps Script does", async () => {
  const { exported } = fixture();
  const { db } = await freshDatabase();
  const result = await run(db, exported);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.counts, { admin_users: 2, activities: 3, survey_sections: 3, questions: 15, responses: 4, answers: 56, audit_log: 4, settings: 3 });
  assert.equal(result.checks.auditChain, "4 entries verify, ending at the recorded head");
  assert.deepEqual(result.checks.appsScript, ["survey activity list", "survey questions", "Activities", "Users", "Responses",
    "Certificates (QUEUED)", "Certificates (PROCESSING)", "Certificates (ISSUED)", "Certificates (FAILED)",
    "Analytics (all activities)", "Analytics (A-FORUM)", "Analytics (A-WORK)", "Analytics (A-NEXT)", "Audit", "verification (4 codes)"]);

  // The survey: today's 15 questions in three named sections, dated before the first response.
  const sections = await db.query(`select s.name, count(*)::int as n from portal.questions q join portal.survey_sections s on s.id = q.section_id
                                    group by s.name, s.position order by s.position`);
  assert.deepEqual(sections, [{ name: "Program content", n: 5 }, { name: "Event experience", n: 5 }, { name: "Overall reflection", n: 5 }]);
  const [dated] = await db.query(`select bool_and(q.created_at < r.first) as before from portal.questions q,
                                    (select min(submitted_at) as first from portal.responses) r`);
  assert.equal(dated.before, true);
  // A response a run was working on when the sheets were exported is claimed as
  // of the export, so the new worker takes it again once that claim runs out.
  const [processing] = await db.query(`select claimed_at = $1::timestamptz as at_export, attempts from portal.responses
                                         where certificate_status = 'processing'`, [exported.exportedAt]);
  assert.deepEqual(processing, { at_export: true, attempts: 0 });
  // Rows keep the sheet's order and remember their row.
  assert.deepEqual((await db.query(`select id::int as id, legacy_sheet_row as row, name from portal.responses order by id`)).map((r) => [r.id, r.row, r.name]),
    RESPONSES.map((r, i) => [i + 1, i + 2, r.name]));
  assert.deepEqual((await db.query(`select code from portal.activities order by created_at`)).map((r) => r.code), ["A-FORUM", "A-WORK", "A-NEXT"]);
});

test("rows the database would refuse are listed by sheet and row, and nothing is written", async () => {
  const { exported } = fixture();
  setCell(exported, "Activity", 2, "ToDate", manilaDate("2026-08-02")); // before its FromDate
  setCell(exported, "Activity", 3, "FromDate", "next week");
  setCell(exported, "Activity", 4, "ActivityID", "a-forum");
  setCell(exported, "Responses", 2, "Age", "thirty");
  setCell(exported, "Responses", 3, "cStatus", "DONE");
  setCell(exported, "Responses", 4, "Verification Code", "CHED-123");
  // Di answers Leadership Forum too, with Ana's address: two live responses, one participant.
  setCell(exported, "Responses", 5, "ActivityID", "A-FORUM");
  setCell(exported, "Responses", 5, "Responder Email", "ANA@example.com");
  setCell(exported, "Whitelist", 3, "role", "superadmin");
  setCell(exported, "Audit", 3, "outcome", "OK");
  const { db } = await freshDatabase();
  const result = await run(db, exported);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "convert");
  assert.deepEqual(result.problems, [
    "Whitelist row 3: the role differs from Users row 3. Make the two the same.",
    "Activity row 2: ToDate is before FromDate.",
    "Activity row 3: FromDate is not a date.",
    "Activity row 4: the same ActivityID as row 2.",
    "Responses row 2: Age is not a whole number from 1 to 120.",
    'Responses row 3: cStatus is "DONE"; it must be PENDING, PROCESSING, OK or ERROR: <reason>.',
    "Responses row 4: Verification Code is not CHED- followed by 20 letters A–F or digits.",
    "Responses row 5: the same participant email and activity as row 2, and neither failed. Delete one, or mark one ERROR.",
    "Audit row 3: outcome is not SUCCESS or FAILURE.",
  ]);
  assert.ok(!JSON.stringify(result.problems).includes("@example.com"), "problems never quote a participant's details");
  assert.deepEqual(await tableCounts(db), EMPTY);
});

test("an export Apps Script would show differently is caught by the comparison, and rolled back", async () => {
  const { exported } = fixture();
  // A code typed in lower case: Code.gs shows it as typed, the new database
  // stores it in capitals. Every field converts; only the comparison sees it.
  setCell(exported, "Responses", 5, "Verification Code", RESPONSES[3].code.toLowerCase());
  const { db } = await freshDatabase();
  const result = await run(db, exported);
  assert.equal(result.stage, "check");
  assert.deepEqual(result.failures, ["Responses: differs from Apps Script at entries[0].verificationCode"]);
  assert.deepEqual(await tableCounts(db), EMPTY, "the transaction was rolled back");
});

test("a tampered audit row, or the wrong audit secret, stops the import", async () => {
  const { exported } = fixture();
  const details = exported.sheets.Audit[0].indexOf("details");
  exported.sheets.Audit[3][details] = '{"error":"edited by hand"}';
  const { db } = await freshDatabase();
  const tampered = await run(db, exported);
  assert.equal(tampered.stage, "check");
  assert.deepEqual(tampered.failures, [
    "audit chain: 1 entry fails its hash and 0 break the chain, the first at Audit sheet row 4. Run auditChainDiagnose() in the Apps Script editor.",
  ]);
  assert.deepEqual(await tableCounts(db), EMPTY);

  const wrongSecret = await run(db, fixture().exported, { auditSecret: "not-the-secret" });
  assert.deepEqual(wrongSecret.failures, ["audit chain: every entry fails its hash. AUDIT_HASH_SECRET is not the value in Apps Script's Script Properties."]);
});

test("--skip-responses moves everything but the responses", async () => {
  const { exported } = fixture();
  const { db } = await freshDatabase();
  const result = await run(db, exported, { skipResponses: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.counts.responses, 0);
  assert.equal(result.counts.answers, 0);
  assert.equal(result.counts.activities, 3);
  assert.equal(result.counts.audit_log, 4);
  assert.ok(result.notes.includes("--skip-responses: the 4 response(s) in the sheet stay in Sheets and are not imported."));
  assert.ok(!result.checks.appsScript.some((s) => s.startsWith("verification")));
});

test("a database that holds data is replaced only on request, and never loses what the sheets lack without saying so", async () => {
  const { exported } = fixture();
  const { db } = await freshDatabase();
  assert.equal((await run(db, exported)).ok, true);

  const again = await run(db, exported);
  assert.equal(again.stage, "target");
  assert.match(again.message, /^The database already holds data \(56 answers, 4 responses, 15 questions, 3 survey_sections, 3 activities, 2 admin_users, 4 audit_log, 3 settings\)\. To replace it with this export, run again with --replace\.$/);

  const replaced = await run(db, exported, { replace: true });
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  assert.deepEqual(replaced.replaced.discarded, { responses: 0, audit: 0 });
  assert.deepEqual((await db.query(`select min(id)::int as first from portal.responses`))[0], { first: 1 }, "numbering starts again");

  // Then the new backend is used: a sign-in attempt is audited, a participant submits.
  await handleAction({ action: "adminLogin", email: "boss@example.com", password: "wrong" }, { db, now: NOW, secrets: { auditSecret: AUDIT_SECRET } });
  const submitted = await handleAction({ action: "submitFeedback", payload: { activityId: "A-FORUM", name: "Eve", email: "eve@example.com",
    sex: "Female", age: "41", answers: {} } }, { db, now: NOW });
  assert.equal(submitted.data?.status, "QUEUED", JSON.stringify(submitted));
  const refused = await run(db, exported, { replace: true });
  assert.equal(refused.stage, "target");
  assert.match(refused.message, /^1 response\(s\) and 1 audit entry in the database are not in this export: they were made through the new backend\./);
  assert.equal((await tableCounts(db)).responses, 5, "nothing was replaced");

  const discarded = await run(db, exported, { replace: true, discardNewData: true });
  assert.equal(discarded.ok, true, JSON.stringify(discarded));
  assert.deepEqual(discarded.replaced.discarded, { responses: 1, audit: 1 });
  assert.equal((await tableCounts(db)).responses, 4);
  await assert.rejects(db.query(`truncate portal.audit_log`), /append-only/, "the audit log's guard is back on");
});

test("administrators sign in with the passwords they have today, in either Apps Script format", async () => {
  const { exported } = fixture();
  setCell(exported, "Users", 2, "PasswordHash", v2PasswordHash("boss password 2026", "salt-boss", "pepper"));
  setCell(exported, "Users", 2, "Salt", "salt-boss");
  setCell(exported, "Users", 3, "PasswordHash", legacyPasswordHash("helper password 2026", "salt-help"));
  setCell(exported, "Users", 3, "Salt", "salt-help");
  // An account on the Users screen that never had a password.
  const wl = exported.sheets.Whitelist;
  wl.push(["U-CAROL001", "Carol", "admin", "carol@example.com", "TRUE", manilaDate("2026-08-03"), manilaDate("2026-08-03")]);
  const { db } = await freshDatabase();
  const result = await run(db, exported);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.notes, ["Whitelist row 4 has no password in Users. It is imported, listed, and cannot sign in, as today."]);

  const context = { db, now: NOW, secrets: { passwordPepper: "pepper", auditSecret: AUDIT_SECRET } };
  const signIn = (email, password) => handleAction({ action: "adminLogin", email, password }, context);
  assert.equal((await signIn("boss@example.com", "boss password 2026")).ok, true);
  assert.equal((await signIn("helper@example.com", "helper password 2026")).ok, true);
  assert.deepEqual(await signIn("carol@example.com", ""), { ok: false, error: "Invalid email or password." });
  const hashes = await db.query(`select email, split_part(password_hash, ':', 1) as format from portal.admin_users order by email`);
  assert.deepEqual(hashes.map((h) => h.format), ["scrypt", "", "scrypt"], "both re-stored as scrypt at their first sign-in");
});

test("conversion: the sheet's text and date forms, missing codes, links by title, and the activity order", async () => {
  const { exported } = fixture();
  const S = "Responses";
  setCell(exported, S, 2, "Email Sent", manilaDate("2026-08-24", "10:30")); // Sheets turned the text into a date
  setCell(exported, S, 3, "cStatus", "OK");
  setCell(exported, S, 3, "Email Sent", "2026-08-24 09:30 (link sharing blocked: policy)");
  setCell(exported, S, 4, "Email Sent", "No recipient email");
  setCell(exported, S, 4, "Verification Code", "");
  setCell(exported, S, 4, "ActivityID", "A-OLDID"); // still linked by its title
  setCell(exported, S, 5, "ActivityID", "A-GONE");
  setCell(exported, S, 5, "Title of Activity", "A deleted activity");
  // Leadership Forum (row 2) was edited after Data Workshop (row 3) was made:
  // it still lists first.
  setCell(exported, "Activity", 2, "Timestamp", manilaDate("2026-08-25", "09:00"));
  exported.sheets.Responses.splice(3, 0, exported.sheets.Responses[0].map(() => "")); // a blank row, now row 4

  const converted = convertExport(exported);
  assert.deepEqual(converted.problems, []);
  const byRow = Object.fromEntries(converted.tables.responses.map((r) => [r.legacy_sheet_row, r]));
  const pick = (r) => ({ emailed_at: r.emailed_at, email_note: r.email_note, status: r.certificate_status });
  assert.deepEqual(pick(byRow[2]), { emailed_at: "2026-08-24T02:30:00.000Z", email_note: null, status: "issued" });
  assert.deepEqual(pick(byRow[3]), { emailed_at: "2026-08-24T01:30:00.000Z", email_note: "(link sharing blocked: policy)", status: "issued" });
  assert.deepEqual(pick(byRow[5]), { emailed_at: null, email_note: "No recipient email", status: "pending" });
  assert.match(byRow[5].verification_code, /^CHED-[A-F0-9]{20}$/);
  const activityOf = (row) => converted.tables.activities.find((a) => a.id === byRow[row].activity_id)?.code ?? null;
  assert.equal(activityOf(5), "A-WORK", "matched by title when its ActivityID is not found");
  assert.equal(activityOf(6), null);
  assert.deepEqual(converted.notes, [
    "1 response(s) name an activity no longer in the Activity sheet. They are kept, as in Sheets, without a link to one.",
    "1 response(s) had no verification code and were given one.",
    "1 blank row(s) in Responses were skipped.",
  ]);
  const [forum, workshop] = converted.tables.activities;
  assert.ok(forum.created_at < workshop.created_at && forum.updated_at > workshop.updated_at);

  // And all of it still shows as Apps Script shows it.
  const { db } = await freshDatabase();
  const result = await run(db, exported);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("the command line: a dry run checks everything and writes nothing; problems and a missing secret stop it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "import-test-"));
  try {
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify(fixture().exported));
    const bad = fixture().exported;
    setCell(bad, "Responses", 2, "Age", "");
    const badFile = join(dir, "bad.json");
    writeFileSync(badFile, JSON.stringify(bad));
    const cli = (args, env = { AUDIT_HASH_SECRET: AUDIT_SECRET }) =>
      promisify(execFile)(process.execPath, ["scripts/import-sheets.mjs", ...args], { env: { PATH: process.env.PATH, ...env } })
        .then(({ stdout }) => ({ code: 0, out: stdout }), (error) => ({ code: error.code, out: `${error.stdout}${error.stderr}` }));

    const dry = await cli([good, "--dry-run"]);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /Loaded into a throwaway in-memory database \(dry run\)/);
    assert.match(dry.out, /✓ audit chain: 4 entries verify, ending at the recorded head/);
    assert.match(dry.out, /Dry run: nothing was written\./);
    assert.ok(!/@example\.com|\bAna\b|\bBo\b/.test(dry.out), "the output names no participant");

    const refused = await cli([badFile, "--dry-run"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /Responses row 2: Age is not a whole number from 1 to 120\.\n\nNothing was written\./);

    const noSecret = await cli([good, "--dry-run"], {});
    assert.equal(noSecret.code, 2);
    assert.match(noSecret.out, /Set AUDIT_HASH_SECRET/);
    const noDatabase = await cli([good]);
    assert.equal(noDatabase.code, 2);
    assert.match(noDatabase.out, /Set IMPORT_DB_URL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the import works with the production driver's way of sending JSON, replacing a database included", async () => {
  const { db: pglite } = await freshDatabase();
  const db = asPostgresJs(pglite);
  // The stand-in is faithful: a bare ::json parameter fails exactly as it did against Supabase.
  await assert.rejects(db.query(`select json_array_elements_text($1::json)`, ['["a"]']), /cannot call json_array_elements_text on a scalar/);
  const { exported } = fixture();
  assert.equal((await run(db, exported)).ok, true);
  await pglite.query(`insert into portal.login_attempts (email_hash, attempts) values ('x', 1)`);
  const replaced = await run(db, exported, { replace: true, discardNewData: true });
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  assert.deepEqual(replaced.replaced.discarded, { responses: 0, audit: 0 });
});

test("the command line refuses the API's connection string for an import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "import-test-"));
  try {
    const file = join(dir, "export.json");
    writeFileSync(file, JSON.stringify(fixture().exported));
    const result = await promisify(execFile)(process.execPath, ["scripts/import-sheets.mjs", file], {
      env: { PATH: process.env.PATH, AUDIT_HASH_SECRET: AUDIT_SECRET,
        IMPORT_DB_URL: "postgresql://portal_api.abcdefgh:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres" },
    }).then(() => ({ code: 0 }), (error) => ({ code: error.code, out: error.stderr }));
    assert.equal(result.code, 2);
    assert.match(result.out, /That is the API's connection string \(user portal_api\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
