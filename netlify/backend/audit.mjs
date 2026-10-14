import { constantTimeEquals, hmacBase64, newAuditId } from "./crypto.mjs";
import { requireSuperadmin } from "./users.mjs";
import { PORTAL_TIME_ZONE } from "./time.mjs";

/**
 * The tamper-evident audit log, ported from Code.gs so imported entries and
 * new ones form one chain: each entry's HMAC covers the same fields in the
 * same order, keyed with the same AUDIT_HASH_SECRET, and links to the entry
 * before it.
 */

const LABELS = {
  adminLogin: "LOGIN",
  adminLogout: "LOGOUT",
  adminSaveActivity: "ACTIVITY_SAVE",
  adminSetActivityStatus: "ACTIVITY_STATUS",
  adminDeleteActivity: "ACTIVITY_DELETE",
  adminRetryCertificates: "CERTIFICATE_RETRY",
  adminUploadSignature: "SIGNATURE_UPLOAD",
  adminSaveUser: "USER_SAVE",
  adminSaveQuestions: "QUESTIONS_SAVE",
};

export const isAudited = (action) => Object.hasOwn(LABELS, action);

const trim = (value) => String(value ?? "").trim();

/** What the entry is about, as auditTargetForRequest_ in Code.gs. */
export function auditTarget(action, body, actor) {
  const payload = body?.payload || {};
  switch (action) {
    case "adminLogin":
    case "adminLogout":
      // Code.gs read the actor again after logout, when the session was
      // already gone, so its LOGOUT entries named nobody. The actor captured
      // before the action fixes that.
      return { type: "session", id: trim(body?.email || actor?.email) };
    case "adminSaveActivity":
      return {
        type: "activity",
        id: trim(payload.activityId || payload.id || payload.title),
        details: { operation: payload.id ? "update" : "create", title: trim(payload.title).slice(0, 160) },
      };
    case "adminSetActivityStatus":
      return {
        type: "activity",
        id: trim(payload.id),
        details: {
          operation: payload.active === true || String(payload.active).toLowerCase() === "true" ? "enable" : "disable",
        },
      };
    case "adminDeleteActivity":
      return { type: "activity", id: trim(body?.id || payload.id) };
    case "adminRetryCertificates":
      return { type: "certificate", id: (payload.rows || []).join(","), details: { count: (payload.rows || []).length } };
    case "adminUploadSignature":
      return { type: "signature", id: trim(payload.filename).slice(0, 180) };
    case "adminSaveUser":
      return {
        type: "user",
        id: trim(payload.user_id || payload.email).toLowerCase(),
        details: { role: trim(payload.role).toLowerCase(), active: payload.active !== false },
      };
    case "adminSaveQuestions": {
      // Either Apps Script's list of 15, or the editor's sections.
      const saved = body?.questions || payload.questions || [];
      const count = Array.isArray(saved)
        ? saved.length
        : (saved.sections || []).reduce((sum, section) => sum + (section?.questions?.length || 0), 0);
      return { type: "survey", id: "Questions", details: { questionCount: count } };
    }
    default:
      return { type: "system", id: "" };
  }
}

const stampFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: PORTAL_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** 'yyyy-MM-dd HH:mm:ss' in Manila, the text every entry's hash covers. */
export function auditTimestamp(date) {
  const part = Object.fromEntries(stampFormat.formatToParts(date).map((p) => [p.type, p.value]));
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}:${part.second}`;
}

/** Code.gs normalizeAuditTimestamp_: restores zero-padding that Sheets dropped. */
export function normalizeAuditTimestamp(value) {
  const raw = trim(value);
  const m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})/);
  if (!m) return raw;
  const pad = (part) => part.padStart(2, "0");
  return `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4])}:${pad(m[5])}:${pad(m[6])}`;
}

/** Code.gs auditCanonical_: the exact string an entry's HMAC covers. */
export function auditCanonical(entry) {
  return [
    normalizeAuditTimestamp(entry.logged_at), entry.audit_id, entry.actor_email, entry.actor_role, entry.action,
    entry.target_type, entry.target_id, entry.outcome, entry.details, entry.request_id, entry.previous_hash,
  ].map(trim).join("|");
}

/**
 * Append one entry. An advisory lock makes concurrent writers take turns, so
 * each entry links to the one actually before it. Without AUDIT_HASH_SECRET
 * nothing is written, as in Code.gs.
 */
export async function appendAudit(db, { secret, now, action, body, success, error, actor, requestId }) {
  if (!secret) return null;
  const target = auditTarget(action, body, actor);
  const entry = {
    logged_at: auditTimestamp(now),
    audit_id: newAuditId(),
    actor_email: trim(actor?.email).toLowerCase(),
    actor_role: trim(actor?.role).toLowerCase(),
    action: LABELS[action] || trim(action).toUpperCase(),
    target_type: target.type,
    target_id: target.id,
    outcome: success ? "SUCCESS" : "FAILURE",
    details: JSON.stringify(success ? target.details || {} : { error: trim(error).slice(0, 300) }),
    request_id: trim(requestId).slice(0, 100),
  };
  return db.transaction(async (tx) => {
    await tx.query(`select 1 from pg_advisory_xact_lock(hashtext('portal.audit_log'))`);
    const [last] = await tx.query(`select entry_hash from portal.audit_log order by id desc limit 1`);
    entry.previous_hash = last?.entry_hash ?? "";
    entry.entry_hash = hmacBase64(auditCanonical(entry), secret);
    await tx.query(
      `insert into portal.audit_log (logged_at, audit_id, actor_email, actor_role, action, target_type,
         target_id, outcome, details, request_id, previous_hash, entry_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [entry.logged_at, entry.audit_id, entry.actor_email, entry.actor_role, entry.action, entry.target_type,
       entry.target_id, entry.outcome, entry.details, entry.request_id, entry.previous_hash, entry.entry_hash],
    );
    await tx.query(
      `insert into portal.settings (key, value) values ('audit_head_hash', $1)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [entry.entry_hash],
    );
    return entry;
  });
}

/**
 * Re-verifies the whole chain, oldest entry first. Each entry must hash to
 * itself and link to the one before, and the last must be the head recorded
 * in settings: a deleted latest entry breaks that. `firstBroken` is the
 * 1-based position of the first entry that fails, 0 when none does.
 */
export function checkAuditChain(rows, expectedHead, secret) {
  let hashFailures = 0;
  let linkFailures = 0;
  let firstBroken = 0;
  let previous = null;
  rows.forEach((entry, i) => {
    const hashOk = !!secret && constantTimeEquals(hmacBase64(auditCanonical(entry), secret), entry.entry_hash);
    const linkOk = previous === null || entry.previous_hash === previous;
    if (!hashOk) hashFailures++;
    if (!linkOk) linkFailures++;
    if ((!hashOk || !linkOk) && !firstBroken) firstBroken = i + 1;
    previous = entry.entry_hash;
  });
  const headMatches = rows.length ? !expectedHead || previous === expectedHead : !expectedHead;
  return { valid: !hashFailures && !linkFailures && headMatches, checkedRows: rows.length, hashFailures, linkFailures, firstBroken, headMatches };
}

/** Every entry, oldest first, and the head the chain must end at. */
export async function readAuditChain(db) {
  const [head] = await db.query(`select value from portal.settings where key = 'audit_head_hash'`);
  const rows = await db.query(
    `select logged_at, audit_id, actor_email, actor_role, action, target_type, target_id, outcome, details,
            request_id, previous_hash, entry_hash
       from portal.audit_log order by id`,
  );
  return { rows, expectedHead: head?.value || "" };
}

/**
 * The Audit screen (superadmins only): newest first, filtered, and with the
 * whole chain re-verified on every read, as Code.gs adminGetAuditLog.
 */
export async function adminGetAuditLog(body, context) {
  await requireSuperadmin(context, body?.adminToken);
  const filters = body?.filters || {};
  const { rows, expectedHead } = await readAuditChain(context.db);
  if (!rows.length) return { entries: [], integrity: { valid: !expectedHead, checkedRows: 0 } };
  const { valid } = checkAuditChain(rows, expectedHead, context.secrets?.auditSecret);

  const action = trim(filters.action).toUpperCase();
  const outcome = trim(filters.outcome).toUpperCase();
  const query = trim(filters.query).toLowerCase();
  const filtered = rows.filter((entry) =>
    (!action || entry.action === action) &&
    (!outcome || entry.outcome === outcome) &&
    (!query || [entry.actor_email, entry.target_id, entry.action, entry.details, entry.request_id].join(" ").toLowerCase().includes(query)));
  // "all" still stops at 2,000 entries, so a long log cannot outgrow a reply.
  const limit = trim(filters.limit).toLowerCase() === "all" ? 2000 : Math.min(500, Math.max(25, Number(filters.limit) || 200));
  const parse = (text) => {
    try {
      return JSON.parse(text || "{}");
    } catch {
      return {};
    }
  };
  return {
    entries: filtered.slice(-limit).reverse().map((entry) => ({
      timestamp: entry.logged_at,
      audit_id: entry.audit_id,
      actor_email: entry.actor_email,
      actor_role: entry.actor_role,
      action: entry.action,
      target_type: entry.target_type,
      target_id: entry.target_id,
      outcome: entry.outcome,
      details: parse(entry.details),
      request_id: entry.request_id,
    })),
    integrity: { valid, checkedRows: rows.length },
    total: filtered.length,
  };
}
