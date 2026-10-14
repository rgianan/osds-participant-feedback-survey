import { randomUUID } from "node:crypto";
import { HANDLERS } from "../../netlify/backend/actions.mjs";
import { checkAuditChain, normalizeAuditTimestamp, readAuditChain } from "../../netlify/backend/audit.mjs";
import { newVerificationCode } from "../../netlify/backend/crypto.mjs";
import { normalizeQuestionType } from "../../netlify/backend/questions.mjs";
import { DEFAULT_SECTIONS } from "../../netlify/backend/survey.mjs";
import { PORTAL_TIME_ZONE, dateKey } from "../../netlify/backend/time.mjs";
import {
  codeGs, comparableAnalytics, comparableQueue, comparableResponses, flatQuestions, json, standInSheet, withoutKeys,
} from "./code-gs.mjs";

/**
 * Phase 3 of the migration: the sheets, as exportForMigration() in Code.gs
 * writes them, into the new database.
 *
 *   convertExport()  every row converted, or a list of the rows the database
 *                    would refuse (sheet and row number, never their contents)
 *   importSheets()   loads the converted rows in one transaction, then checks
 *                    them before committing:
 *                      1. every table holds exactly the rows converted, field by field
 *                      2. the audit chain verifies, ending at the recorded head
 *                      3. every screen shows what Apps Script shows for the same
 *                         sheets: this repository's Code.gs is run on the export
 *                    Any failure rolls the whole import back.
 *
 * The rules follow how Code.gs reads each sheet: the same header aliases, the
 * same idea of a blank or switched-off cell.
 */

