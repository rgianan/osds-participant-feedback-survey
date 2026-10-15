import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, nextCode, seedActivity, seedResponse } from "./helpers.mjs";

test("the migration creates the plan's ten tables in the portal schema", async () => {
  const { db } = await freshDatabase();
  const rows = await db.query(
    `select table_name from information_schema.tables where table_schema = 'portal' order by 1`,
  );
  assert.deepEqual(rows.map((r) => r.table_name), [
    "activities", "admin_sessions", "admin_users", "answers", "audit_log",
    "login_attempts", "questions", "responses", "settings", "survey_sections",
  ]);
});

test("an activity cannot end before it starts", async () => {
  const { db } = await freshDatabase();
  await assert.rejects(
    seedActivity(db, { from_date: "2026-09-10", to_date: "2026-09-01" }),
    /activities_end_not_before_start/,
  );
});

test("one response per activity and email, case-insensitive; failed rows do not count", async () => {
  const { db } = await freshDatabase();
  const activity = await seedActivity(db);
  const first = await seedResponse(db, activity, { email: "Ana@Example.com" });
  await assert.rejects(
    seedResponse(db, activity, { email: "ana@example.com" }),
    /responses_one_per_activity_email/,
  );
  // Another activity, same email: allowed.
  await seedResponse(db, await seedActivity(db), { email: "ana@example.com" });
  // The first certificate fails; the participant may submit again...
  await db.query(`update portal.responses set certificate_status = 'failed' where id = $1`, [first.id]);
  await seedResponse(db, activity, { email: "ana@example.com" });
  // ...and retrying the failed row is now refused, so no second certificate is issued.
  await assert.rejects(
    db.query(`update portal.responses set certificate_status = 'pending' where id = $1`, [first.id]),
    /responses_one_per_activity_email/,
  );
});

test("verification codes must be well-formed and unique", async () => {
  const { db } = await freshDatabase();
  const activity = await seedActivity(db);
  await assert.rejects(seedResponse(db, activity, { code: "CHED-123" }), /verification_code_check/);
  const code = nextCode();
  await seedResponse(db, activity, { code, email: "a@example.com" });
  await assert.rejects(seedResponse(db, activity, { code, email: "b@example.com" }), /verification_code_key/);
});

test("the audit log refuses updates, deletes and truncation, even from its owner", async () => {
  const { db } = await freshDatabase();
  await db.query(
    `insert into portal.audit_log (logged_at, audit_id, action, outcome, entry_hash)
     values ('2026-10-13 08:00:00', 'AUD-1', 'LOGIN', 'SUCCESS', 'h1')`,
  );
  await assert.rejects(db.query(`update portal.audit_log set outcome = 'FAILURE'`), /append-only/);
  await assert.rejects(db.query(`delete from portal.audit_log`), /append-only/);
  await assert.rejects(db.query(`truncate portal.audit_log`), /append-only/);
  await assert.rejects(
    db.query(
      `insert into portal.audit_log (logged_at, audit_id, action, outcome, entry_hash)
       values ('2026-10-13 8:00:00', 'AUD-2', 'LOGIN', 'SUCCESS', 'h2')`,
    ),
    /logged_at_check/,
    "a timestamp without its leading zero is not the hashed text",
  );
});

test("portal_api can run the portal, but cannot change the audit log", async () => {
  const { pg, db } = await freshDatabase();
  const activity = await seedActivity(db);
  await pg.exec("set role portal_api");
  try {
    assert.equal((await db.query(`select count(*)::int as n from portal.activities`))[0].n, 1);
    await seedResponse(db, activity);
    await db.query(
      `insert into portal.audit_log (logged_at, audit_id, action, outcome, entry_hash)
       values ('2026-10-13 08:00:00', 'AUD-1', 'LOGIN', 'SUCCESS', 'h1')`,
    );
    await assert.rejects(db.query(`update portal.audit_log set outcome = 'FAILURE'`), /permission denied/);
    await assert.rejects(db.query(`delete from portal.audit_log`), /permission denied/);
  } finally {
    await pg.exec("reset role");
  }
});

test("a role without a policy reads nothing, as Supabase's public key would", async () => {
  const { pg, db } = await freshDatabase();
  await seedActivity(db);
  await pg.exec(`create role outsider; grant usage on schema portal to outsider;
                 grant select on portal.activities to outsider; set role outsider`);
  try {
    assert.equal((await db.query(`select count(*)::int as n from portal.activities`))[0].n, 0);
  } finally {
    await pg.exec("reset role");
  }
});

test("the worker claims pending and abandoned jobs, never live ones or ended activities", async () => {
  const { db } = await freshDatabase();
  const open = await seedActivity(db);
  const ended = await seedActivity(db, { active: false });
  const pending = await seedResponse(db, open, { email: "p@example.com" });
  const abandoned = await seedResponse(db, open, {
    email: "a@example.com", status: "processing", claimed_at: new Date(Date.now() - 20 * 60e3).toISOString(),
  });
  await seedResponse(db, open, { email: "l@example.com", status: "processing", claimed_at: new Date().toISOString() });
  await seedResponse(db, ended, { email: "e@example.com" });
  await seedResponse(db, open, { email: "i@example.com", status: "issued" });

  const claimed = await db.query(
    `select response_id::int as id, claim_token::text as token from portal.claim_certificate_jobs(10)`,
  );
  assert.deepEqual(claimed.map((r) => r.id).sort(), [pending.id, abandoned.id].sort());
  assert.equal(new Set(claimed.map((r) => r.token)).size, 2, "each job gets its own claim token");
  const [row] = await db.query(
    `select certificate_status::text as status, attempts from portal.responses where id = $1`, [pending.id],
  );
  assert.deepEqual(row, { status: "processing", attempts: 1 });
  assert.equal((await db.query(`select * from portal.claim_certificate_jobs(10)`)).length, 0,
    "a second run straight after finds nothing to take");
});

test("portal_api's sessions give up instead of waiting until Netlify cuts the function off", async () => {
  const { db } = await freshDatabase();
  const [role] = await db.query(`select array_to_string(rolconfig, ',') as config from pg_roles where rolname = 'portal_api'`);
  assert.equal(role.config, "lock_timeout=5s,statement_timeout=15s,idle_in_transaction_session_timeout=10s");
});
