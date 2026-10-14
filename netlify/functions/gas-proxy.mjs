import { createHash } from "node:crypto";

/**
 * Maintenance mode for the Supabase cutover and a rollback: with
 * MAINTENANCE_MODE=on, only reads go through, so nothing changes in Sheets
 * between the final export and the switch. Certificate verification keeps
 * working. Everything else, submissions and sign-ins included, gets the
 * message below; the survey keeps the participant's answers on the page.
 * (Worded so the browser does not retry it automatically: see api.js.)
 */
const READ_ONLY_ACTIONS = new Set([
  "getActivityData", "getQuestions", "verifyCertificate", "adminValidateSession", "adminGetActivities",
  "adminGetResponses", "adminGetCertificateQueue", "adminGetFeedbackAnalytics", "adminGetDashboard",
  "adminGetUsers", "adminGetQuestions", "adminGetAuditLog",
]);
export const MAINTENANCE_MESSAGE =
  "The portal is being upgraded and will be back shortly. Please try again in a few minutes.";
const inMaintenance = () =>
  ["on", "true", "1", "yes"].includes(String(process.env.MAINTENANCE_MODE || "").trim().toLowerCase());

const json = (statusCode, payload) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  },
  body: JSON.stringify(payload),
});

export const handler = async (event, context = {}) => {
  if (event.httpMethod !== "POST")
    return json(405, { ok: false, error: "Method not allowed." });

  const gasUrl = String(
    process.env.GAS_WEB_APP_URL || process.env.VITE_GAS_WEB_APP_URL || "",
  ).trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(gasUrl))
    return json(500, {
      ok: false,
      error:
        "The Apps Script backend is not configured. Set GAS_WEB_APP_URL in Netlify to the deployed /exec URL.",
    });
  const sharedToken = String(process.env.SUBMIT_SHARED_TOKEN || "").trim();
  if (sharedToken.length < 64)
    return json(500, {
      ok: false,
      error:
        "The submit security token is not configured. Set SUBMIT_SHARED_TOKEN in Netlify.",
    });

  const body = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";
  if (!body || body.length > 6_000_000)
    return json(400, { ok: false, error: "Invalid request body." });

  try {
    const payload = JSON.parse(body);
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return json(400, { ok: false, error: "Invalid JSON request." });
    if (inMaintenance() && !READ_ONLY_ACTIONS.has(payload.action))
      return json(503, { ok: false, error: MAINTENANCE_MESSAGE, maintenance: true });
    const portalBaseUrl = String(
      process.env.PORTAL_BASE_URL || process.env.URL || "",
    ).trim();
    const protectedActions = {
      submitFeedback: "participant_submit",
      adminLogin: "admin_login",
    };
    const expectedAction = protectedActions[payload.action];
    if (expectedAction) {
      const turnstileSecret = String(
        process.env.TURNSTILE_SECRET_KEY || "",
      ).trim();
      const turnstileToken = String(
        payload.turnstileToken || payload.payload?.turnstileToken || "",
      ).trim();
      if (!turnstileSecret)
        return json(500, {
          ok: false,
          error: "Turnstile is not configured on the server.",
        });
      if (!turnstileToken)
        return json(400, {
          ok: false,
          error: "Please complete the security verification.",
        });
      const verification = await fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            secret: turnstileSecret,
            response: turnstileToken,
            idempotency_key: (() => {
              const hash = createHash("sha256")
                .update(turnstileToken)
                .digest("hex")
                .slice(0, 32);
              return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
            })(),
            remoteip:
              event.headers?.["x-nf-client-connection-ip"] ||
              event.headers?.["x-forwarded-for"]?.split(",")[0]?.trim(),
          }),
          signal: AbortSignal.timeout(8_000),
        },
      ).then((response) => response.json());
      const expectedHostname = String(event.headers?.host || "").split(":")[0];
      if (
        !verification.success ||
        verification.action !== expectedAction ||
        (expectedHostname && verification.hostname !== expectedHostname)
      )
        return json(403, {
          ok: false,
          error: "Security verification expired or failed. Please try again.",
        });
      delete payload.turnstileToken;
      if (payload.payload) delete payload.payload.turnstileToken;
    }
    const requestId = String(
      context.awsRequestId || event.headers?.["x-nf-request-id"] || "",
    ).slice(0, 100);
    // Supabase migration: BACKEND=supabase answers from Postgres instead of
    // Apps Script, after the same Turnstile check. The module is loaded only
    // on that path, so the Apps Script path below never imports it.
    if (String(process.env.BACKEND || "").trim().toLowerCase() === "supabase") {
      const { handleSupabaseRequest } = await import("../backend/index.mjs");
      return json(
        200,
        await handleSupabaseRequest(payload, { requestId, portalBaseUrl }),
      );
    }
    payload.proxyToken = sharedToken;
    payload.portalBaseUrl = portalBaseUrl;
    payload.requestContext = { requestId };
    const upstream = await fetch(gasUrl, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    const responseText = await upstream.text();
    try {
      JSON.parse(responseText);
    } catch {
      throw new Error(
        "Apps Script did not return JSON. Confirm the web app is deployed as Execute as me and accessible to Anyone.",
      );
    }
    return {
      statusCode: upstream.ok ? 200 : 502,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
      body: responseText,
    };
  } catch (error) {
    return json(502, {
      ok: false,
      error: `Unable to reach Apps Script: ${error.message || String(error)}`,
    });
  }
};
