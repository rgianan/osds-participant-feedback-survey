/**
 * The checks behind `npm run check:setup` (docs/cutover-checklist.md, "Once,
 * before the rehearsal"). Each returns a list of results:
 *
 *   { status: "pass" | "fail" | "warn" | "info", label, hint? }
 *
 * They read and never change anything, and never report a secret: a
 * connection string is shown by its host, a setting by whether it is set.
 */

const TABLES = ["admin_users", "activities", "survey_sections", "questions", "responses", "answers", "audit_log",
  "admin_sessions", "login_attempts", "settings"];
const pass = (label) => ({ status: "pass", label });
const fail = (label, hint) => ({ status: "fail", label, hint });
const warn = (label, hint) => ({ status: "warn", label, hint });
const info = (label) => ({ status: "info", label });

/** What a connection string says about itself, without its password. */
export function describeDatabaseUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      user: decodeURIComponent(parsed.username),
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
      database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
      singapore: /ap-southeast-1/.test(parsed.hostname),
      // Two strings run together: easy to do when the paste is not shown.
      repeated: (String(url).match(/postgres(?:ql)?:\/\//g) || []).length > 1,
    };
  } catch {
    return null;
  }
}

/** A database error, as something to do about it. */
function connectionHint(error, role) {
  const message = String(error?.message || error);
  if (/password authentication failed/i.test(message))
    return role === "portal_api"
      ? "The password is wrong, or portal_api has none yet. In Supabase's SQL editor: alter role portal_api with login password '…';"
      : "The password is wrong: it is the database password set when the project was created (Supabase → Project Settings → Database).";
  if (/tenant or user not found/i.test(message)) return `The user must be ${role}.<project-ref>, as Supabase → Connect shows it.`;
  if (/invalid format for user or db_name/i.test(message))
    return `The pooler could not read the user or database name. The user must be ${role}.<project-ref>, and the string must end in /postgres with nothing after it.`;
  if (/ENOTFOUND|getaddrinfo/i.test(message)) return "The host name is wrong: copy the string again from Supabase → Connect.";
  if (/timeout|ETIMEDOUT|ECONNREFUSED/i.test(message)) return "Nothing answered: check the host and port, and that this network allows outgoing database connections.";
  return message;
}

/**
 * SUPABASE_DB_URL: the connection the API uses. `db` is { query, transaction }
 * already connected, or a function that connects and returns one.
 */
/** A string that could not work whatever its password: pasted twice, or not ending in /postgres. */
function malformed(shape) {
  if (shape.repeated) return fail("the string appears twice", "It was pasted twice, or with another string after it. Paste it once.");
  if (shape.database !== "postgres") return fail("the string does not end in /postgres", "Copy it again from Supabase → Connect: the database name is postgres.");
  return null;
}

