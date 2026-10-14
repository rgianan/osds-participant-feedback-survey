import { readFileSync, readdirSync } from "node:fs";
import { workerData } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";
import { handleAction } from "../../netlify/backend/actions.mjs";
import { handleWorkerRequest } from "../../netlify/backend/worker.mjs";
import { compareWithAppsScript, importSheets } from "../../scripts/lib/import.mjs";

/**
 * The new backend and its database, in a thread of their own, so that
 * Apps Script code (whose UrlFetchApp.fetch is synchronous) can call them and
 * wait for the answer. See backend-thread.mjs.
 *
 * Messages:
 *   { type: "sql", text, params }               → { ok, rows }
 *   { type: "worker", body }                    → the worker endpoint's reply
 *   { type: "action", body, now, secrets }      → handleAction's reply (the browser's requests)
 *   { type: "import", exported, options }       → importSheets' result
 *   { type: "compare", exported, options }      → compareWithAppsScript's result
 * `now` and `options.now` are ISO strings.
 */
const { port, signal, portalBaseUrl } = workerData;
const pg = new PGlite();
const migrations = new URL("../../supabase/migrations/", import.meta.url);
for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort())
  await pg.exec(readFileSync(new URL(file, migrations), "utf8"));
const wrap = (runner) => ({ query: async (text, params = []) => (await runner.query(text, params)).rows });
const db = { ...wrap(pg), transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))) };
const withNow = (options = {}) => ({ ...options, now: options.now ? new Date(options.now) : new Date() });

port.on("message", async (message) => {
  let reply;
  try {
    if (message.type === "sql") reply = { ok: true, rows: await db.query(message.text, message.params) };
    else if (message.type === "worker") reply = await handleWorkerRequest(message.body, { db, now: new Date(), portalBaseUrl });
    else if (message.type === "action")
      reply = await handleAction(message.body, { db, now: new Date(message.now), secrets: message.secrets || {}, portalBaseUrl });
    else if (message.type === "import") reply = await importSheets(db, message.exported, withNow(message.options));
    else if (message.type === "compare") reply = await compareWithAppsScript(db, message.exported, withNow(message.options));
    else reply = { ok: false, error: `Unknown message ${message.type}` };
  } catch (error) {
    reply = { ok: false, error: error.message, thrown: true };
  }
  port.postMessage(reply);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
port.postMessage({ ready: true });
Atomics.store(signal, 0, 1);
Atomics.notify(signal, 0);
