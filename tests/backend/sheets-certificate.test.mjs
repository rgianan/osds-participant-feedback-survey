import { test } from "node:test";
import assert from "node:assert/strict";
import { appsScript } from "./contract-harness.mjs";

/**
 * Production's own queue, after phase 2's refactor: with CERTIFICATE_SOURCE
 * unset, Code.gs still reads the Responses sheet, and now builds each
 * certificate through issueCertificate_ (shared with the API queue). This runs
 * that whole path on the stand-in spreadsheet.
 */

test("the Sheets queue, still the default, issues and emails a certificate through the shared builder", () => {
  const apps = appsScript();
  const { gas, sheets, properties } = apps;
  properties.set("PORTAL_BASE_URL", "https://portal.test");
  const mail = [];
  const pdfs = [];
  const slidesEdits = [];
  // Leadership Forum gets a template and signatory; Bo's failed response goes back in the queue.
  const activity = sheets.Activity.rows;
  const col = (rows, name) => rows[0].indexOf(name);
  activity[1][col(activity, "Certificate Template")] = "https://drive.google.com/file/d/TEMPLATE00000000000000/view";
  activity[1][col(activity, "Focal-in-Charge")] = "Maria Santos";
  activity[1][col(activity, "Signatory Designation")] = "Director";
  const responses = sheets.Responses.rows;
  const bo = responses.findIndex((row) => row[1] === "Bo");
  responses[bo][col(responses, "cStatus")] = "PENDING";

  const template = { getMimeType: () => "application/vnd.google-apps.presentation", makeCopy: () => ({ getId: () => "slides-1" }) };
  const certFolder = {
    getName: () => "Certificates",
    createFile: (blob) => {
      pdfs.push(blob.name);
      return { getUrl: () => "https://drive.google.com/file/d/pdf-1/view", setSharing() {} };
    },
  };
  Object.assign(gas, {
    MimeType: { GOOGLE_SLIDES: "application/vnd.google-apps.presentation" },
    ScriptApp: { getOAuthToken: () => "oauth" },
    DriveApp: { getFolderById: () => certFolder, getFileById: (id) => (id === "TEMPLATE00000000000000" ? template : { setTrashed() {} }),
      Access: { ANYONE_WITH_LINK: "a" }, Permission: { VIEW: "v" } },
    SlidesApp: { openById: () => ({ replaceAllText: (token, value) => { slidesEdits.push([token, value]); return 0; },
      getSlides: () => [], getPageWidth: () => 720, getPageHeight: () => 540, saveAndClose() {} }) },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getBlob: () => ({ setName(n) { this.name = n; return this; } }) }) },
    MailApp: { getRemainingDailyQuota: () => 100, sendEmail: (message) => mail.push(message) },
  });

  assert.equal(gas.certificateSource_(), "sheets");
  const run = JSON.parse(JSON.stringify(gas.processCertificateQueue()));
  assert.deepEqual(run, { status: "OK", processed: 1, failed: 0, held: 1, queued: 0 }, "Cy's response is held: its activity is ended");

  const row = responses[bo];
  assert.equal(row[col(responses, "cStatus")], "OK");
  assert.equal(row[col(responses, "Certificate Link")], "https://drive.google.com/file/d/pdf-1/view");
  assert.match(String(row[col(responses, "Email Sent")]), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const code = row[col(responses, "Verification Code")];
  assert.equal(row[col(responses, "Verification URL")], `https://portal.test/verification?code=${encodeURIComponent(code)}`);

  assert.deepEqual(pdfs, ["Certificate - Bo - Leadership Forum.pdf"], "the Sheets queue keeps its file names");
  const filled = Object.fromEntries(slidesEdits);
  assert.equal(filled["{{Name}}"], "Bo");
  assert.equal(filled["{{Title}}"], "Leadership Forum");
  assert.equal(filled["{{Signatory}}"], "Maria Santos");
  assert.equal(filled["{{DateRange}}"], "on August 24, 2026");
  assert.equal(filled["{{VerificationCode}}"], code);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, "Bo@Example.com");
  assert.equal(mail[0].subject, "Your certificate for Leadership Forum");
  assert.ok(mail[0].htmlBody.includes("https://drive.google.com/file/d/pdf-1/view"));
});
