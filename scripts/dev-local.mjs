/*
 * Run the portal against the NEW backend with no Supabase project and no
 * Netlify: Vite serves the React app, and requests to the proxy are answered
 * by netlify/backend over an in-memory Postgres (PGlite) with the real
 * migrations applied.
 *
 *   npm run dev:local        then open http://localhost:5199
 *
 * Everything here is local and thrown away on exit. Turnstile uses
 * Cloudflare's published always-pass test key, and the proxy skips the
 * server-side check. To open /admin without a sign-in, run this in the
 * browser console, then reload:
 *
 *   sessionStorage.setItem("participant_feedback_admin_session",
 *     JSON.stringify({ token: "local-dev-session", expiresAt: Date.now() + 864e5,
 *                      user: { email: "admin@portal.test", name: "Local Admin", role: "superadmin" } }))
 */
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { createServer } from "vite";
import { handleAction } from "../netlify/backend/actions.mjs";
import { sessionTokenHash } from "../netlify/backend/crypto.mjs";
import { dateKey } from "../netlify/backend/time.mjs";

const PORT = Number(process.env.PORT || 5199);
process.env.VITE_USE_NETLIFY_PROXY = "true";
process.env.VITE_TURNSTILE_SITE_KEY = "1x00000000000000000000AA"; // Cloudflare's test key: always passes

const pg = new PGlite();
const migrations = new URL("../supabase/migrations/", import.meta.url);
for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort())
  await pg.exec(readFileSync(new URL(file, migrations), "utf8"));
const wrap = (runner) => ({ query: async (text, params = []) => (await runner.query(text, params)).rows });
const db = { ...wrap(pg), transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))) };

// Seed: one superadmin with a ready session, today's activity, and the survey
// as it is today (15 questions on three pages).
const today = dateKey(new Date());
await db.query(
  `insert into portal.admin_users (email, name, role, password_hash, password_salt, created_at)
   values ('admin@portal.test', 'Local Admin', 'superadmin', 'scrypt:none', 'none', '2026-01-01')`);
await db.query(
  `insert into portal.admin_sessions (token_hash, email, expires_at) values ($1, 'admin@portal.test', now() + interval '1 day')`,
  [sessionTokenHash("local-dev-session")]);
await db.query(
  `insert into portal.activities (code, title, venue, from_date, to_date, created_by, signatory_name, region,
     signatory_designation, signature_url, template_url, created_at)
   values ('A-LOCAL01', 'Leadership Forum', 'CHED Auditorium', $1, $1, 'admin@portal.test', 'Maria Santos', 'NCR',
     'Director', 'https://drive.google.com/file/d/local-signature', 'https://drive.google.com/file/d/local-template', '2026-01-01')`,
  [today]);
const pages = ["Program content", "Event experience", "Overall reflection"];
const texts = [
  "The activity objectives were clearly communicated.", "The topics were relevant to my work.",
  "The speakers demonstrated strong subject knowledge.", "The presentations were clear and well organized.",
  "The learning materials supported the sessions.", "The activities encouraged meaningful participation.",
  "The time allotted for each session was appropriate.", "The venue and facilities supported learning.",
  "The event staff were helpful and professional.", "The registration process was smooth.",
  "The activity met my expectations.", "I gained knowledge I can apply in my role.",
  "I would recommend this activity to colleagues.", "Would you attend a similar activity?",
  "What should we change next time?",
];
for (const [s, name] of pages.entries()) {
  const [section] = await db.query(
    `insert into portal.survey_sections (name, position, created_at) values ($1, $2, '2026-01-01') returning id`, [name, s + 1]);
  for (let q = 0; q < 5; q++)
    await db.query(
      `insert into portal.questions (section_id, position, text, type, created_at) values ($1, $2, $3, $4, '2026-01-01')`,
      [section.id, q, texts[s * 5 + q], s * 5 + q === 13 ? "yesno" : s * 5 + q === 14 ? "text" : "rating"]);
}

const server = await createServer({
  server: { port: PORT, strictPort: true },
  plugins: [{
    name: "local-backend",
    configureServer(vite) {
      vite.middlewares.use("/.netlify/functions/gas-proxy", (req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          let reply;
          try {
            const payload = JSON.parse(body || "{}");
            delete payload.turnstileToken;
            reply = await handleAction(payload, { db, secrets: { auditSecret: "local-audit-secret" } });
          } catch (error) {
            reply = { ok: false, error: error.message };
          }
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify(reply));
        });
      });
    },
  }],
});
await server.listen();
console.log(`Portal on the new backend (in-memory Postgres): http://localhost:${PORT}`);
