import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { handleAction } from "../../netlify/backend/actions.mjs";
import { auditCanonical } from "../../netlify/backend/audit.mjs";
import { hmacBase64, sha256Base64 } from "../../netlify/backend/crypto.mjs";
import { freshDatabase, nextCode, seedSession } from "./helpers.mjs";

/**
 * Contract tests (migration plan, phase 1): the same data goes into a
 * stand-in Google Sheet for the real Code.gs and into Postgres for the new
 * backend, the same request goes to both, and the answers must match.
 *
 * Each call to appsScript() or newBackend() starts from the same fixture, so
 * a test that changes data gets a fresh pair.
 */

export const TODAY = "2026-08-24";
export const NOW = new Date("2026-08-24T02:00:00Z"); // 10:00 in Manila
const manilaUtc = (day, time = "00:00") => new Date(`${day}T${time}:00+08:00`);

export const ACTIVITIES = [
  { code: "A-FORUM", title: "Leadership Forum", venue: "CHED Auditorium", from: "2026-08-24", to: "2026-08-24", owner: "helper@example.com", active: true },
  { code: "A-WORK", title: "Data Workshop", venue: "Room 2", from: "2026-08-20", to: "2026-08-26", owner: "boss@example.com", active: false },
  { code: "A-NEXT", title: "Planning Summit", venue: "Hall B", from: "2026-09-01", to: "2026-09-02", owner: "", active: true },
];
export const TYPES = [...Array(13).fill("rating"), "yesno", "text"];
export const QUESTIONS = TYPES.map((_, i) => `Question ${i + 1}`);
export const RESPONSES = [
  { activity: 0, name: "Ana", email: "ana@example.com", at: "09:05", answers: [5, 5, 4, 5, 5, 5, 4, 5, 5, 5, 4, 5, 5, "Yes", "Great sessions"], status: "issued", sent: "2026-08-24 10:30" },
  { activity: 0, name: "Bo", email: "Bo@Example.com", at: "09:20", answers: [4, 4, 3, 4, 2, 4, 4, 4, 3, 4, 4, 4, 4, "No", ""], status: "failed", error: "No certificate template" },
  { activity: 1, name: "Cy", email: "cy@example.com", at: "09:40", answers: [1, 2, 1, 1, 3, 1, 2, 1, 1, 1, 2, 1, 1, "yes", "Too long"], status: "pending" },
  { activity: 1, name: "Di", email: "di@example.com", at: "09:55", answers: [3, 3, 3, "", 3, 3, 3, 3, 3, 3, 3, 3, 3, "", ""], status: "processing" },
];
for (const r of RESPONSES) r.code = nextCode();
const SHEET_STATUS = { issued: "OK", failed: "ERROR: No certificate template", pending: "PENDING", processing: "PROCESSING" };
const ADMINS = {
  boss: { email: "boss@example.com", name: "Boss", role: "superadmin", token: "tok-boss", userId: "U-BOSS0001", created: "2026-07-29", updated: "2026-08-01" },
  helper: { email: "helper@example.com", name: "Helper", role: "admin", token: "tok", userId: "U-HELP0001", created: "2026-07-30", updated: "2026-08-02" },
};
export const PROXY_TOKEN = "p".repeat(64);
export const WORKER_TOKEN = "w".repeat(96);
export const AUDIT_SECRET = "audit-secret";

/** A short, valid audit chain, hashed as both backends hash it (gas-compat.test.mjs proves they agree). */
export const AUDIT = (() => {
  const rows = [
    ["2026-08-23 09:00:00", "boss@example.com", "superadmin", "LOGIN", "session", "boss@example.com", "SUCCESS", "{}"],
    ["2026-08-23 09:05:00", "boss@example.com", "superadmin", "ACTIVITY_SAVE", "activity", "A-FORUM", "SUCCESS", '{"operation":"create","title":"Leadership Forum"}'],
    ["2026-08-23 10:00:00", "helper@example.com", "", "LOGIN", "session", "helper@example.com", "FAILURE", '{"error":"Invalid email or password."}'],
    ["2026-08-24 08:30:00", "boss@example.com", "superadmin", "USER_SAVE", "user", "helper@example.com", "SUCCESS", '{"role":"admin","active":true}'],
  ];
  let previous = "";
  return rows.map(([logged_at, actor_email, actor_role, action, target_type, target_id, outcome, details], i) => {
    const entry = { logged_at, audit_id: `AUD-000000000000000${i + 1}`, actor_email, actor_role, action, target_type,
      target_id, outcome, details, request_id: `req-${i + 1}`, previous_hash: previous };
    entry.entry_hash = hmacBase64(auditCanonical(entry), AUDIT_SECRET);
    previous = entry.entry_hash;
    return entry;
  });
})();

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