export const EXPORT_FORMAT = "participant-feedback-export";
const SHEETS = ["Activity", "Responses", "Questions", "Users", "Whitelist", "Audit"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE = /^CHED-[A-F0-9]{20}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const MANILA = "+08:00"; // Asia/Manila keeps one offset all year

const trim = (value) => String(value ?? "").trim();
const isDate = (value) => value !== null && typeof value === "object" && "$date" in value;
const isBlank = (value) => (isDate(value) ? !value.$date : trim(value) === "");
const realDay = (key) => DAY.test(key) && new Date(`${key}T00:00:00Z`).toISOString().slice(0, 10) === key;

const minuteFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: PORTAL_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
/** 'yyyy-MM-dd HH:mm' in Manila, as the admin screens print a time. */
export function minuteStamp(date) {
  const p = Object.fromEntries(minuteFormat.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** A cell as text, as safeTrim_ reads it. A date cell reads as its day, or its minute if it has a time. */
function textOf(value) {
  if (!isDate(value)) return trim(value);
  if (!value.$date) return "";
  const date = new Date(value.$date);
  const stamp = minuteStamp(date);
  return stamp.endsWith(" 00:00") ? dateKey(date) : stamp;
}

/** A cell as a calendar day in Manila: 'yyyy-MM-dd', '' when blank, null when it is not a date. */
function dayOf(value) {
  if (isDate(value)) return value.$date ? dateKey(new Date(value.$date)) : null;
  const text = trim(value);
  if (!text) return "";
  return realDay(text) ? text : null;
}

/** A cell as an instant (ISO): '' when blank, null when it is not a time. Text reads as Manila wall time. */
function instantOf(value) {
  if (isDate(value)) return value.$date ? new Date(value.$date).toISOString() : null;
  const text = trim(value);
  if (!text) return "";
  if (realDay(text)) return new Date(`${text}T00:00:00${MANILA}`).toISOString();
  const m = text.match(MINUTE);
  if (!m || !realDay(m[1]) || Number(m[2]) > 23) return null;
  return new Date(`${m[1]}T${m[2].padStart(2, "0")}:${m[3]}:${m[4] || "00"}${MANILA}`).toISOString();
}

/** isActiveCellEnabled_: on unless the cell plainly says off. */
const isSwitchedOn = (value) => !["false", "no", "off", "0", "disabled", "inactive", "closed"].includes(trim(value).toLowerCase());

/** A sheet's rows with getHeaderMap_ / idxOf_ column lookup. */
function sheetTable(rows) {
  const [header = [], ...data] = rows || [];
  const map = {};
  header.forEach((h, i) => {
    const key = trim(h).toLowerCase();
    if (key) map[key] = i;
  });
  const col = (...names) => {
    for (const name of names) if (name.toLowerCase() in map) return map[name.toLowerCase()];
    return -1;
  };
  return { data, col };
}
const cell = (row, index) => (index >= 0 && index < row.length ? row[index] : "");
const isBlankRow = (row) => row.every(isBlank);

/**
 * Every sheet converted into rows for the new tables.
 *
 * Returns { tables, problems, notes, fills, inSheets }. `problems` lists each
 * row the database would refuse, as "<Sheet> row <n>: <what is wrong>"; the
 * import writes nothing until it is empty. `fills` are the values the import
 * supplies where the sheet had none (verification codes), so the comparison
 * with Apps Script can apply them too. `inSheets` holds every verification code
 * and audit ID in the export, skipped responses included.
 */
export function convertExport(exported, { skipResponses = false } = {}) {
  if (exported?.format !== EXPORT_FORMAT || exported.version !== 1 || typeof exported.sheets !== "object")
    throw new Error("This is not a file made by exportForMigration() in Code.gs.");
  const exportedAt = new Date(exported.exportedAt);
  if (Number.isNaN(exportedAt.getTime())) throw new Error("The export has no valid exportedAt time.");
  const sheets = exported.sheets;
  const problems = [];
  const notes = [];
  const fills = [];
  const problem = (sheet, row, message) => problems.push(row ? `${sheet} row ${row}: ${message}` : `${sheet}: ${message}`);
  if (exported.timeZone !== PORTAL_TIME_ZONE)
    problem("Export", 0, `the Apps Script project's time zone is ${exported.timeZone}, but the new backend counts days in ${PORTAL_TIME_ZONE}. Set the project's time zone to ${PORTAL_TIME_ZONE} and export again.`);
  for (const name of SHEETS)
    if (sheets[name] != null && !(Array.isArray(sheets[name]) && sheets[name].every(Array.isArray)))
      throw new Error(`The ${name} sheet in the export is not a list of rows.`);
  const blankRows = {};
  const rowsOf = (name) => {
    const table = sheetTable(sheets[name]);
    const rows = [];
    table.data.forEach((row, i) => {
      if (isBlankRow(row)) blankRows[name] = (blankRows[name] || 0) + 1;
      else rows.push({ row, sheetRow: i + 2 });
    });
    return { ...table, rows };
  };

  // --- Administrators: Users holds the password and decides sign-in; Whitelist
  // holds the account's ID and dates and is what the Users screen lists.
  if (!sheets.Users) problem("Users", 0, "the sheet is missing, so no administrator could sign in.");
  const users = new Map();
  const usersSheet = rowsOf("Users");
  const uc = {
    email: usersSheet.col("email", "e-mail"), hash: usersSheet.col("passwordhash", "password hash"), salt: usersSheet.col("salt"),
    name: usersSheet.col("name", "display name"), role: usersSheet.col("role"), active: usersSheet.col("active"),
    created: usersSheet.col("createdat", "created at"),
  };
  for (const { row, sheetRow } of usersSheet.rows) {
    const email = trim(cell(row, uc.email)).toLowerCase();
    if (!email) continue; // nothing can sign in as a row without an email
    if (users.has(email)) {
      problem("Users", sheetRow, `the same email as row ${users.get(email).sheetRow}. Keep one of the two rows.`);
      continue;
    }
    users.set(email, {
      sheetRow,
      hash: trim(cell(row, uc.hash)),
      salt: String(cell(row, uc.salt) ?? ""),
      name: trim(cell(row, uc.name)),
      role: trim(cell(row, uc.role)).toLowerCase() || "admin",
      active: uc.active < 0 || String(cell(row, uc.active)).toLowerCase() !== "false",
      created: instantOf(cell(row, uc.created)),
    });
  }
  const whitelist = new Map();
  const whitelistSheet = rowsOf("Whitelist");
  const wc = {
    id: whitelistSheet.col("user_id"), name: whitelistSheet.col("name"), role: whitelistSheet.col("role"),
    email: whitelistSheet.col("email", "e-mail"), active: whitelistSheet.col("active"),
    created: whitelistSheet.col("created_at"), updated: whitelistSheet.col("updated_at"),
  };
  for (const { row, sheetRow } of whitelistSheet.rows) {
    const email = trim(cell(row, wc.email)).toLowerCase();
    if (!email) continue; // adminGetUsers leaves these out too
    if (whitelist.has(email)) {
      problem("Whitelist", sheetRow, `the same email as row ${whitelist.get(email).sheetRow}. Keep one of the two rows.`);
      continue;
    }
    whitelist.set(email, {
      sheetRow,
      id: trim(cell(row, wc.id)),
      name: trim(cell(row, wc.name)),
      role: trim(cell(row, wc.role)).toLowerCase() || "admin",
      active: String(cell(row, wc.active)).toLowerCase() !== "false",
      created: instantOf(cell(row, wc.created)),
      updated: instantOf(cell(row, wc.updated)),
    });
  }
  const admins = [];
  const userIds = new Map();
  for (const email of new Set([...whitelist.keys(), ...users.keys()])) {
    const u = users.get(email);
    const w = whitelist.get(email);
    const where = w ? ["Whitelist", w.sheetRow] : ["Users", u.sheetRow];
    if (!EMAIL.test(email) || email.length > 254) problem(...where, "the email address is not valid.");
    if (u && !w) {
      problem("Users", u.sheetRow, "this account can sign in but has no Whitelist row, so the Users screen does not list it. Add it to Whitelist, or delete its Users row.");
      continue;
    }
    if (u && w) {
      if (u.name && w.name && u.name !== w.name) problem("Whitelist", w.sheetRow, `the name differs from Users row ${u.sheetRow}. Make the two the same.`);
      if (u.role !== w.role) problem("Whitelist", w.sheetRow, `the role differs from Users row ${u.sheetRow}. Make the two the same.`);
      if (u.active !== w.active) problem("Whitelist", w.sheetRow, `active differs from Users row ${u.sheetRow}. Make the two the same.`);
    } else notes.push(`Whitelist row ${w.sheetRow} has no password in Users. It is imported, listed, and cannot sign in, as today.`);
    const role = w.role;
    if (!["admin", "superadmin"].includes(role)) problem(...where, `the role must be admin or superadmin.`);
    const name = w.name;
    if (!name) problem("Whitelist", w.sheetRow, "the name is blank.");
    else if (name.length > 160) problem("Whitelist", w.sheetRow, "the name is longer than 160 characters.");
    if (w.id) {
      if (userIds.has(w.id)) problem("Whitelist", w.sheetRow, `the same user_id as row ${userIds.get(w.id)}.`);
      userIds.set(w.id, w.sheetRow);
    }
    if (w.created === null) problem("Whitelist", w.sheetRow, "created_at is not a date.");
    if (w.updated === null) problem("Whitelist", w.sheetRow, "updated_at is not a date.");
    if (u?.created === null) problem("Users", u.sheetRow, "CreatedAt is not a date.");
    const created = w.created || u?.created || exportedAt.toISOString();
    admins.push({
      email,
      legacy_user_id: w.id || null,
      name,
      role,
      active: u ? u.active : w.active,
      password_hash: u?.hash ?? "",
      password_salt: u?.salt ?? "",
      created_at: created,
      updated_at: w.updated || created,
    });
  }
  if (!admins.some((a) => a.role === "superadmin" && a.active && a.password_hash))
    problem("Users", 0, "no active superadmin has a password, so nobody could manage accounts after the move.");
  const adminEmails = new Set(admins.map((a) => a.email));

  // --- Activities ---------------------------------------------------------------
  if (!sheets.Activity) problem("Activity", 0, "the sheet is missing.");
  const activitySheet = rowsOf("Activity");
  const ac = {
    title: activitySheet.col("title", "activity title", "activity"), venue: activitySheet.col("venue", "location"),
    from: activitySheet.col("fromdate", "from date", "start"), to: activitySheet.col("todate", "to date", "end"),
    template: activitySheet.col("certificate template", "template"),
    inCharge: activitySheet.col("focal-in-charge", "focal in charge", "in-charge", "in charge"),
    stamp: activitySheet.col("timestamp", "created at", "last updated"),
    given: activitySheet.col("given date", "date given", "givendate", "issued", "schedule"),
    code: activitySheet.col("activityid", "activity id", "id"), region: activitySheet.col("region", "ched region"),
    designation: activitySheet.col("signatory designation", "designation"),
    signature: activitySheet.col("e-signature", "signature", "signature image"),
    owner: activitySheet.col("created by", "createdby", "owner", "creator"), active: activitySheet.col("active", "enabled", "status"),
  };
  const activities = [];
  const byCode = new Map();
  const byTitle = new Map();
  for (const { row, sheetRow } of activitySheet.rows) {
    const at = (message) => problem("Activity", sheetRow, message);
    const code = textOf(cell(row, ac.code));
    const title = textOf(cell(row, ac.title));
    if (!code) at("there is no ActivityID. Every activity needs one; participants' responses refer to it.");
    else if (code.length > 40) at("the ActivityID is longer than 40 characters.");
    else if (byCode.has(code.toLowerCase())) at(`the same ActivityID as row ${byCode.get(code.toLowerCase()).sheetRow}.`);
    if (!title) at("there is no Title.");
    else if (title.length > 300) at("the Title is longer than 300 characters.");
    const from = dayOf(cell(row, ac.from));
    const to = dayOf(cell(row, ac.to));
    const given = dayOf(cell(row, ac.given));
    if (from === null) at("FromDate is not a date.");
    else if (!from) at("there is no FromDate.");
    if (to === null) at("ToDate is not a date.");
    if (from && to && to < from) at("ToDate is before FromDate.");
    if (given === null) at("Given Date is not a date.");
    const owner = textOf(cell(row, ac.owner)).toLowerCase();
    if (owner && !adminEmails.has(owner)) at("Created By is not one of the administrators. Change it to an administrator's email, or clear it.");
    const stamp = instantOf(cell(row, ac.stamp));
    if (stamp === null) at("Timestamp is not a date and time.");
    const activity = {
      sheetRow,
      id: randomUUID(),
      code,
      title,
      venue: textOf(cell(row, ac.venue)),
      from_date: from || null,
      to_date: to || null,
      given_date: given || null,
      region: textOf(cell(row, ac.region)),
      signatory_name: textOf(cell(row, ac.inCharge)),
      signatory_designation: textOf(cell(row, ac.designation)),
      signature_url: textOf(cell(row, ac.signature)),
      template_url: textOf(cell(row, ac.template)),
      created_by: owner || null,
      active: ac.active < 0 || isSwitchedOn(cell(row, ac.active)),
      updated_at: stamp || exportedAt.toISOString(),
    };
    activities.push(activity);
    if (code && !byCode.has(code.toLowerCase())) byCode.set(code.toLowerCase(), activity);
    const titleKey = title.toLowerCase();
    byTitle.set(titleKey, byTitle.has(titleKey) ? null : activity); // null: two activities share it
  }
  // The sheet has no creation time, only the last edit. Rows are appended as
  // activities are made, so the sheet's order is the creation order: each
  // activity is dated no later than its own last edit or any later row's,
  // and the admin list keeps the order it had.
  let earliestLater = Infinity;
  for (let i = activities.length - 1; i >= 0; i--) {
    earliestLater = Math.min(earliestLater, Date.parse(activities[i].updated_at));
    activities[i].created_ms = earliestLater;
  }
  let previous = -Infinity;
  for (const activity of activities) {
    previous = Math.max(activity.created_ms, previous + 1);
    activity.created_at = new Date(previous).toISOString();
    delete activity.created_ms;
  }

  // --- Responses (read first for their times: the survey is dated before them) ---
  const responseSheet = rowsOf("Responses");
  const rc = {
    timestamp: responseSheet.col("timestamp", "submitted at"), name: responseSheet.col("name"),
    email: responseSheet.col("responder email", "email", "e-mail"), sex: responseSheet.col("sex"), age: responseSheet.col("age"),
    activityId: responseSheet.col("activityid", "activity id", "id"),
    title: responseSheet.col("title of activity", "title", "activity title", "activity"), venue: responseSheet.col("venue", "location"),
    activityDate: responseSheet.col("activity_date", "date of activity"),
    takeaways: responseSheet.col("takeaways", "key takeaways", "most valuable takeaway"),
    suggestions: responseSheet.col("suggestions", "recommendations", "improvements"),
    status: responseSheet.col("cstatus", "status", "processing status"),
    emailSent: responseSheet.col("email sent", "emailsent", "email_sent", "sent", "date emailed"),
    certificate: responseSheet.col("certificate link", "certificate", "cert link", "certificate url"),
    code: responseSheet.col("verification code", "verification id", "certificate id"),
    answers: Array.from({ length: 15 }, (_, q) => responseSheet.col(`answer${q + 1}`, `q${q + 1}`, `question${q + 1}`)),
  };
  const inSheets = { verificationCodes: new Set(), auditIds: new Set() };
  let firstResponse = exportedAt.getTime();
  for (const { row } of responseSheet.rows) {
    const code = trim(cell(row, rc.code)).toUpperCase();
    if (code) inSheets.verificationCodes.add(code);
    const at = instantOf(cell(row, rc.timestamp));
    if (at) firstResponse = Math.min(firstResponse, Date.parse(at));
  }

  // --- Questions: today's 15 in three named sections, five to a page, dated
  // just before the first response so every response counts its scorecard
  // against them, as it was answered.
  const surveyDate = new Date(firstResponse - 1000).toISOString();
  const sections = DEFAULT_SECTIONS.map((name, i) => ({ id: randomUUID(), name, position: i + 1, created_at: surveyDate }));
  const questions = [];
  const questionSheet = sheetTable(sheets.Questions);
  const questionRow = questionSheet.data[0] || [];
  if (!sheets.Questions || !questionSheet.data.length) problem("Questions", 0, "there is no row of questions.");
  else
    for (let j = 1; j <= 15; j++) {
      const text = trim(cell(questionRow, questionSheet.col(`question${j}`, `question ${j}`)));
      if (!text) problem("Questions", 2, `question${j} is blank.`);
      else if (text.length > 500) problem("Questions", 2, `question${j} is longer than 500 characters.`);
      questions.push({
        id: randomUUID(),
        section_id: sections[Math.floor((j - 1) / 5)].id,
        position: (j - 1) % 5,
        text,
        type: normalizeQuestionType(cell(questionRow, questionSheet.col(`type${j}`, `type ${j}`, `question${j} type`))),
        created_at: surveyDate,
      });
    }

  const responses = [];
  const answers = [];
  const codes = new Map();
  const taken = new Map();
  let unlinked = 0;
  let generated = 0;
  for (const { row, sheetRow } of skipResponses ? [] : responseSheet.rows) {
    const at = (message) => problem("Responses", sheetRow, message);
    const submitted = instantOf(cell(row, rc.timestamp));
    if (!submitted) at("Timestamp is not a date and time.");
    const activityCode = textOf(cell(row, rc.activityId));
    const activityTitle = textOf(cell(row, rc.title));
    // As the queue matches a response to its activity: by ID, else by title.
    const activity = byCode.get(activityCode.toLowerCase()) || byTitle.get(activityTitle.toLowerCase()) || null;
    if (!activity) unlinked++;
    const name = textOf(cell(row, rc.name));
    const email = textOf(cell(row, rc.email));
    const sex = textOf(cell(row, rc.sex));
    const ageText = textOf(cell(row, rc.age));
    const age = /^\d{1,3}$/.test(ageText) ? Number(ageText) : NaN;
    const takeaways = textOf(cell(row, rc.takeaways));
    const suggestions = textOf(cell(row, rc.suggestions));
    if (!name || name.length > 160) at("Name is blank or longer than 160 characters.");
    if (!EMAIL.test(email) || email.length > 254) at("Responder Email is not a valid email address.");
    if (!sex || sex.length > 40) at("Sex is blank or longer than 40 characters.");
    if (!(age >= 1 && age <= 120)) at("Age is not a whole number from 1 to 120.");
    if (takeaways.length > 2000) at("Takeaways is longer than 2,000 characters.");
    if (suggestions.length > 2000) at("Suggestions is longer than 2,000 characters.");

    // certificateState_: OK, ERROR: <why>, PENDING or PROCESSING.
    const status = trim(cell(row, rc.status));
    const upper = status.toUpperCase();
    let state = null;
    let error = null;
    let claimedAt = null;
    if (upper.startsWith("ERROR")) {
      state = "failed";
      error = status.replace(/^ERROR:\s*/i, "");
    } else if (upper === "OK") state = "issued";
    else if (upper === "PENDING") state = "pending";
    else if (upper === "PROCESSING") {
      // A run that had it when the sheets were exported. Claimed as of the
      // export, so the new worker takes it again once that claim runs out,
      // exactly as it recovers a run of its own that died.
      state = "processing";
      claimedAt = exportedAt.toISOString();
    } else at(`cStatus is "${status.slice(0, 40)}"; it must be PENDING, PROCESSING, OK or ERROR: <reason>.`);

    // "Email Sent": when it went (a date, or the text Code.gs wrote), then any
    // note such as a link-sharing warning; or only a note ("No recipient email").
    const sent = cell(row, rc.emailSent);
    let emailedAt = null;
    let emailNote = null;
    if (isDate(sent)) emailedAt = instantOf(sent);
    else {
      const text = trim(sent);
      const m = text.match(/^(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2})(?::\d{2})?(.*)$/);
      const when = m ? instantOf(m[1]) : null;
      if (when) {
        emailedAt = when;
        emailNote = trim(m[2]) || null;
      } else emailNote = text || null;
    }

    let code = trim(cell(row, rc.code)).toUpperCase();
    if (!code) {
      // Rows from before verification codes existed. Code.gs gives one at
      // issue time; the new schema needs one on every row.
      code = newVerificationCode();
      generated++;
      fills.push({ sheet: "Responses", sheetRow, header: "Verification Code", value: code });
    } else if (!CODE.test(code)) at("Verification Code is not CHED- followed by 20 letters A–F or digits.");
    else if (codes.has(code)) at(`the same Verification Code as row ${codes.get(code)}.`);
    codes.set(code, codes.get(code) ?? sheetRow);

    // The new database's duplicate rule: one response per activity and email,
    // failed ones aside.
    if (activity && state && state !== "failed") {
      const key = `${activity.id}|${email.toLowerCase()}`;
      if (taken.has(key)) at(`the same participant email and activity as row ${taken.get(key)}, and neither failed. Delete one, or mark one ERROR.`);
      else taken.set(key, sheetRow);
    }

    rc.answers.forEach((column, q) => {
      const value = textOf(cell(row, column));
      if (!value || !questions[q]) return;
      if (value.length > 2000) at(`Answer${q + 1} is longer than 2,000 characters.`);
      answers.push({ legacy_sheet_row: sheetRow, question_id: questions[q].id, value });
    });

    const dateCell = cell(row, rc.activityDate);
    responses.push({
      legacy_sheet_row: sheetRow,
      submitted_at: submitted || null,
      activity_id: activity?.id ?? null,
      activity_code: activityCode,
      activity_title: activityTitle,
      venue: textOf(cell(row, rc.venue)),
      activity_date: isDate(dateCell) ? dayOf(dateCell) || "" : trim(dateCell),
      name,
      email,
      sex,
      age: Number.isNaN(age) ? null : age,
      takeaways,
      suggestions,
      certificate_status: state,
      certificate_error: error,
      claimed_at: claimedAt,
      certificate_url: textOf(cell(row, rc.certificate)) || null,
      emailed_at: emailedAt || null,
      email_note: emailNote,
      verification_code: code,
    });
  }
  if (unlinked) notes.push(`${unlinked} response(s) name an activity no longer in the Activity sheet. They are kept, as in Sheets, without a link to one.`);
  if (generated) notes.push(`${generated} response(s) had no verification code and were given one.`);
  if (skipResponses) notes.push(`--skip-responses: the ${responseSheet.rows.length} response(s) in the sheet stay in Sheets and are not imported.`);

  // --- Audit log, as displayed: the text its hashes cover -------------------------
  const auditSheet = sheetTable(sheets.Audit);
  const au = Object.fromEntries(["timestamp", "audit_id", "actor_email", "actor_role", "action", "target_type", "target_id", "outcome",
    "details", "request_id", "previous_hash", "entry_hash"].map((name) => [name, auditSheet.col(name)]));
  const audit = [];
  const auditIds = new Map();
  const hashes = new Map();
  auditSheet.data.forEach((row, i) => {
    const sheetRow = i + 2;
    const at = (message) => problem("Audit", sheetRow, message);
    const value = (name) => trim(cell(row, au[name]));
    const entry = {
      logged_at: normalizeAuditTimestamp(value("timestamp")),
      audit_id: value("audit_id"),
      actor_email: value("actor_email"),
      actor_role: value("actor_role"),
      action: value("action"),
      target_type: value("target_type"),
      target_id: value("target_id"),
      outcome: value("outcome"),
      details: value("details"),
      request_id: value("request_id"),
      previous_hash: value("previous_hash"),
      entry_hash: value("entry_hash"),
    };
    if (isBlankRow(row)) return at("the row is blank. A blank row breaks the chain; delete it in Sheets.");
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(entry.logged_at)) at("timestamp is not yyyy-MM-dd HH:mm:ss.");
    if (!["SUCCESS", "FAILURE"].includes(entry.outcome)) at("outcome is not SUCCESS or FAILURE.");
    if (!entry.audit_id) at("there is no audit_id.");
    else if (auditIds.has(entry.audit_id)) at(`the same audit_id as row ${auditIds.get(entry.audit_id)}.`);
    if (!entry.entry_hash) at("there is no entry_hash.");
    else if (hashes.has(entry.entry_hash)) at(`the same entry_hash as row ${hashes.get(entry.entry_hash)}.`);
    auditIds.set(entry.audit_id, auditIds.get(entry.audit_id) ?? sheetRow);
    hashes.set(entry.entry_hash, hashes.get(entry.entry_hash) ?? sheetRow);
    inSheets.auditIds.add(entry.audit_id);
    audit.push(entry);
  });
  const head = trim(exported.properties?.AUDIT_HEAD_HASH);
  const settings = head ? [{ key: "audit_head_hash", value: head }] : [];

  for (const [name, count] of Object.entries(blankRows)) notes.push(`${count} blank row(s) in ${name} were skipped.`);
  return {
    tables: {
      admins,
      activities: activities.map(({ sheetRow, ...activity }) => activity),
      sections,
      questions,
      responses,
      answers,
      audit,
      settings,
    },
    problems,
    notes,
    fills,
    inSheets,
  };
}

// --- Loading ------------------------------------------------------------------

/** The new tables, in the order rows can be inserted, with how each is compared after. */
const TIME = "time";
const TABLES = [
  { table: "admin_users", from: "admins", key: ["email"], columns: ["email", "legacy_user_id", "name", "role", "active", "password_hash",
    "password_salt", ["created_at", TIME], ["updated_at", TIME]] },
  { table: "activities", from: "activities", key: ["code"], columns: ["id", "code", "title", "venue", "from_date", "to_date", "given_date",
    "region", "signatory_name", "signatory_designation", "signature_url", "template_url", "created_by", "active",
    ["created_at", TIME], ["updated_at", TIME]] },
  { table: "survey_sections", from: "sections", key: ["id"], columns: ["id", "name", "position", ["created_at", TIME]] },
  { table: "questions", from: "questions", key: ["id"], columns: ["id", "section_id", "position", "text", "type", ["created_at", TIME]] },
  { table: "responses", from: "responses", key: ["legacy_sheet_row"], columns: ["legacy_sheet_row", ["submitted_at", TIME], "activity_id",
    "activity_code", "activity_title", "venue", "activity_date", "name", "email", "sex", "age", "takeaways", "suggestions",
    "certificate_status", "certificate_error", ["claimed_at", TIME], "certificate_url", ["emailed_at", TIME], "email_note",
    "verification_code"] },
  { table: "answers", from: "answers", key: ["legacy_sheet_row", "question_id"], columns: ["legacy_sheet_row", "question_id", "value"] },
  // The chain's order is its meaning, so the audit log is compared in order.
  { table: "audit_log", from: "audit", key: null, columns: ["logged_at", "audit_id", "actor_email", "actor_role", "action", "target_type",
    "target_id", "outcome", "details", "request_id", "previous_hash", "entry_hash"] },
  { table: "settings", from: "settings", key: ["key"], columns: ["key", "value"] },
];
const columnName = (column) => (Array.isArray(column) ? column[0] : column);

/** Thrown inside the transaction to roll it back, and reported to the caller. */
class ImportStopped extends Error {
  constructor(stage, details) {
    super(stage);
    this.stage = stage;
    this.details = details;
  }
}

const CLEARED = ["answers", "responses", "questions", "survey_sections", "admin_sessions", "login_attempts", "activities", "admin_users",
  "audit_log", "settings"];

/**
 * An empty database is filled. One that holds data is replaced only with
 * `replace`, and never silently loses what the sheets do not have: responses
 * and audit entries made through the new backend (a rehearsal's tests, or
 * after cutover, real ones) need `discardNewData` as well.
 */
async function prepareTarget(tx, converted, { replace, discardNewData }) {
  const [counts] = await tx.query(`select ${CLEARED.map((t) => `(select count(*) from portal.${t})::int as ${t}`).join(", ")}`);
  const held = Object.entries(counts).filter(([, n]) => n > 0);
  if (!held.length) return null;
  const listed = held.map(([table, n]) => `${n} ${table}`).join(", ");
  if (!replace)
    throw new ImportStopped("target", `The database already holds data (${listed}). To replace it with this export, run again with --replace.`);
  const [lost] = await tx.query(
    `select (select count(*) from portal.responses
              where verification_code not in (select json_array_elements_text($1::json)))::int as responses,
            (select count(*) from portal.audit_log
              where audit_id not in (select json_array_elements_text($2::json)))::int as audit`,
    [JSON.stringify([...converted.inSheets.verificationCodes]), JSON.stringify([...converted.inSheets.auditIds])],
  );
  if ((lost.responses || lost.audit) && !discardNewData)
    throw new ImportStopped("target",
      `${lost.responses} response(s) and ${lost.audit} audit entr${lost.audit === 1 ? "y" : "ies"} in the database are not in this export: ` +
      "they were made through the new backend. Replacing would delete them. If they are tests (a rehearsal on staging), " +
      "run again with --replace --discard-new-data. If they are real, do not replace this database.");
  // The audit log refuses TRUNCATE from everyone; only its owner can lift
  // that, and only inside this transaction.
  await tx.query(`alter table portal.audit_log disable trigger audit_log_no_truncate`);
  await tx.query(`truncate ${CLEARED.map((t) => `portal.${t}`).join(", ")} restart identity`);
  await tx.query(`alter table portal.audit_log enable trigger audit_log_no_truncate`);
  return { replaced: Object.fromEntries(held), discarded: lost };
}

async function load(tx, tables) {
  for (const spec of TABLES) {
    const rows = tables[spec.from];
    if (spec.table === "answers") {
      await tx.query(
        `insert into portal.answers (response_id, question_id, value)
         select r.id, a.question_id, a.value
           from json_to_recordset($1::json) as a(legacy_sheet_row integer, question_id uuid, value text)
           join portal.responses r on r.legacy_sheet_row = a.legacy_sheet_row`,
        [JSON.stringify(rows)],
      );
      continue;
    }
    const columns = spec.columns.map(columnName).join(", ");
    // In the export's order: responses and the audit log are numbered as they arrive.
    await tx.query(
      `insert into portal.${spec.table} (${columns})
       select ${columns} from json_populate_recordset(null::portal.${spec.table}, $1::json) with ordinality as source
        order by source.ordinality`,
      [JSON.stringify(rows)],
    );
  }
}

// --- Checks -------------------------------------------------------------------

const asText = (value, type) => (value == null ? null : type === TIME ? new Date(value).toISOString() : String(value));

/** 1. Every table holds exactly the rows converted, every field. */
async function compareTables(tx, tables) {
  const failures = [];
  for (const spec of TABLES) {
    const select = spec.columns.map((column) => {
      const [name, type] = Array.isArray(column) ? column : [column];
      const source = spec.table === "answers" && name === "legacy_sheet_row" ? "r.legacy_sheet_row" : spec.table === "answers" ? `a.${name}` : name;
      return type === TIME
        ? `to_char(${source} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ${name}`
        : `${source}::text as ${name}`;
    }).join(", ");
    const actual = spec.table === "answers"
      ? await tx.query(`select ${select} from portal.answers a join portal.responses r on r.id = a.response_id`)
      : await tx.query(`select ${select} from portal.${spec.table} order by ${spec.table === "audit_log" ? "id" : "1"}`);
    const expected = tables[spec.from].map((row) =>
      Object.fromEntries(spec.columns.map((column) => {
        const [name, type] = Array.isArray(column) ? column : [column];
        return [name, asText(row[name], type)];
      })));
    if (actual.length !== expected.length) {
      failures.push(`${spec.table}: ${actual.length} rows, expected ${expected.length}`);
      continue;
    }
    const keyOf = (row, i) => (spec.key ? spec.key.map((k) => row[k]).join("|") : String(i));
    const byKey = new Map(actual.map((row, i) => [keyOf(row, i), row]));
    let reported = 0;
    expected.forEach((row, i) => {
      const key = keyOf(row, i);
      const got = byKey.get(key);
      const where = spec.key ? `${spec.key.join("+")} ${spec.table === "admin_users" ? `#${i + 1}` : key}` : `entry ${i + 1}`;
      if (!got) {
        if (reported++ < 10) failures.push(`${spec.table}: ${where} is missing`);
        return;
      }
      for (const column of spec.columns) {
        const name = columnName(column);
        if (got[name] !== row[name] && reported++ < 10) failures.push(`${spec.table}: ${where}, ${name} differs`);
      }
    });
  }
  return failures;
}

/** 2. The audit chain verifies, and ends at the head Apps Script recorded. */
async function checkChain(tx, auditSecret) {
  const { rows, expectedHead } = await readAuditChain(tx);
  const chain = checkAuditChain(rows, expectedHead, auditSecret);
  if (chain.valid) return { failures: [], chain };
  const failures = [];
  if (chain.hashFailures === rows.length && rows.length)
    failures.push("audit chain: every entry fails its hash. AUDIT_HASH_SECRET is not the value in Apps Script's Script Properties.");
  else if (chain.hashFailures || chain.linkFailures)
    failures.push(`audit chain: ${chain.hashFailures} entr${chain.hashFailures === 1 ? "y fails" : "ies fail"} its hash and ${chain.linkFailures} ` +
      `break${chain.linkFailures === 1 ? "s" : ""} the chain, the first at Audit sheet row ${chain.firstBroken + 1}. ` +
      "Run auditChainDiagnose() in the Apps Script editor.");
  if (!chain.headMatches) failures.push("audit chain: the last entry is not the head recorded in AUDIT_HEAD_HASH: the latest entries were deleted.");
  return { failures, chain };
}

/** Where two replies first differ, as a path such as entries[3].emailSent. Never the values. */
export function firstDifference(a, b, path = "") {
  if (Object.is(a, b)) return null;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b))
    return path || "(the whole reply)";
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path || "(list)"} has ${a.length} items, Apps Script ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const found = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const found = firstDifference(a[key], b[key], path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
}

