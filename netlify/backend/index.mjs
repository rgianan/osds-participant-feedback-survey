import { handleAction } from "./actions.mjs";
import { database } from "./db.mjs";

/**
 * Entry point for gas-proxy when BACKEND=supabase. Configuration errors (no
 * database URL) come back as an ordinary {ok:false} reply, worded for the
 * person fixing it, rather than as the proxy's "Unable to reach Apps Script".
 */
export async function handleSupabaseRequest(payload, context = {}) {
  let db;
  try {
    db = database();
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return handleAction(payload, {
    db,
    // Both move from Apps Script's Script Properties to Netlify's environment:
    // the pepper verifies existing passwords, the audit secret continues the chain.
    secrets: {
      passwordPepper: String(process.env.PASSWORD_PEPPER || "").trim(),
      auditSecret: String(process.env.AUDIT_HASH_SECRET || "").trim(),
    },
    // Where Apps Script still does the work: saving signature images to Drive.
    appsScript: {
      gasUrl: String(process.env.GAS_WEB_APP_URL || "").trim(),
      proxyToken: String(process.env.SUBMIT_SHARED_TOKEN || "").trim(),
      workerToken: String(process.env.WORKER_TOKEN || "").trim(),
    },
    ...context,
  });
}