export async function checkApiDatabase(url, db) {
  const results = [];
  const shape = describeDatabaseUrl(url);
  if (!shape) return [fail("SUPABASE_DB_URL is not a connection string", "Copy it from Supabase → Connect → Transaction pooler.")];
  const broken = malformed(shape);
  if (broken) return [broken];
  results.push(shape.user.startsWith("portal_api.")
    ? pass(`user ${shape.user.split(".")[0]}, host ${shape.host}`)
    : fail(`user ${shape.user}, host ${shape.host}`, "Use portal_api.<project-ref>: the API connects as portal_api, never as postgres."));
  results.push(shape.port === 6543
    ? pass("transaction pooler (port 6543)")
    : warn(`port ${shape.port}`, "Use the transaction pooler, port 6543: it is made for functions that open many short connections."));
  results.push(shape.singapore ? pass("database in Singapore (ap-southeast-1)")
    : warn("database not in Singapore", "The plan puts the database in ap-southeast-1, next to the functions."));

  let conn;
  try {
    conn = typeof db === "function" ? await db() : db;
    const [me] = await conn.query(`select current_user::text as name`);
    if (me.name !== "portal_api")
      results.push(fail(`signs in as ${me.name}`, "The API must sign in as portal_api, which can do only what the portal needs."));
    else results.push(pass("signs in as portal_api"));
  } catch (error) {
    results.push(fail("cannot sign in", connectionHint(error, "portal_api")));
    return results;
  }

  const tables = (await conn.query(
    `select table_name::text as name from information_schema.tables where table_schema = 'portal'`)).map((t) => t.name);
  const missing = TABLES.filter((t) => !tables.includes(t));
  results.push(missing.length
    ? fail(`missing tables: ${missing.join(", ")}`, "Run supabase/migrations/20261013000000_initial_schema.sql in the SQL editor.")
    : pass("all 10 tables"));
  if (missing.length) return results;

  const [claim] = await conn.query(
    `select position('attempts >= 5' in pg_get_functiondef('portal.claim_certificate_jobs(integer, interval)'::regprocedure)) > 0 as capped`);
  results.push(claim.capped ? pass("certificate attempt cap (second migration)")
    : fail("no certificate attempt cap", "Run supabase/migrations/20261014000000_worker_attempt_cap.sql in the SQL editor."));

  const open = (await conn.query(
    `select c.relname::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'portal' and c.relkind = 'r' and not c.relrowsecurity`)).map((t) => t.name);
  results.push(open.length ? fail(`row-level security off: ${open.join(", ")}`, "Run the initial migration again on a fresh project.")
    : pass("row-level security on every table"));

  // The API may add to the audit log, never remove from it. Asked inside a
  // transaction that is always rolled back; `where false` matches no row.
  let canDelete = true;
  try {
    await conn.transaction(async (tx) => {
      await tx.query(`delete from portal.audit_log where false`);
      throw new Error("rollback");
    });
  } catch (error) {
    if (/permission denied/i.test(error.message)) canDelete = false;
  }
  results.push(canDelete ? fail("portal_api can delete audit entries", "Its grants are wrong: run the initial migration on a fresh project.")
    : pass("audit log is append-only for portal_api"));

  const [state] = await conn.query(
    `select (select count(*) from portal.activities)::int as activities, (select count(*) from portal.responses)::int as responses,
            (select value from portal.settings where key = 'imported_at') as imported_at`);
  results.push(info(state.imported_at
    ? `holds an import from ${state.imported_at}: ${state.activities} activities, ${state.responses} responses`
    : state.activities ? `holds ${state.activities} activities but no import` : "empty: ready for the import"));
  return results;
}

/** IMPORT_DB_URL: the owner's connection, which the import uses (--replace needs the owner). */
export async function checkOwnerDatabase(url, db) {
  const results = [];
  const shape = describeDatabaseUrl(url);
  if (!shape) return [fail("IMPORT_DB_URL is not a connection string", "Copy it from Supabase → Connect → Session pooler.")];
  const broken = malformed(shape);
  if (broken) return [broken];
  results.push(shape.user.startsWith("postgres.")
    ? pass(`user postgres, host ${shape.host}`)
    : fail(`user ${shape.user}`, "Use postgres.<project-ref>: the import needs the tables' owner."));
  results.push(shape.port === 5432 ? pass("session pooler (port 5432)")
    : warn(`port ${shape.port}`, "Use the session pooler, port 5432: the import holds one long transaction."));
  try {
    const conn = typeof db === "function" ? await db() : db;
    const [owner] = await conn.query(
      `select current_user::text as name, (select tableowner::text from pg_tables where schemaname = 'portal' and tablename = 'audit_log') as owner`);
    if (!owner.owner) results.push(fail("no portal tables yet", "Run both migrations first."));
    else results.push(owner.owner === owner.name ? pass(`signs in as ${owner.name}, the tables' owner`)
      : fail(`signs in as ${owner.name}, but the tables belong to ${owner.owner}`, "Use the user that ran the migrations."));
  } catch (error) {
    results.push(fail("cannot sign in", connectionHint(error, "postgres")));
  }
  return results;
}