/**
 * Code.gs prints a date-typed "Email Sent" cell (Sheets turns the text it
 * wrote into a date) as a raw JavaScript date. The new backend prints the
 * time as the sheet's text read. Same moment, so compared as that text.
 */
const asSheetText = (value) =>
  typeof value === "string" && /GMT[+-]\d{4}/.test(value) && !Number.isNaN(Date.parse(value)) ? minuteStamp(new Date(value)) : value;
const withSheetEmailText = (entries) => entries.map((entry) => ({ ...entry, emailSent: asSheetText(entry.emailSent) }));

/**
 * The verification page's "issued" time. Code.gs prints the Email Sent cell
 * through fmtDate_: a date-typed cell as its day alone, a text cell as written,
 * with any sharing note after the time. The new backend prints the date and
 * time alone. The same issue time either way, so compared as the new form.
 */
function sameIssueTime(mine, theirs) {
  if (mine?.valid !== true || theirs?.valid !== true || mine.issuedAt === theirs.issuedAt) return theirs;
  const issued = String(mine.issuedAt);
  const shown = String(theirs.issuedAt);
  const same = (DAY.test(shown) && issued.startsWith(`${shown} `)) || (issued && shown.startsWith(`${issued} `));
  return same ? { ...theirs, issuedAt: mine.issuedAt } : theirs;
}