// --- Apps Script side: Code.gs over a stand-in spreadsheet --------------------

function sheet(rows) {
  const width = () => Math.max(...rows.map((r) => r.length));
  return {
    rows,
    getLastRow: () => rows.length,
    getLastColumn: width,
    getMaxColumns: () => Math.max(26, width()),
    getMaxRows: () => 1000,
    appendRow: (values) => rows.push([...values]),
    deleteRow: (index) => rows.splice(index - 1, 1),
    insertColumnsAfter: () => {},
    setFrozenRows: () => {},
    autoResizeColumns: () => {},
    getRange: (r, c, nr = 1, nc = 1) => ({
      getValues: () => rows.slice(r - 1, r - 1 + nr).map((row) => Array.from({ length: nc }, (_, j) => row[c - 1 + j] ?? "")),
      // The audit sheet holds only text, so what it displays is what it holds.
      getDisplayValues() { return this.getValues().map((row) => row.map(String)); },
      getValue: () => rows[r - 1]?.[c - 1] ?? "",
      setValue(value) { while (rows.length < r) rows.push([]); rows[r - 1][c - 1] = value; return this; },
      setValues(values) {
        values.forEach((line, i) => line.forEach((value, j) => {
          while (rows.length < r + i) rows.push([]);
          rows[r - 1 + i][c - 1 + j] = value;
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

export function appsScript() {
  const context = {};
  vm.createContext(context);
  // Dates must come from the sandbox's own Date: Code.gs checks
  // `value instanceof Date`, which fails for a Date made in another realm.
  const SandboxDate = vm.runInContext("Date", context);
  const manila = (day, time = "00:00") => new SandboxDate(`${day}T${time}:00+08:00`);
  const activityHeader = ["Title", "Venue", "FromDate", "ToDate", "Certificate Template", "Focal-in-Charge", "Timestamp",
    "Given Date", "ActivityID", "Region", "Signatory Designation", "E-Signature", "Created By", "Active"];
  const activity = sheet([activityHeader, ...ACTIVITIES.map((a) =>
    [a.title, a.venue, manila(a.from), manila(a.to), "", "", manila(TODAY, "08:00"), "", a.code, "", "", "", a.owner, a.active ? "TRUE" : "FALSE"])]);
  const answerColumns = QUESTIONS.map((_, i) => `Answer${i + 1}`);
  const responsesHeader = ["Timestamp", "Name", "Responder Email", "Sex", "Age", "ActivityID", "Title of Activity", "Venue",
    "Activity_Date", ...answerColumns, "Takeaways", "Suggestions", "Email Sent", "Certificate Link", "Verification Code",
    "Verification URL", "cStatus"];
  const responses = sheet([responsesHeader, ...RESPONSES.map((r) => {
    const a = ACTIVITIES[r.activity];
    // Sheets turns a lone date into a date value; a range stays text.
    const date = a.from === a.to ? manila(a.from) : `${a.from} – ${a.to}`;
    return [manila(TODAY, r.at), r.name, r.email, "Female", 30, a.code, a.title, a.venue, date, ...r.answers,
      "", "", r.sent || "", r.status === "issued" ? "https://drive/cert" : "", r.code, "", SHEET_STATUS[r.status]];
  })]);
  const questions = sheet([[...QUESTIONS.map((_, i) => `question${i + 1}`), ...TYPES.map((_, i) => `type${i + 1}`)], [...QUESTIONS, ...TYPES]]);
  const admins = Object.values(ADMINS);
  const users = sheet([["Email", "PasswordHash", "Salt", "Name", "Role", "Active", "CreatedAt"],
    ...admins.map((a) => [a.email, "v2:x", "salt", a.name, a.role, "TRUE", manila(a.created)])]);
  const whitelist = sheet([["user_id", "name", "role", "email", "active", "created_at", "updated_at"],
    ...admins.map((a) => [a.userId, a.name, a.role, a.email, "TRUE", manila(a.created), manila(a.updated)])]);
  const auditColumns = ["timestamp", "audit_id", "actor_email", "actor_role", "action", "target_type", "target_id", "outcome",
    "details", "request_id", "previous_hash", "entry_hash"];
  const audit = sheet([auditColumns, ...AUDIT.map((e) => auditColumns.map((k) => (k === "timestamp" ? e.logged_at : e[k])))]);
  const sheets = { Activity: activity, Responses: responses, Questions: questions, Users: users, Whitelist: whitelist, Audit: audit };

  const format = (date, _tz, pattern) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date).map((x) => [x.type, x.value]));
    return pattern.replace("yyyy", p.year).replace("MM", p.month).replace("dd", p.day).replace("HH", p.hour).replace("mm", p.minute).replace("ss", p.second);
  };
  // Utilities as Google documents it: UTF-8 input, signed bytes out, and
  // web-safe base64 that keeps its '=' padding.
  const signed = (buffer) => [...buffer].map((b) => (b > 127 ? b - 256 : b));
  const cache = new Map();
  const drive = [];
  const properties = new Map([
    ["CERTIFICATE_QUEUE_TRIGGER_READY", "1"],
    ["AUDIT_HASH_SECRET", AUDIT_SECRET],
    ["AUDIT_HEAD_HASH", AUDIT.at(-1).entry_hash],
    ["PASSWORD_PEPPER", "pepper"],
    ["SUBMIT_SHARED_TOKEN_HASH", sha256Base64(PROXY_TOKEN)],
    ["WORKER_TOKEN", WORKER_TOKEN],
  ]);
  const lock = () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} });
  Object.assign(context, {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null }), flush: () => {} },
    Session: { getScriptTimeZone: () => "Asia/Manila", getActiveUser: () => ({ getEmail: () => "" }) },
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
    // Drive: a folder that records what it is given.
    DriveApp: { getFolderById: () => ({
      getName: () => "Certificate templates",
      createFile: (blob) => {
        drive.push(blob);
        const id = `drive-${drive.length}`;
        return { getId: () => id, getName: () => blob.name, getUrl: () => `https://drive.google.com/file/d/${id}/view` };
      },
    }) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (text) => ({ setMimeType() { return this; }, getContent: () => text }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k),
      removeAll: (keys) => keys.forEach((k) => cache.delete(k)),
    }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => properties.get(k) ?? null, setProperty: (k, v) => properties.set(k, String(v)) }) },
    LockService: { getScriptLock: lock, getDocumentLock: lock },
  });
  vm.runInContext(readFileSync(new URL("../../google-apps-script/Code.gs", import.meta.url), "utf8"), context);
  // A fixed "today" and a chosen signed-in admin: these tests compare what the
  // actions do, not the clock or sign-in, which have their own tests.
  let actor = ADMINS.helper;
  context.todayKey_ = () => TODAY;
  context.getAdminSession_ = () => ({ email: actor.email, name: actor.name, role: actor.role });
  return {
    gas: context,
    sheets,
    drive,
    properties,
    as(who) { actor = ADMINS[who]; return this; },
    /** Run a Code.gs function; a thrown error becomes {ok:false}, as doPost reports it. */
    run(fn, ...args) {
      try {
        return { ok: true, data: json(context[fn](...args)) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
    /** What a POST to the deployed web app does: doPost, then its JSON body. */
    post: (body) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }).getContent()),
  };
}

