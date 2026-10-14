/*
 * Phase 0 of the Supabase migration: time what each request costs today.
 *
 * Read-only. Nothing is written, and none of these actions is recorded in the
 * audit log. Run it in the browser on the live portal:
 *
 *   1. Open the portal's /admin page and sign in (the admin rows use your own
 *      session; signed out, only the public rows run).
 *   2. Open DevTools (F12) and go to Console.
 *   3. Paste this whole file and press Enter.
 *
 * It takes a minute or two and prints a table. The same numbers are copied to
 * the clipboard as JSON, ready to paste into the migration plan.
 *
 * The first two rows split the cost of a request. "netlifyOnly" never reaches
 * Apps Script. "appsScriptStartup" reaches it but does no sheet work. What a
 * row takes beyond appsScriptStartup is the sheet work itself, which is the
 * part Postgres replaces.
 *
 * "verifyCertificate" checks a made-up code. That always searches the sheet,
 * because only issued certificates are cached. To time the cache, put the
 * verification code of a real issued certificate in VERIFY_CODE below; it adds
 * a "verifyIssuedCertificate" row.
 *
 * Phase 4 (the rehearsal) runs the same file on the staging site, which
 * answers from the new backend; there "appsScriptStartup" is the new backend
 * answering an unknown action. The last line says whether every request met
 * the migration's target: a median under half a second.
 */
(async () => {
  const VERIFY_CODE = ""; // e.g. "CHED-0123456789ABCDEF0123"
  const PROXY = "/.netlify/functions/gas-proxy";
  const RUNS = 5;
  let token = "";
  try {
    token =
      JSON.parse(sessionStorage.getItem("participant_feedback_admin_session") || "{}")
        .token || "";
  } catch {}

  const post = (body) =>
    fetch(PROXY, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
    });
  const admin = (action, extra = {}) => () =>
    post({ action, adminToken: token, ...extra });

  const probes = [
    ["netlifyOnly", () => fetch(PROXY, { method: "GET" })],
    ["appsScriptStartup", () => post({ action: "phase0NoSuchAction" })],
    ["getActivityData", () => post({ action: "getActivityData" })],
    ["getQuestions", () => post({ action: "getQuestions" })],
    // A well-formed code that matches nothing still runs the full lookup.
    ["verifyCertificate", () =>
      post({ action: "verifyCertificate", code: "CHED-00000000000000000000" })],
  ];
  if (VERIFY_CODE.trim())
    probes.push(["verifyIssuedCertificate", () =>
      post({ action: "verifyCertificate", code: VERIFY_CODE.trim() })]);
  if (token)
    probes.push(
      ["adminValidateSession", admin("adminValidateSession")],
      ["adminGetDashboard", admin("adminGetDashboard", { filters: { activityId: "" } })],
      ["adminGetResponses", admin("adminGetResponses", { filters: {} })],
      ["adminGetCertificateQueue", admin("adminGetCertificateQueue", { filters: { state: "FAILED" } })],
      ["adminGetFeedbackAnalytics", admin("adminGetFeedbackAnalytics", { activityId: "" })],
      ["adminGetAuditLog", admin("adminGetAuditLog", { filters: { limit: 50 } })],
    );

  const results = [];
  for (const [request, run] of probes) {
    const times = [];
    let note = "";
    for (let i = 0; i < RUNS; i++) {
      const started = performance.now();
      try {
        const response = await run();
        const text = await response.text();
        // The two calibration rows fail on purpose; every other row should succeed.
        if (request !== "netlifyOnly" && request !== "appsScriptStartup") {
          const data = JSON.parse(text);
          if (data.ok === false) note = String(data.error || "failed").slice(0, 80);
          else if (request === "verifyIssuedCertificate" && !data.data?.valid)
            note = "VERIFY_CODE did not verify: use an issued certificate's code";
        }
      } catch (error) {
        note = String(error?.message || error).slice(0, 80);
      }
      times.push(Math.round(performance.now() - started));
    }
    const sorted = [...times].sort((a, b) => a - b);
    results.push({
      request,
      firstMs: times[0],
      medianMs: sorted[Math.floor(sorted.length / 2)],
      maxMs: sorted.at(-1),
      note,
    });
    console.log(`${request}: ${times.join(", ")} ms`);
  }

  console.table(results);
  const TARGET_MS = 500;
  const slow = results.filter((r) => !["netlifyOnly", "appsScriptStartup"].includes(r.request) && r.medianMs >= TARGET_MS);
  const target = slow.length
    ? `Not met: ${slow.map((r) => `${r.request} ${r.medianMs} ms`).join(", ")}`
    : `Met: every request's median is under ${TARGET_MS} ms`;
  console.log(`Target (median under ${TARGET_MS} ms for every request): ${target}`);
  const report = {
    measuredAt: new Date().toISOString(),
    page: location.origin,
    runsPerRequest: RUNS,
    signedIn: Boolean(token),
    results,
    target,
  };
  try {
    copy(JSON.stringify(report, null, 2));
    console.log("Copied the results to the clipboard.");
  } catch {
    console.log(JSON.stringify(report, null, 2));
  }
})();
