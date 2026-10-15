import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAction } from "../../netlify/backend/actions.mjs";
import { auditCanonical } from "../../netlify/backend/audit.mjs";
import { hmacBase64 } from "../../netlify/backend/crypto.mjs";
import { freshDatabase, seedAdmin, seedSession } from "./helpers.mjs";

/** What the contract tests cannot show for users, questions, the audit log and uploads. */

const NOW = new Date("2026-08-24T02:00:00Z");
const SECRET = "audit-secret";

async function asSuperadmin() {
  const { db } = await freshDatabase();
  await seedAdmin(db, { email: "boss@example.com", role: "superadmin", hash: "x" });
  await seedSession(db, "boss@example.com", "tok");
  const call = (action, extra = {}, context = {}) =>
    handleAction({ action, adminToken: "tok", ...extra }, { db, now: NOW, secrets: { auditSecret: SECRET }, ...context });
  return { db, call };
}

test("a new account can sign in with its password, stored only as an scrypt hash", async () => {
  const { db, call } = await asSuperadmin();
  const saved = await call("adminSaveUser", { payload: { email: "carol@example.com", name: "Carol", role: "admin", password: "a long enough password" } });
  assert.equal(saved.ok, true, saved.error);
  const [row] = await db.query(`select password_hash from portal.admin_users where email = 'carol@example.com'`);
  assert.match(row.password_hash, /^scrypt:/);
  assert.equal((await handleAction({ action: "adminLogin", email: "carol@example.com", password: "a long enough password" },
    { db, now: NOW })).ok, true);

  await call("adminSaveUser", { payload: { email: "carol@example.com", name: "Carol", role: "admin", password: "a different password" } });
  const login = (password) => handleAction({ action: "adminLogin", email: "carol@example.com", password }, { db, now: new Date(NOW.getTime() + 60e3) });
  assert.equal((await login("a long enough password")).error, "Invalid email or password.", "the old password stops working");
  assert.equal((await login("a different password")).ok, true);
});

test("the first save of questions creates the three sections, and later edits keep each question's ID", async () => {
  const { db, call } = await asSuperadmin();
  const questions = Array.from({ length: 15 }, (_, i) => ({ text: `Question ${i + 1}`, type: "rating" }));
  assert.equal((await call("adminSaveQuestions", { questions })).ok, true);
  const layout = await db.query(
    `select s.name, count(*)::int as n from portal.questions q join portal.survey_sections s on s.id = q.section_id
      group by s.name, s.position order by s.position`);
  assert.deepEqual(layout, [
    { name: "Program content", n: 5 }, { name: "Event experience", n: 5 }, { name: "Overall reflection", n: 5 },
  ]);
  const before = await db.query(`select id from portal.questions order by created_at, position`);
  questions[3] = { text: "Reworded question 4", type: "yesno" };
  await call("adminSaveQuestions", { questions });
  const after = await db.query(`select id, text, type::text as type from portal.questions order by created_at, position`);
  assert.deepEqual(after.map((q) => q.id), before.map((q) => q.id), "edited in place, so stored answers stay with their question");
  assert.deepEqual(after[3], { id: before[3].id, text: "Reworded question 4", type: "yesno" });
});

test("the audit screen spots a row changed in the table, and treats an empty log as intact", async () => {
  const { db, call } = await asSuperadmin();
  assert.deepEqual((await call("adminGetAuditLog", { filters: {} })).data, { entries: [], integrity: { valid: true, checkedRows: 0 } });

  const entry = { logged_at: "2026-08-24 09:00:00", audit_id: "AUD-1", actor_email: "boss@example.com", actor_role: "superadmin",
    action: "LOGIN", target_type: "session", target_id: "boss@example.com", outcome: "SUCCESS", details: "{}", request_id: "", previous_hash: "" };
  entry.entry_hash = hmacBase64(auditCanonical(entry), SECRET);
  // Inserted with its outcome altered after hashing: what editing the table directly would leave.
  await db.query(
    `insert into portal.audit_log (logged_at, audit_id, actor_email, actor_role, action, target_type, target_id, outcome,
       details, request_id, previous_hash, entry_hash) values ($1, $2, $3, $4, $5, $6, $7, 'FAILURE', $8, $9, $10, $11)`,
    [entry.logged_at, entry.audit_id, entry.actor_email, entry.actor_role, entry.action, entry.target_type, entry.target_id,
     entry.details, entry.request_id, entry.previous_hash, entry.entry_hash]);
  assert.deepEqual((await call("adminGetAuditLog", { filters: {} })).data.integrity, { valid: false, checkedRows: 1 });
});

test("an upload with Netlify's Apps Script settings missing says which are needed", async () => {
  const { call } = await asSuperadmin();
  const reply = await call("adminUploadSignature", { payload: { filename: "s.png", mimeType: "image/png", base64: "iVBORw0K" } });
  assert.deepEqual(reply, {
    ok: false,
    error: "Signature upload is not configured: set GAS_WEB_APP_URL, SUBMIT_SHARED_TOKEN and WORKER_TOKEN in the site's environment variables.",
  });
});