// --- New backend side: the same data in Postgres ------------------------------

/**
 * `appsScript`, when given, is the paired Code.gs sandbox: requests the new
 * backend makes to Apps Script (the signature upload) go into its doPost.
 */
export async function newBackend({ appsScript: apps } = {}) {
  const { db } = await freshDatabase();
  for (const admin of Object.values(ADMINS)) {
    await db.query(
      `insert into portal.admin_users (email, legacy_user_id, name, role, active, password_hash, password_salt, created_at, updated_at)
       values ($1, $2, $3, $4, true, 'v2:x', 'salt', $5, $6)`,
      [admin.email, admin.userId, admin.name, admin.role, manilaUtc(admin.created).toISOString(), manilaUtc(admin.updated).toISOString()]);
    await seedSession(db, admin.email, admin.token);
  }
  for (const e of AUDIT)
    await db.query(
      `insert into portal.audit_log (logged_at, audit_id, actor_email, actor_role, action, target_type, target_id, outcome,
         details, request_id, previous_hash, entry_hash) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [e.logged_at, e.audit_id, e.actor_email, e.actor_role, e.action, e.target_type, e.target_id, e.outcome, e.details,
       e.request_id, e.previous_hash, e.entry_hash]);
  await db.query(`insert into portal.settings (key, value) values ('audit_head_hash', $1)`, [AUDIT.at(-1).entry_hash]);
  const activityIds = [];
  for (const [i, a] of ACTIVITIES.entries()) {
    const [row] = await db.query(
      `insert into portal.activities (code, title, venue, from_date, to_date, created_by, active, created_at)
       values ($1, $2, $3, $4, $5, nullif($6, ''), $7, '2026-08-01T00:00:00Z'::timestamptz + $8 * interval '1 second') returning id::text as id`,
      [a.code, a.title, a.venue, a.from, a.to, a.owner, a.active, i]);
    activityIds.push(row.id);
  }
  const [section] = await db.query(`insert into portal.survey_sections (name, position, created_at) values ('All', 1, '2026-08-01') returning id`);
  const questionIds = [];
  for (const [i, text] of QUESTIONS.entries())
    questionIds.push((await db.query(
      `insert into portal.questions (section_id, position, text, type, created_at) values ($1, $2, $3, $4, '2026-08-01') returning id`,
      [section.id, i, text, TYPES[i]]))[0].id);
  const responseIds = [];
  for (const r of RESPONSES) {
    const a = ACTIVITIES[r.activity];
    const [row] = await db.query(
      `insert into portal.responses (submitted_at, activity_id, activity_code, activity_title, venue, activity_date, name, email,
         sex, age, certificate_status, certificate_error, certificate_url, emailed_at, verification_code)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'Female', 30, $9, $10, $11, $12, $13) returning id::int as id`,
      [manilaUtc(TODAY, r.at).toISOString(), activityIds[r.activity], a.code, a.title, a.venue, a.from === a.to ? a.from : `${a.from} – ${a.to}`,
       r.name, r.email, r.status, r.error ?? null, r.status === "issued" ? "https://drive/cert" : null,
       r.sent ? manilaUtc(...r.sent.split(" ")).toISOString() : null, r.code]);
    responseIds.push(row.id);
    for (const [i, value] of r.answers.entries())
      if (String(value).trim())
        await db.query(`insert into portal.answers (response_id, question_id, value) values ($1, $2, $3)`, [row.id, questionIds[i], String(value)]);
  }
  let actor = ADMINS.helper;
  let workerToken = WORKER_TOKEN;
  const context = () => ({
    db,
    now: NOW,
    secrets: { auditSecret: AUDIT_SECRET },
    appsScript: { gasUrl: "https://script.google.com/macros/s/TEST/exec", proxyToken: PROXY_TOKEN, workerToken },
    fetch: async (_url, init) => new Response(JSON.stringify(apps.post(JSON.parse(init.body)))),
  });
  return {
    db,
    activityIds,
    responseIds,
    as(who) { actor = ADMINS[who]; return this; },
    /** For testing a misconfigured deployment. */
    useWorkerToken(token) { workerToken = token; return this; },
    /** The full {ok, data|error} reply, as the browser receives it. */
    reply: (action, extra = {}) => handleAction({ action, adminToken: actor.token, ...extra }, context()),
    /** Just the data, for reads that must succeed. */
    async call(action, extra = {}) {
      const result = await handleAction({ action, adminToken: actor.token, ...extra }, context());
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
  };
}