const CHECKER = { email: "import-check@portal.invalid", name: "Import check", role: "superadmin" };
const STANDARD_HEADERS = {
  Whitelist: ["user_id", "name", "role", "email", "active", "created_at", "updated_at"],
  Audit: ["timestamp", "audit_id", "actor_email", "actor_role", "action", "target_type", "target_id", "outcome", "details",
    "request_id", "previous_hash", "entry_hash"],
};

/**
 * 3. Every screen, read from the new database and from Code.gs run on the
 * same export, must match. Set aside only what is meant to differ (see
 * scripts/lib/code-gs.mjs): IDs, the edit times the new backend keeps per
 * row, and the question detail phase 1b adds.
 */
export async function compareWithAppsScript(db, exported, { auditSecret, now, skipResponses = false, fills = [] }) {
  const properties = new Map([["AUDIT_HASH_SECRET", auditSecret], ["AUDIT_HEAD_HASH", trim(exported.properties?.AUDIT_HEAD_HASH)]]);
  const { gas, sheets, SandboxDate } = codeGs({ properties, timeZone: exported.timeZone });
  const revive = (value) => (isDate(value) ? new SandboxDate(value.$date || NaN) : value);
  for (const name of SHEETS) {
    const rows = exported.sheets[name];
    if (!rows) {
      if (STANDARD_HEADERS[name]) sheets[name] = standInSheet([[...STANDARD_HEADERS[name]]]);
      continue;
    }
    const [header = [], ...data] = rows.map((row) => row.map(revive));
    // The import skips blank rows (the Audit sheet's are refused before this).
    const kept = name === "Responses" && skipResponses ? [] : name === "Audit" ? data : data.filter((row) => !row.every((v) => trim(v) === ""));
    sheets[name] = standInSheet([[...header], ...kept]);
  }
  // The verification codes the import gave to rows that had none.
  const responses = sheets.Responses;
  for (const fill of fills) {
    let column = responses.rows[0].findIndex((h) => trim(h).toLowerCase() === fill.header.toLowerCase());
    if (column < 0) column = responses.rows[0].push(fill.header) - 1;
    const sheetRows = exported.sheets.Responses.slice(1);
    const position = sheetRows.slice(0, fill.sheetRow - 2).filter((row) => !isBlankRow(row)).length; // after blank rows are dropped
    responses.rows[position + 1][column] = fill.value;
  }
  gas.todayKey_ = () => dateKey(now);
  gas.getAdminSession_ = () => ({ ...CHECKER });

  const token = "import-check";
  const context = {
    db,
    now,
    secrets: { auditSecret },
    sessions: new Map([[token, { ...CHECKER, expiresAt: now.getTime() + 3600_000 }]]),
  };
  const ask = async (action, extra = {}) => json(await HANDLERS.get(action)({ adminToken: token, ...extra }, context));

  const failures = [];
  const screens = [];
  const compare = (screen, actual, expected) => {
    screens.push(screen);
    const where = firstDifference(actual, expected);
    if (where) failures.push(`${screen}: differs from Apps Script at ${where}`);
  };
  const byEmail = (users) => [...users].sort((a, b) => a.email.localeCompare(b.email));

  compare("survey activity list", await ask("getActivityData"), json(gas.getActivityData()));
  compare("survey questions", flatQuestions(await ask("getQuestions")), flatQuestions(json(gas.getQuestions())));
  compare("Activities", withoutKeys(await ask("adminGetActivities"), "id", "Timestamp"),
    withoutKeys(json(gas.adminGetActivities(token)), "id", "Timestamp"));
  compare("Users", withoutKeys(byEmail(await ask("adminGetUsers")), "created_at", "updated_at"),
    withoutKeys(byEmail(json(gas.adminGetUsers(token))), "created_at", "updated_at").map((u) => ({ ...u, role: u.role.toLowerCase() })));
  const mine = await ask("adminGetResponses", { filters: { limit: 500 } });
  const theirs = json(gas.adminGetResponses({ limit: 500 }, token));
  compare("Responses", { total: mine.total, entries: comparableResponses(mine.entries) },
    { total: theirs.total, entries: comparableResponses(withSheetEmailText(theirs.entries)) });
  for (const state of ["QUEUED", "PROCESSING", "ISSUED", "FAILED"]) {
    const queue = json(gas.adminGetCertificateQueue({ state }, token));
    compare(`Certificates (${state})`, comparableQueue(await ask("adminGetCertificateQueue", { filters: { state } })),
      comparableQueue({ ...queue, entries: withSheetEmailText(queue.entries) }));
  }
  const activities = await db.query(`select code from portal.activities order by created_at, code`);
  for (const activityId of ["", ...activities.map((a) => a.code)])
    compare(`Analytics (${activityId || "all activities"})`, comparableAnalytics(await ask("adminGetFeedbackAnalytics", { activityId })),
      json(gas.adminGetFeedbackAnalytics(activityId, token)));
  // The Audit screen in Code.gs shows a timestamp as Sheets displays it,
  // which drops a leading zero ("8:05:00"); the import stores the padded text
  // the entry's hash covers.
  const gasAudit = json(gas.adminGetAuditLog({ limit: "all" }, token));
  compare("Audit", await ask("adminGetAuditLog", { filters: { limit: "all" } }),
    { ...gasAudit, entries: gasAudit.entries.map((entry) => ({ ...entry, timestamp: normalizeAuditTimestamp(entry.timestamp) })) });
  let verified = 0;
  const codes = await db.query(`select id::int as id, legacy_sheet_row, verification_code from portal.responses order by id`);
  for (const response of codes) {
    const code = response.verification_code;
    const mine = await ask("verifyCertificate", { code });
    const where = firstDifference(mine, sameIssueTime(mine, json(gas.verifyCertificate(code))));
    const which = response.legacy_sheet_row ? `Responses row ${response.legacy_sheet_row}` : `response ${response.id}`;
    if (where && failures.length < 50) failures.push(`verification of the code on ${which}: differs at ${where}`);
    verified++;
  }
  if (verified) screens.push(`verification (${verified} codes)`);
  return { failures, screens, responsesTotal: mine.total };
}

