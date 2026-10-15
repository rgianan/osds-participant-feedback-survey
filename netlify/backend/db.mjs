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
 *
 * With `limitMs`, a query or transaction that has not answered by then is
 * abandoned with DATABASE_TIMEOUT, and `onTimeout` is told, so the caller can
 * drop a connection that may be dead.
 */
export const DATABASE_TIMEOUT = "The database did not answer in time (timeout). Please try again.";

export function adaptPostgres(sql, { limitMs = 0, onTimeout = () => {} } = {}) {
  const limited = (promise) => {
    if (!limitMs) return promise;
    promise.catch(() => {}); // if abandoned, its own failure later is expected and ignored
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new Error(DATABASE_TIMEOUT));
      }, limitMs);
    });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
  };
  const wrap = (runner) => ({
    query: (text, params = []) => limited(runner.unsafe(text, params)),
  });
  return {
    ...wrap(sql),
    transaction: (fn) => limited(sql.begin((tx) => fn(wrap(tx)))),
  };
}

/**
 * One connection per function instance, reused while the instance stays warm,
 * but never trusted after a quiet spell.
 *
 * Netlify freezes an instance between requests. A connection can be dropped
 * by the network while it sleeps, and nothing tells the frozen code: the next
 * query then waits for an answer that never comes, until Netlify stops the
 * function at 30 seconds. So a connection unused for STALE_AFTER_MS of wall
 * time (which keeps counting while the instance sleeps, unlike its timers) is
 * replaced before use, and any query unanswered after LIMIT_MS ends in an
 * error the browser retries, on a fresh connection.
 */
export const STALE_AFTER_MS = 30_000;
export const LIMIT_MS = 20_000;

export function connectionKeeper({ connect, now = () => Date.now(), staleAfterMs = STALE_AFTER_MS, limitMs = LIMIT_MS }) {
  let sql = null;
  let db = null;
  let lastUsed = 0;
  const retire = () => {
    const old = sql;
    sql = null;
    db = null;
    old?.end({ timeout: 0 }).catch(() => {});
  };
  return () => {
    if (db && now() - lastUsed > staleAfterMs) retire();
    if (!db) {
      sql = connect();
      const adapted = adaptPostgres(sql, { limitMs, onTimeout: retire });
      // Every use counts as activity, so a busy instance keeps its connection.
      const touch = (fn) => (...args) => {
        lastUsed = now();
        return fn(...args).finally(() => { lastUsed = now(); });
      };
      db = { query: touch(adapted.query), transaction: touch(adapted.transaction) };
    }
    lastUsed = now();
    return db;
  };
}

/**
 * SUPABASE_DB_URL must be the transaction pooler's address (port 6543) with
 * the portal_api role, e.g.
 *   postgresql://portal_api.<project-ref>:<password>@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
 * That pooler hands the connection to another client after every
 * transaction, so prepared statements must stay off.
 */
const keeper = connectionKeeper({
  connect: () =>
    postgres(String(process.env.SUPABASE_DB_URL || "").trim(), {
      prepare: false,
      // One connection. A function instance serves one request at a time, so
      // more only help queries a request runs side by side, and each extra one
      // costs a full connection setup: TLS and sign-in, about five round trips.
      // With the functions in the US and the database in Singapore that was
      // 2 to 3 seconds each, so a cold dashboard spent most of its time
      // connecting. (postgres.js cannot pipeline parameterized queries
      // without prepared statements, so side-by-side queries queue here.)
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: "require",
    }),
});

export function database() {
  if (!String(process.env.SUPABASE_DB_URL || "").trim())
    throw new Error("The database is not configured. Set SUPABASE_DB_URL in Netlify.");
  return keeper();
}
