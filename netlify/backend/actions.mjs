import {
  adminGetActivities,
  adminGetCertificateQueue,
  adminGetDashboard,
  adminGetFeedbackAnalytics,
  adminGetResponses,
} from "./admin.mjs";
import { adminGetAuditLog, appendAudit, isAudited } from "./audit.mjs";
import {
  adminDeleteActivity,
  adminRetryCertificates,
  adminSaveActivity,
  adminSetActivityStatus,
} from "./manage.mjs";
import { adminLogin, adminLogout, adminValidateSession, getAdminSession } from "./auth.mjs";
import { getActivityData, getQuestions, verifyCertificate } from "./public.mjs";
import { adminUploadSignature } from "./signature.mjs";
import { adminGetQuestions, adminSaveQuestions } from "./survey.mjs";
import { adminGetUsers, adminSaveUser } from "./users.mjs";
import { submitFeedback } from "./submit.mjs";

/**
 * Every action doPost in Code.gs accepts. Phase 1 ports them one at a time;
 * an action listed here without a handler answers that it is not ported yet,
 * instead of "unknown", so a half-switched backend is easy to diagnose.
 */
export const ACTIONS = [
  "getActivityData",
  "getQuestions",
  "submitFeedback",
  "verifyCertificate",
  "adminLogin",
  "adminValidateSession",
  "adminLogout",
  "adminGetActivities",
  "adminSaveActivity",
  "adminSetActivityStatus",
  "adminDeleteActivity",
  "adminUploadSignature",
  "adminGetFeedbackAnalytics",
  "adminGetUsers",
  "adminSaveUser",
  "adminGetQuestions",
  "adminSaveQuestions",
  "adminGetDashboard",
  "adminGetResponses",
  "adminGetCertificateQueue",
  "adminRetryCertificates",
  "adminGetAuditLog",
];

export const HANDLERS = new Map([
  ["getActivityData", getActivityData],
  ["getQuestions", getQuestions],
  ["submitFeedback", submitFeedback],
  ["verifyCertificate", verifyCertificate],
  ["adminLogin", adminLogin],
  ["adminValidateSession", adminValidateSession],
  ["adminLogout", adminLogout],
  ["adminGetActivities", adminGetActivities],
  ["adminGetResponses", adminGetResponses],
  ["adminGetCertificateQueue", adminGetCertificateQueue],
  ["adminGetFeedbackAnalytics", adminGetFeedbackAnalytics],
  ["adminGetDashboard", adminGetDashboard],
  ["adminSaveActivity", adminSaveActivity],
  ["adminSetActivityStatus", adminSetActivityStatus],
  ["adminDeleteActivity", adminDeleteActivity],
  ["adminRetryCertificates", adminRetryCertificates],
  ["adminUploadSignature", adminUploadSignature],
  ["adminGetUsers", adminGetUsers],
  ["adminSaveUser", adminSaveUser],
  ["adminGetQuestions", adminGetQuestions],
  ["adminSaveQuestions", adminSaveQuestions],
  ["adminGetAuditLog", adminGetAuditLog],
]);

/** Who is acting, read BEFORE the action runs (doPost's auditActorForRequest_). */
async function actorBefore(action, body, context) {
  if (action === "adminLogin") return { email: String(body?.email ?? "").trim().toLowerCase(), role: "" };
  try {
    const session = await getAdminSession(context, body?.adminToken);
    return session ? { email: session.email, role: session.role } : { email: "", role: "" };
  } catch {
    return { email: "", role: "" };
  }
}

/** A successful sign-in names its account; everything else keeps the actor from before. */
const actorAfter = (action, data, before) =>
  action === "adminLogin" && data?.user ? { email: data.user.email, role: data.user.role } : before;

/**
 * The new backend's doPost: same request body, same {ok, data} / {ok, error}
 * reply. `context` carries the database, the clock and the secrets, so tests
 * can pin all three. Audited actions are logged whether they succeed or fail;
 * a failed audit write is reported in the function log but never fails the
 * request, as in Code.gs.
 */
export async function handleAction(body, { db, now = new Date(), secrets = {}, requestId = "", ...rest }) {
  const action = String(body?.action ?? "").trim();
  const handler = HANDLERS.get(action);
  if (!handler)
    return {
      ok: false,
      error: ACTIONS.includes(action)
        ? `${action} has not been ported to the new backend yet.`
        : `Unknown action: ${action}`,
    };
  const context = { db, now, secrets, requestId, sessions: new Map(), ...rest };
  const audited = isAudited(action);
  const actor = audited ? await actorBefore(action, body, context) : null;
  const audit = async (success, error, who) => {
    try {
      await appendAudit(db, { secret: secrets.auditSecret, now, action, body, success, error, actor: who, requestId });
    } catch (auditError) {
      console.error(`Audit write failed: ${auditError?.message || auditError}`);
    }
  };
  try {
    const data = await handler(body, context);
    if (audited) await audit(true, "", actorAfter(action, data, actor));
    return { ok: true, data };
  } catch (error) {
    const message = error?.message || String(error);
    if (audited) await audit(false, message, actor);
    return { ok: false, error: message };
  }
}
