import { test } from "node:test";
import assert from "node:assert/strict";
import { handler as proxy } from "../../netlify/functions/gas-proxy.mjs";
import { handler as worker } from "../../netlify/functions/worker.mjs";
import { handleWorkerRequest } from "../../netlify/backend/worker.mjs";
import { checkApiDatabase, checkOwnerDatabase, checkSite } from "../../scripts/lib/setup-check.mjs";
import { freshDatabase } from "./helpers.mjs";

/** The setup check (npm run check:setup) that verifies the cutover's setup without showing a secret. */

const API_URL = "postgresql://portal_api.abcdefgh:secret-password@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres";
const OWNER_URL = "postgresql://postgres.abcdefgh:secret-password@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres";
const labels = (results) => results.map((r) => `${r.status} ${r.label}`);

test("the API database: a correct setup passes every check, signed in as portal_api", async () => {
  const { db, pg } = await freshDatabase();
  await pg.exec("set role portal_api");
  const results = await checkApiDatabase(API_URL, db);
  assert.deepEqual(labels(results), [
    "pass user portal_api, host aws-0-ap-southeast-1.pooler.supabase.com",
    "pass transaction pooler (port 6543)",
    "pass database in Singapore (ap-southeast-1)",
    "pass signs in as portal_api",
    "pass all 10 tables",
    "pass certificate attempt cap (second migration)",
    "pass time limits on portal_api's sessions (third migration)",
    "pass row-level security on every table",
    "pass audit log is append-only for portal_api",
    "info empty: ready for the import",
  ]);
  assert.ok(!JSON.stringify(results).includes("secret-password"), "the password is never shown");
});

test("the API database: the wrong user and a missing migration are named, with what to do", async () => {
  const { db, pg } = await freshDatabase();
  await pg.exec(`create or replace function portal.claim_certificate_jobs(batch_size integer default 10, lease interval default '15 minutes')
                 returns table (response_id bigint, claim_token uuid) language sql as $$ select null::bigint, null::uuid where false $$`);
  const results = await checkApiDatabase(API_URL.replace(":6543", ":5432").replace("portal_api.", "postgres."), db);
  const failed = results.filter((r) => r.status !== "pass" && r.status !== "info");
  assert.deepEqual(failed.map((r) => [r.status, r.label]), [
    ["fail", "user postgres.abcdefgh, host aws-0-ap-southeast-1.pooler.supabase.com"],
    ["warn", "port 5432"],
    ["fail", "signs in as postgres"],
    ["fail", "no certificate attempt cap"],
    ["fail", "no time limits on portal_api's sessions"],
    ["fail", "portal_api can delete audit entries"],
  ]);
  assert.match(failed[3].hint, /20261014000000_worker_attempt_cap\.sql/);
  const down = await checkApiDatabase(API_URL, async () => ({ query: async () => { throw new Error('password authentication failed for user "portal_api"'); } }));
  assert.deepEqual(down.at(-1), { status: "fail", label: "cannot sign in",
    hint: "The password is wrong, or portal_api has none yet. In Supabase's SQL editor: alter role portal_api with login password '…';" });
});

test("the owner's connection must own the tables", async () => {
  const { db } = await freshDatabase();
  assert.deepEqual(labels(await checkOwnerDatabase(OWNER_URL, db)), [
    "pass user postgres, host aws-0-ap-southeast-1.pooler.supabase.com",
    "pass session pooler (port 5432)",
    "pass signs in as postgres, the tables' owner",
  ]);
});

/** A site whose proxy and worker are the real Netlify functions, run here with the given settings. */
function siteWith(env) {
  return async (url, init) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const path = new URL(url).pathname;
      const handler = path === "/.netlify/functions/gas-proxy" ? proxy : path === "/.netlify/functions/worker" ? worker : null;
      if (!handler) return new Response("Not found", { status: 404 });
      const reply = await handler({ httpMethod: init.method, headers: Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])),
        body: init.body });
      return new Response(reply.body, { status: reply.statusCode });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  };
}

test("a site that is half set up: each missing piece is named", async () => {
  const fetch = siteWith({ BACKEND: "supabase", GAS_WEB_APP_URL: "https://script.google.com/macros/s/X/exec", SUBMIT_SHARED_TOKEN: "s".repeat(64),
    SUPABASE_DB_URL: "", TURNSTILE_SECRET_KEY: "", WORKER_TOKEN: "w".repeat(96) });
  const results = await checkSite("https://staging.example.netlify.app/", { fetch, workerToken: "w".repeat(96) });
  assert.deepEqual(results.map((r) => [r.status, r.label, r.hint]), [
    ["fail", "the proxy refuses requests", "The database is not configured. Set SUPABASE_DB_URL in the site's environment variables."],
    ["fail", "Turnstile", "Turnstile is not configured on the server."],
    ["pass", "worker endpoint up, and refuses requests without its token", undefined],
    ["fail", "the worker endpoint cannot work", "The database is not configured. Set SUPABASE_DB_URL in the site's environment variables."],
  ]);
  const wrongToken = await checkSite("https://staging.example.netlify.app", { fetch, workerToken: "x".repeat(96) });
  assert.equal(wrongToken.at(-1).label, "WORKER_TOKEN does not match the site's");
  assert.equal((await checkSite("https://elsewhere.example", { fetch: async () => new Response("<html>", { status: 404 }) }))[0].label,
    "no portal proxy at this address");
});