/**
 * Converts, loads and checks, all in one transaction: either every check
 * passes and the import is committed, or nothing is written.
 *
 * Returns { ok: true, counts, checks, notes, replaced } or
 *         { ok: false, stage: "convert" | "target" | "check", problems | message | failures, notes }.
 */
export async function importSheets(db, exported, {
  skipResponses = false, replace = false, discardNewData = false, auditSecret, now = new Date(),
} = {}) {
  if (!trim(auditSecret)) throw new Error("The audit secret is required: the import checks the audit chain with it.");
  const converted = convertExport(exported, { skipResponses });
  if (converted.problems.length) return { ok: false, stage: "convert", problems: converted.problems, notes: converted.notes };
  // When the database took over from the sheets: a rollback copies back what
  // changed after it (workerReplayExport).
  converted.tables.settings.push(
    { key: "imported_at", value: now.toISOString() },
    // Which question each of the sheet's Answer1…Answer15 columns held.
    { key: "imported_questions", value: JSON.stringify(converted.tables.questions.map((q) => q.id)) },
  );
  try {
    const result = await db.transaction(async (tx) => {
      const replaced = await prepareTarget(tx, converted, { replace, discardNewData });
      await load(tx, converted.tables);
      const tableFailures = await compareTables(tx, converted.tables);
      const { failures: chainFailures, chain } = await checkChain(tx, auditSecret);
      const parity = await compareWithAppsScript(tx, exported, { skipResponses, auditSecret, now, fills: converted.fills });
      const failures = [...tableFailures, ...chainFailures, ...parity.failures];
      if (failures.length) throw new ImportStopped("check", failures);
      return {
        replaced,
        counts: Object.fromEntries(TABLES.map((spec) => [spec.table, converted.tables[spec.from].length])),
        checks: {
          rows: "every row, field by field",
          auditChain: `${chain.checkedRows} entries verify${converted.tables.settings.length ? ", ending at the recorded head" : ""}`,
          appsScript: parity.screens,
          responsesCompared: parity.responsesTotal > 500 ? `the newest 500 of ${parity.responsesTotal}` : "all",
        },
      };
    });
    return { ok: true, ...result, notes: converted.notes };
  } catch (error) {
    if (!(error instanceof ImportStopped)) throw error;
    return error.stage === "check"
      ? { ok: false, stage: "check", failures: error.details, notes: converted.notes }
      : { ok: false, stage: error.stage, message: error.details, notes: converted.notes };
  }
}
