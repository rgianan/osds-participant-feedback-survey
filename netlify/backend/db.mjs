import postgres from "postgres";

/**
 * The database the new backend talks to, behind a two-method interface:
 *
 *   query(text, params)  → array of row objects
 *   transaction(fn)      → runs fn({ query }) inside BEGIN … COMMIT
 *
 * Production wraps the `postgres` client; the tests wrap PGlite (Postgres
 * compiled to WebAssembly) with the same two methods, so every action runs
 * the same SQL in both. Queries cast dates and big integers to text or int
 * in SQL, so the two drivers' different type parsing never shows.
 */
export function adaptPostgres(sql) {
  const wrap = (runner) => ({
    query: (text, params = []) => runner.unsafe(text, params),
  });
  return {
    ...wrap(sql),
    transaction: (fn) => sql.begin((tx) => fn(wrap(tx))),
  };
}

let shared = null;

/**
 * One connection per function instance, reused while the instance stays warm.
 *
 * SUPABASE_DB_URL must be the transaction pooler's address (port 6543) with
 * the portal_api role, e.g.
 *   postgresql://portal_api.<project-ref>:<password>@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
 * That pooler hands the connection to another client after every
 * transaction, so prepared statements must stay off.
 */
export function database() {
  if (shared) return shared;
  const url = String(process.env.SUPABASE_DB_URL || "").trim();
  if (!url)
    throw new Error(
      "The database is not configured. Set SUPABASE_DB_URL in Netlify.",
    );
  shared = adaptPostgres(
    postgres(url, {
      prepare: false,
      // One connection. A function instance serves one request at a time, so
      // more only help queries a request runs side by side, and each extra one
      // costs a full connection setup: TLS and sign-in, about five round trips.
      // With the functions in the US and the database in Singapore that was
      // 2 to 3 seconds each, enough to push a cold dashboard past Netlify's
      // 10-second limit. (postgres.js cannot pipeline parameterized queries
      // without prepared statements, so side-by-side queries queue here.)
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: "require",
    }),
  );
  return shared;
}
