import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAction } from "../../netlify/backend/actions.mjs";
import { auditCanonical } from "../../netlify/backend/audit.mjs";
import { hmacBase64, legacyPasswordHash, sessionTokenHash, v2PasswordHash } from "../../netlify/backend/crypto.mjs";
import { freshDatabase, seedAdmin } from "./helpers.mjs";

const PEPPER = "pepper-from-gas";
const AUDIT = "audit-secret";
const NOW = new Date("2026-10-13T02:00:00Z");
const minutes = (n) => new Date(NOW.getTime() + n * 60e3);
const call = (db, body, now = NOW) =>
  handleAction(body, { db, now, secrets: { passwordPepper: PEPPER, auditSecret: AUDIT }, requestId: "req-1" });
const login = (db, password, now, email = "Boss@Example.com") => call(db, { action: "adminLogin", email, password }, now);

async function withAdmin(hashFormat = "v2", values = {}) {
  const { db, pg } = await freshDatabase();
  const hash = hashFormat === "v2" ? v2PasswordHash("correct horse 1", "salt-1", PEPPER) : legacyPasswordHash("correct horse 1", "salt-1");
  await seedAdmin(db, { hash, ...values });
  return { db, pg };
}

test("signing in returns a 6-hour session, stored only as a hash of its token", async () => {
  const { db } = await withAdmin();
  const reply = await login(db, "correct horse 1");
  assert.equal(reply.ok, true, reply.error);
  assert.match(reply.data.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(reply.data.user, { email: "boss@example.com", name: "Boss", role: "superadmin" });
  assert.equal(reply.data.expiresAt, NOW.getTime() + 6 * 3600e3);
  const sessions = await db.query(`select token_hash from portal.admin_sessions`);
  assert.deepEqual(sessions, [{ token_hash: sessionTokenHash(reply.data.token) }]);
});

test("both Apps Script password formats sign in, and are re-stored as scrypt", async () => {
  for (const format of ["v2", "legacy"]) {
    const { db } = await withAdmin(format);
    assert.equal((await login(db, "correct horse 1")).ok, true, `${format} signs in`);
    const [user] = await db.query(`select password_hash, password_salt from portal.admin_users`);
    assert.match(user.password_hash, /^scrypt:32768:8:1:/, `${format} is upgraded`);
    assert.notEqual(user.password_salt, "salt-1", "a fresh salt comes with the new hash");
    assert.equal((await login(db, "correct horse 1", minutes(1))).ok, true, "the scrypt hash works next time");
    assert.equal((await login(db, "wrong horse 1", minutes(2))).error, "Invalid email or password.");
  }
});

test("wrong password, unknown and deactivated accounts all get the same answer", async () => {
  const { db } = await withAdmin();
  await seedAdmin(db, { email: "gone@example.com", active: false, hash: v2PasswordHash("correct horse 1", "salt-1", PEPPER) });
  for (const [email, password] of [["boss@example.com", "nope"], ["who@example.com", "correct horse 1"], ["gone@example.com", "correct horse 1"]])
    assert.deepEqual(await login(db, password, NOW, email), { ok: false, error: "Invalid email or password." });
});

test("five attempts, then locked for 15 minutes after the latest; a success clears the count", async () => {
  const { db } = await withAdmin();
  for (let i = 0; i < 5; i++) assert.equal((await login(db, "nope", minutes(i))).error, "Invalid email or password.");
  const locked = "Too many sign-in attempts. Try again in 15 minutes.";
  assert.equal((await login(db, "correct horse 1", minutes(5))).error, locked, "even the right password is refused");
  assert.equal((await login(db, "correct horse 1", minutes(18))).error, locked, "14 minutes after the 5th: still locked");
  assert.equal((await login(db, "correct horse 1", minutes(20))).ok, true, "15 minutes after the 5th: open again");
  assert.equal((await db.query(`select count(*)::int as n from portal.login_attempts`))[0].n, 0);
});

test("a session validates until it expires or the account is deactivated", async () => {
  const { db } = await withAdmin();
  const { token } = (await login(db, "correct horse 1")).data;
  const validate = (now) => call(db, { action: "adminValidateSession", adminToken: token }, now);
  assert.deepEqual((await validate(minutes(60))).data, {
    user: { email: "boss@example.com", name: "Boss", role: "superadmin" }, expiresAt: NOW.getTime() + 6 * 3600e3,
  });
  assert.deepEqual(await validate(minutes(6 * 60 + 1)), { ok: false, error: "Your admin session has expired." });
  assert.equal((await db.query(`select count(*)::int as n from portal.admin_sessions`))[0].n, 0, "the expired session is removed");

  const second = (await login(db, "correct horse 1", minutes(400))).data.token;
  await db.query(`update portal.admin_users set active = false`);
  assert.deepEqual(await call(db, { action: "adminValidateSession", adminToken: second }, minutes(401)),
    { ok: false, error: "Your admin session has expired." });
});

test("signing out ends the session; signing in clears sessions that ran out", async () => {
  const { db } = await withAdmin();
  const first = (await login(db, "correct horse 1")).data.token;
  assert.deepEqual(await call(db, { action: "adminLogout", adminToken: first }), { ok: true, data: true });
  assert.equal((await call(db, { action: "adminValidateSession", adminToken: first })).error, "Your admin session has expired.");

  await db.query(`insert into portal.admin_sessions (token_hash, email, expires_at) values ('old', 'boss@example.com', '2026-01-01')`);
  await login(db, "correct horse 1", minutes(1));
  assert.equal((await db.query(`select count(*)::int as n from portal.admin_sessions where token_hash = 'old'`))[0].n, 0);
});

test("sign-ins and sign-outs are audited in one verifiable chain", async () => {
  const { db } = await withAdmin();
  await login(db, "nope");
  const { token } = (await login(db, "correct horse 1", minutes(1))).data;
  await call(db, { action: "adminLogout", adminToken: token }, minutes(2));
  await call(db, { action: "adminValidateSession", adminToken: token }, minutes(3)); // not an audited action

  const entries = await db.query(`select * from portal.audit_log order by id`);
  assert.deepEqual(entries.map((e) => [e.action, e.outcome, e.actor_email, e.actor_role, e.target_id, e.details]), [
    ["LOGIN", "FAILURE", "boss@example.com", "", "Boss@Example.com", '{"error":"Invalid email or password."}'],
    ["LOGIN", "SUCCESS", "boss@example.com", "superadmin", "Boss@Example.com", "{}"],
    ["LOGOUT", "SUCCESS", "boss@example.com", "superadmin", "boss@example.com", "{}"],
  ]);
  assert.equal(entries[0].logged_at, "2026-10-13 10:00:00", "Manila time, zero-padded");
  assert.equal(entries[0].request_id, "req-1");
  entries.forEach((entry, i) => {
    assert.equal(entry.previous_hash, i ? entries[i - 1].entry_hash : "", "each entry links to the one before");
    assert.equal(entry.entry_hash, hmacBase64(auditCanonical(entry), AUDIT), "each entry verifies");
  });
  const [head] = await db.query(`select value from portal.settings where key = 'audit_head_hash'`);
  assert.equal(head.value, entries.at(-1).entry_hash);
});

test("a broken audit write never fails the sign-in", async () => {
  const { db } = await withAdmin();
  const flaky = { ...db, transaction: () => Promise.reject(new Error("audit table locked")) };
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal((await login(flaky, "correct horse 1")).ok, true);
  } finally {
    console.error = quiet;
  }
});

test("without PASSWORD_PEPPER a v2 password cannot be checked, and says so", async () => {
  const { db } = await withAdmin();
  const reply = await handleAction({ action: "adminLogin", email: "boss@example.com", password: "correct horse 1" }, { db, now: NOW });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /PASSWORD_PEPPER/);
});
