import { constantTimeEquals } from "../backend/crypto.mjs";
import { database } from "../backend/db.mjs";
import { handleWorkerRequest } from "../backend/worker.mjs";

/**
 * The certificate worker's endpoint: /.netlify/functions/worker.
 *
 * Called only by Apps Script, with `Authorization: Bearer <WORKER_TOKEN>`.
 * It is separate from gas-proxy on purpose: the proxy serves browsers, and a
 * browser must never be able to claim or complete certificate jobs.
 */

const json = (statusCode, payload) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  },
  body: JSON.stringify(payload),
});

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed." });
  const expected = String(process.env.WORKER_TOKEN || "").trim();
  if (expected.length < 64)
    return json(500, { ok: false, error: "WORKER_TOKEN is not set in the site's environment variables. Copy it from Apps Script's setupWorkerToken()." });
  const presented = String(event.headers?.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!constantTimeEquals(presented, expected)) return json(401, { ok: false, error: "Forbidden: invalid worker token." });

  let body;
  try {
    body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "Invalid JSON request." });
  }
  let db;
  try {
    db = database();
  } catch (error) {
    return json(500, { ok: false, error: error.message });
  }
  return json(200, await handleWorkerRequest(body, {
    db,
    now: new Date(),
    portalBaseUrl: String(process.env.PORTAL_BASE_URL || process.env.URL || "").trim(),
    setup: setupReport(),
  }));
};

/** For workerPing: how this site is configured. Whether each setting is present, never its value. */
const SETTINGS = ["PORTAL_BASE_URL", "PASSWORD_PEPPER", "AUDIT_HASH_SECRET", "GAS_WEB_APP_URL", "SUBMIT_SHARED_TOKEN", "TURNSTILE_SECRET_KEY"];
const setting = (name) => String(process.env[name] || "").trim();
const setupReport = () => ({
  backend: setting("BACKEND").toLowerCase() === "supabase" ? "supabase" : "apps-script",
  maintenance: ["on", "true", "1", "yes"].includes(setting("MAINTENANCE_MODE").toLowerCase()),
  settings: Object.fromEntries(SETTINGS.map((name) => [name, Boolean(setting(name))])),
});
