import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * The real google-apps-script/Code.gs, run in Node over a stand-in
 * spreadsheet. The contract tests use it to compare the two backends, and the
 * import (scripts/import-sheets.mjs) uses it to check that the new database
 * shows exactly what Apps Script shows for the same sheets.
 *
 * Google's services are replaced by the few behaviours Code.gs relies on.
 */

const CODE_GS = new URL("../../google-apps-script/Code.gs", import.meta.url);

/**
 * What a written value becomes in the cell. A leading apostrophe tells Sheets
 * "this is text"; it is not part of the value (Code.gs's safeSheetValue_
 * adds one before =, +, - and @).
 */
const stored = (value) => (typeof value === "string" && value.startsWith("'") ? value.slice(1) : value);

/** One sheet: rows of cell values, header first, as getValues() returns them. */
export function standInSheet(rows) {
  const width = () => Math.max(0, ...rows.map((r) => r.length));
  return {
    rows,
    getLastRow: () => rows.length,
    getLastColumn: width,
    getMaxColumns: () => Math.max(26, width()),
    getMaxRows: () => 1000,
    appendRow: (values) => rows.push(values.map(stored)),
    deleteRow: (index) => rows.splice(index - 1, 1),
    insertColumnsAfter: () => {},
    setFrozenRows: () => {},
    autoResizeColumns: () => {},
    getRange: (r, c, nr = 1, nc = 1) => ({
      getValues: () => rows.slice(r - 1, r - 1 + nr).map((row) => Array.from({ length: nc }, (_, j) => row[c - 1 + j] ?? "")),
      // The audit sheet holds only text, so what it displays is what it holds.
      getDisplayValues() { return this.getValues().map((row) => row.map(String)); },
      getValue: () => rows[r - 1]?.[c - 1] ?? "",
      setValue(value) { while (rows.length < r) rows.push([]); rows[r - 1][c - 1] = stored(value); return this; },
      setValues(values) {
        values.forEach((line, i) => line.forEach((value, j) => {
          while (rows.length < r + i) rows.push([]);
          rows[r - 1 + i][c - 1 + j] = stored(value);
        }));
        return this;
      },
      getNumberFormat: () => "@",
      setNumberFormat() { return this; },
      setFontWeight() { return this; },
      setBackground() { return this; },
      setFontColor() { return this; },
      createTextFinder: (text) => ({
        matchEntireCell() { return this; },
        matchCase() { return this; },
        findNext: () => {
          for (let i = r - 1; i < r - 1 + nr; i++)
            if (String(rows[i]?.[c - 1] ?? "").toUpperCase() === String(text).toUpperCase()) return { getRow: () => i + 1 };
          return null;
        },
      }),
    }),
  };
}

/**
 * A fresh Code.gs. Fill `sheets` (name → standInSheet) before calling it.
 * Dates put in a sheet must be made with the returned `SandboxDate`: Code.gs
 * checks `value instanceof Date`, which fails for a Date from another realm.
 *
 * `services` replaces or adds Google services (DriveApp, MailApp, …).
 */
export function codeGs({ properties = new Map(), timeZone = "Asia/Manila", services = {} } = {}) {
  const context = {};
  vm.createContext(context);
  const SandboxDate = vm.runInContext("Date", context);
  const sheets = {};
  const format = (date, zone, pattern) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone || timeZone, year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date).map((x) => [x.type, x.value]));
    return pattern.replace("yyyy", p.year).replace("MM", p.month).replace("dd", p.day).replace("HH", p.hour).replace("mm", p.minute).replace("ss", p.second);
  };
  // Utilities as Google documents it: UTF-8 input, signed bytes out, and
  // web-safe base64 that keeps its '=' padding.
  const signed = (buffer) => [...buffer].map((b) => (b > 127 ? b - 256 : b));
  const cache = new Map();
  const lock = () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} });
  Object.assign(context, {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null }), flush: () => {} },
    Session: { getScriptTimeZone: () => timeZone, getActiveUser: () => ({ getEmail: () => "" }) },
    Utilities: {
      formatDate: format,
      getUuid: () => randomUUID(),
      DigestAlgorithm: { SHA_256: "sha256" },
      Charset: { UTF_8: "utf8" },
      computeDigest: (_alg, value) => signed(createHash("sha256").update(String(value), "utf8").digest()),
      computeHmacSha256Signature: (value, key) => signed(createHmac("sha256", String(key)).update(String(value), "utf8").digest()),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => b & 255)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_"),
      base64Decode: (text) => signed(Buffer.from(text, "base64")),
      newBlob: (bytes, mimeType, name) => ({ bytes, mimeType, name }),
    },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (text) => ({ setMimeType() { return this; }, getContent: () => text }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k),
      removeAll: (keys) => keys.forEach((k) => cache.delete(k)),
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => properties.get(k) ?? null,
      setProperty: (k, v) => properties.set(k, String(v)),
      deleteProperty: (k) => properties.delete(k),
      getProperties: () => Object.fromEntries(properties),
    }) },
    LockService: { getScriptLock: lock, getDocumentLock: lock },
    Logger: { log: () => {} },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    ...services,
  });
  vm.runInContext(readFileSync(CODE_GS, "utf8"), context);
  return { gas: context, sheets, properties, SandboxDate };
}

// --- Comparing the two backends' replies ------------------------------------

/** Both sides as the browser receives them: JSON. (Sandbox objects also carry the sandbox's own prototypes.) */
export const json = (value) => JSON.parse(JSON.stringify(value));
export const withoutKeys = (rows, ...keys) =>
  rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k))));

/**
 * A certificate-queue reply, ready to compare. Row IDs differ by design. And
 * for a waiting certificate that is not held, Code.gs computes `held` as
 * undefined (an `&&` over two missing lookups), so the key vanishes from its
 * JSON; the new backend sends false. The screen reads both as "not held".
 */
export const comparableQueue = (queue) => ({
  ...queue,
  entries: withoutKeys(queue.entries, "row").map((entry) => ({ ...entry, held: Boolean(entry.held) })),
});

/**
 * Phase 1b serves the survey as sections; Code.gs serves question1…15 (to
 * participants) or a list of 15 (to the editor). Both flattened to the same
 * list of {text, type}, so the questions themselves can still be compared.
 */
export const flatQuestions = (reply) => {
  if (Array.isArray(reply)) return reply.map(({ text, type }) => ({ text, type }));
  if (reply?.sections) return reply.sections.flatMap((s) => s.questions.map(({ text, type }) => ({ text, type })));
  return Array.from({ length: 15 }, (_, i) => ({ text: reply[`question${i + 1}`], type: reply[`type${i + 1}`] }));
};

/** Phase 1b adds which question an answer or a score belongs to; Code.gs has positions only. */
const NEW_QUESTION_KEYS = ["questionId", "question", "text", "section", "retired"];
export const withoutQuestionDetail = (rows) => withoutKeys(rows, ...NEW_QUESTION_KEYS);
export const comparableResponses = (entries) =>
  withoutKeys(entries, "row").map((entry) => ({ ...entry, answers: withoutQuestionDetail(entry.answers) }));
export const comparableAnalytics = (analytics) =>
  analytics.questions ? { ...analytics, questions: withoutQuestionDetail(analytics.questions) } : analytics;
