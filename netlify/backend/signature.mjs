import { requireAdmin } from "./admin.mjs";
import { APPS_SCRIPT_TIMEOUT, APPS_SCRIPT_WAIT_MS } from "./apps-script.mjs";

/**
 * E-signature images go to the Drive folder the certificate templates live
 * in, because the certificate step (still Apps Script) reads them from
 * there. Netlify cannot write to Drive, so this checks the administrator and
 * the file here, then hands the file to Apps Script's workerUploadSignature.
 *
 * That call carries two secrets: the proxy token every doPost requires, and
 * the worker token that action alone requires. The worker token never leaves
 * the server, so a browser cannot reach that action through the proxy.
 */

const INVALID = "Please upload a PNG, JPG, or WebP signature image no larger than 2 MB.";

export async function adminUploadSignature(body, context) {
  await requireAdmin(context, body?.adminToken);
  const file = body?.payload || {};
  // Checked here too, so a wrong file costs no trip to Apps Script.
  if (!file.base64 || !file.filename || !/^image\/(png|jpeg|webp)$/i.test(String(file.mimeType || "")) ||
      String(file.base64).length > 2800000)
    throw new Error(INVALID);

  const { gasUrl, proxyToken, workerToken } = context.appsScript || {};
  if (!gasUrl || !proxyToken || !workerToken)
    throw new Error("Signature upload is not configured: set GAS_WEB_APP_URL, SUBMIT_SHARED_TOKEN and WORKER_TOKEN in Netlify.");

  let response;
  try {
    response = await (context.fetch || fetch)(gasUrl, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "workerUploadSignature",
        proxyToken,
        workerToken,
        payload: { filename: String(file.filename), mimeType: String(file.mimeType), base64: String(file.base64) },
        requestContext: { requestId: context.requestId || "" },
      }),
      redirect: "follow",
      signal: AbortSignal.timeout(APPS_SCRIPT_WAIT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError") throw new Error(APPS_SCRIPT_TIMEOUT);
    throw error;
  }
  let reply;
  try {
    reply = JSON.parse(await response.text());
  } catch {
    throw new Error("Apps Script did not return JSON while saving the signature. Check its deployment.");
  }
  if (!reply.ok) throw new Error(reply.error || "Apps Script could not save the signature.");
  return reply.data;
}
