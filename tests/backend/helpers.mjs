import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = new URL("../../supabase/migrations/", import.meta.url);

/**
 * A brand-new Postgres (PGlite, in memory) with every migration applied, and
 * the same two-method adapter the backend uses in production.
 */
export async function freshDatabase() {
  const pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort())
    await pg.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  const wrap = (runner) => ({
    query: async (text, params = []) => (await runner.query(text, params)).rows,
  });
  return {
    pg,
    db: { ...wrap(pg), transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))) },
  };
}

/** The survey as it is today: 15 questions in three sections. Returns question IDs in order. */
export async function seedQuestions(db, count = 15, types = {}) {
  const sections = await db.query(
    // Created well before any test response, so they count as "on the form" for it.
    `insert into portal.survey_sections (name, position, created_at) values
       ('Program content', 1, '2026-01-01'), ('Event experience', 2, '2026-01-01'), ('Overall reflection', 3, '2026-01-01')
     returning id`,
  );
  const ids = [];
  for (let i = 0; i < count; i++) {
    const [q] = await db.query(
      `insert into portal.questions (section_id, position, text, type, created_at) values ($1, $2, $3, $4, '2026-01-01') returning id`,
      [sections[Math.min(2, Math.floor(i / 5))].id, i % 5, `Question ${i + 1}`, types[i + 1] ?? (i === 14 ? "text" : "rating")],
    );
    ids.push(q.id);
  }
  return ids;
}

export async function seedAdmin(db, { email = "boss@example.com", name = "Boss", role = "superadmin",
  active = true, hash, salt = "salt-1" } = {}) {
  await db.query(
    `insert into portal.admin_users (email, name, role, active, password_hash, password_salt)
     values ($1, $2, $3, $4, $5, $6)`,
    [email, name, role, active, hash, salt],
  );
}

/** A signed-in session for `email`, without going through sign-in. */
export async function seedSession(db, email, token, expiresAt = "2099-01-01T00:00:00Z") {
  const { sessionTokenHash } = await import("../../netlify/backend/crypto.mjs");
  await db.query(
    `insert into portal.admin_sessions (token_hash, email, expires_at) values ($1, $2, $3)`,
    [sessionTokenHash(token), email, expiresAt],
  );
}

let codes = 0;
/** A unique, well-formed verification code. */
export const nextCode = () =>
  `CHED-${(++codes).toString(16).toUpperCase().padStart(20, "0")}`;

export async function seedActivity(db, values = {}) {
  const row = {
    code: `A-${Math.random().toString(16).slice(2, 10)}`,
    title: "Leadership Forum",
    venue: "CHED Auditorium",
    from_date: "2026-08-24",
    to_date: "2026-08-24",
    active: true,
    ...values,
  };
  const [created] = await db.query(
    `insert into portal.activities (code, title, venue, from_date, to_date, active)
     values ($1, $2, $3, $4, $5, $6) returning id, code`,
    [row.code, row.title, row.venue, row.from_date, row.to_date, row.active],
  );
  return created;
}

export async function seedResponse(db, activity, values = {}) {
  const row = {
    name: "Ana Reyes",
    email: "ana@example.com",
    status: "pending",
    code: nextCode(),
    ...values,
  };
  const [created] = await db.query(
    `insert into portal.responses
       (activity_id, activity_code, activity_title, venue, activity_date, name, email, sex, age,
        certificate_status, verification_code, certificate_url, emailed_at, claimed_at)
     values ($1, $2, 'Leadership Forum', 'CHED Auditorium', '2026-08-24', $3, $4, 'Female', 30,
             $5, $6, $7, $8, $9)
     returning id::int as id`,
    [activity.id, activity.code, row.name, row.email, row.status, row.code,
     row.certificate_url ?? null, row.emailed_at ?? null, row.claimed_at ?? null],
  );
  return { ...created, code: row.code };
}
