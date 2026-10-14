import { readFileSync, readdirSync } from "node:fs";
import { workerData } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";
import { handleWorkerRequest } from "../../netlify/backend/worker.mjs";

/**
 * The new backend and its database, in a thread of their own, so that
 * Apps Script code (whose UrlFetchApp.fetch is synchronous) can call them and
 * wait for the answer. See worker-e2e.test.mjs.
 *
 * Messages: { type: "sql", text, params } or { type: "worker", body }.
 */
const { port, signal, portalBaseUrl } = workerData;
const pg = new PGlite();
const migrations = new URL("../../supabase/migrations/", import.meta.url);
for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort())
  await pg.exec(readFileSync(new URL(file, migrations), "utf8"));
const wrap = (runner) => ({ query: async (text, params = []) => (await runner.query(text, params)).rows });
const db = { ...wrap(pg), transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))) };

port.on("message", async (message) => {
  let reply;
  try {
    reply = message.type === "sql"
      ? { ok: true, rows: await db.query(message.text, message.params) }
      : await handleWorkerRequest(message.body, { db, now: new Date(), portalBaseUrl });
  } catch (error) {
    reply = { ok: false, error: error.message };
  }
  port.postMessage(reply);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
port.postMessage({ ready: true });
Atomics.store(signal, 0, 1);
Atomics.notify(signal, 0);