/** A site: its proxy, its backend, Turnstile, and the worker endpoint (fully, given WORKER_TOKEN). */
export async function checkSite(site, { fetch = globalThis.fetch, workerToken = "" } = {}) {
  const results = [];
  let base;
  try {
    base = new URL(String(site || "").trim()).origin; // https://site, whatever page was given
  } catch {}
  if (!base || !/^https?:/.test(base)) return [fail("the site must be an address, like https://example.netlify.app")];
  const post = async (path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8", ...headers },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = JSON.parse(await response.text());
    } catch {}
    return { status: response.status, data };
  };

  // The proxy, and which backend answers. getQuestions tells them apart: the
  // new backend serves sections, Apps Script question1…question15.
  let reply;
  try {
    reply = await post("/.netlify/functions/gas-proxy", { action: "getQuestions" });
  } catch (error) {
    return [fail(`cannot reach ${base}`, String(error?.message || error))];
  }
  if (reply.status === 404 || !reply.data) {
    results.push(fail("no portal proxy at this address", "Is this the portal's site, and has its latest deploy finished?"));
    return results;
  }
  if (reply.data.maintenance) results.push(warn("maintenance mode is on", "Remove MAINTENANCE_MODE and deploy, unless you are mid-cutover."));
  else if (reply.data.ok === false) results.push(fail("the proxy refuses requests", reply.data.error));
  else if (Array.isArray(reply.data.data?.sections)) results.push(pass("answers from the new backend (BACKEND=supabase)"));
  else results.push(info("answers from Apps Script (BACKEND is not set)"));

  if (reply.data.ok !== false || reply.data.maintenance) {
    const timings = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      await post("/.netlify/functions/gas-proxy", { action: "getActivityData" });
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);
    results.push(info(`activity list: ${Math.round(timings[1])} ms (median of 3, from here)`));
  }

  // Turnstile: a submission without a token is refused before anything is
  // written, with a message that says whether the server has its secret.
  const turnstile = await post("/.netlify/functions/gas-proxy", { action: "submitFeedback", payload: {} });
  if (turnstile.data?.maintenance) results.push(info("Turnstile not checked: maintenance mode is on"));
  else if (/security verification/i.test(turnstile.data?.error || ""))
    results.push(pass("Turnstile secret is set (its hostname list is checked only by a real submission: sign in once)"));
  else results.push(fail("Turnstile", turnstile.data?.error || `HTTP ${turnstile.status}`));

  // The worker endpoint: without a token it must refuse.
  const anonymous = await post("/.netlify/functions/worker", { action: "workerPing" });
  if (anonymous.status === 404 || !anonymous.data) {
    results.push(fail("no worker endpoint", "The deploy does not include netlify/functions/worker.mjs: deploy the current code."));
    return results;
  }
  if (anonymous.status !== 401) {
    // Not set up (no token, or no database): nothing more can be learned from inside.
    results.push(fail("worker endpoint", anonymous.data?.error || `HTTP ${anonymous.status}`));
    return results;
  }
  results.push(pass("worker endpoint up, and refuses requests without its token"));
  if (!workerToken) {
    results.push(info("set WORKER_TOKEN to check the site's settings and its database from the inside"));
    return results;
  }

  const ping = await post("/.netlify/functions/worker", { action: "workerPing" }, { authorization: `Bearer ${workerToken}` });
  if (ping.status === 401) {
    results.push(fail("WORKER_TOKEN does not match the site's", "Use the value setupWorkerToken() logged, in both Netlify and your shell."));
    return results;
  }
  if (!ping.data?.ok) {
    results.push(fail("the worker endpoint cannot work", ping.data?.error || `HTTP ${ping.status}`));
    return results;
  }
  const { database = {}, settings, backend } = ping.data.data;
  if (!database.reachable) results.push(fail("the site cannot reach the database", connectionHint(database.error, "portal_api")));
  else if (database.roundTripMs >= 50)
    results.push(warn(`database round trip from the site: ${database.roundTripMs} ms`,
      "The functions and the database are far apart. Set Site configuration → Functions → Region to Singapore (Netlify Pro)."));
  else results.push(pass(`database round trip from the site: ${database.roundTripMs} ms`));
  if (!settings) {
    results.push(warn("the site runs older code", "Deploy the current code to see which settings it has."));
    return results;
  }
  const unset = Object.entries(settings).filter(([, present]) => !present).map(([name]) => name);
  results.push(unset.length ? fail(`not set on the site: ${unset.join(", ")}`, "Add them under Site configuration → Environment variables, then deploy.")
    : pass("every setting is present"));
  if (backend) results.push(info(`BACKEND: ${backend}`));
  return results;
}