test("a site that is set up: the backend, Turnstile, and from inside, the database and every setting", async () => {
  const { db } = await freshDatabase();
  const answers = {
    getQuestions: { ok: true, data: { sections: [] } },
    getActivityData: { ok: true, data: [] },
    submitFeedback: { ok: false, error: "Please complete the security verification." },
  };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/gas-proxy")) return new Response(JSON.stringify(answers[body.action]), { status: answers[body.action].ok ? 200 : 400 });
    if (!init.headers.authorization) return new Response(JSON.stringify({ ok: false, error: "Forbidden: invalid worker token." }), { status: 401 });
    // The worker's own ping, run on a real database, as the function runs it.
    const setup = { backend: "supabase", maintenance: false,
      settings: { PORTAL_BASE_URL: true, PASSWORD_PEPPER: true, AUDIT_HASH_SECRET: false, GAS_WEB_APP_URL: true, SUBMIT_SHARED_TOKEN: true, TURNSTILE_SECRET_KEY: true } };
    return new Response(JSON.stringify(await handleWorkerRequest(body, { db, now: new Date(), setup })), { status: 200 });
  };
  const results = await checkSite("https://staging.example.netlify.app", { fetch, workerToken: "w".repeat(96) });
  assert.deepEqual(results.map((r) => `${r.status} ${r.label.replace(/\d+ ms/, "N ms")}`), [
    "pass answers from the new backend (BACKEND=supabase)",
    "info activity list: N ms (median of 3, from here)",
    "pass Turnstile secret is set (its hostname list is checked only by a real submission: sign in once)",
    "pass worker endpoint up, and refuses requests without its token",
    "pass database round trip from the site: N ms",
    "fail not set on the site: AUDIT_HASH_SECRET",
    "info BACKEND: supabase",
  ]);
});

test("a string pasted twice, or not ending in /postgres, is caught before signing in", async () => {
  const never = async () => { throw new Error("should not connect"); };
  assert.deepEqual(await checkApiDatabase(API_URL + API_URL, never), [{ status: "fail", label: "the string appears twice",
    hint: "It was pasted twice, or with another string after it. Paste it once." }]);
  assert.equal((await checkOwnerDatabase(OWNER_URL.replace(/\/postgres$/, "/postgres2"), never))[0].label, "the string does not end in /postgres");
  // And the pooler's own wording for it, should it get that far.
  const refused = await checkApiDatabase(API_URL, async () => ({ query: async () => { throw new Error('(EINVALIDUSERINFO) Authentication error, reason: "Invalid format for user or db_name"'); } }));
  assert.match(refused.at(-1).hint, /must end in \/postgres with nothing after it/);
});

test("a site can be given by any of its pages", async () => {
  const seen = [];
  const fetch = async (url) => { seen.push(url); return new Response("<html>", { status: 404 }); };
  await checkSite("https://ched-feedback-survey.netlify.app/admin", { fetch });
  assert.equal(seen[0], "https://ched-feedback-survey.netlify.app/.netlify/functions/gas-proxy");
});

test("the page must be built with a Turnstile site key: VITE_ variables are read only at build time", async () => {
  const page = (siteKey) => async (url, init) => {
    if (url.endsWith("/")) return new Response('<html><script type="module" crossorigin src="/assets/index-abc.js"></script></html>');
    if (url.endsWith("/assets/index-abc.js")) return new Response(`const k=${JSON.stringify(siteKey)};render(k||"")`);
    if (url.endsWith("/gas-proxy")) {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify(body.action === "submitFeedback" ? { ok: false, error: "Please complete the security verification." }
        : { ok: true, data: { sections: [] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: "Forbidden: invalid worker token." }), { status: 401 });
  };
  const line = async (siteKey) => (await checkSite("https://staging.example.netlify.app", { fetch: page(siteKey) }))
    .find((r) => /site key/.test(r.label));
  assert.deepEqual(await line(""), { status: "fail", label: "the page was built without a Turnstile site key",
    hint: "Set VITE_TURNSTILE_SITE_KEY for builds, then deploy again without the build cache (Netlify: Trigger deploy → Clear cache and deploy site; Vercel: Redeploy, build cache off)." });
  assert.equal((await line("0x4AAAAAAAexample-site-key")).status, "pass");
});
