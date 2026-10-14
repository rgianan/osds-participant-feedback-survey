import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { backendThread as backend } from "./backend-thread.mjs";

/**
 * Phase 2 exit test, end to end: the real Code.gs certificate queue, switched
 * to CERTIFICATE_SOURCE = "api", working through the new backend's worker
 * endpoint and Postgres. Google's services (Slides, Drive, Mail) are stood in
 * by recorders, so every PDF and every email can be counted.
 *
 * "20 test certificates issue, and a run killed mid-batch recovers on its own."
 */

const PORTAL = "https://portal.test";
const WORKER_URL = `${PORTAL}/.netlify/functions/worker`;
const WORKER_TOKEN = "w".repeat(96);
const TEMPLATE = "TEMPLATE00000000000000";
const SIGNATURE = "SIGNATURE0000000000000";

/** Code.gs with Google's services recorded, its queue pointed at the backend. */
function appsScript(api, { killOnReport } = {}) {
  const context = {};
  vm.createContext(context);
  const drive = { pdfs: [], trashed: [] };
  const mail = [];
  let reports = 0;
  const blob = (name = "blob") => ({ name, setName(n) { this.name = n; return this; }, getBytes: () => [] });
  const fileOf = (id) => {
    if (id === TEMPLATE) return { getMimeType: () => "application/vnd.google-apps.presentation",
      makeCopy: (name) => ({ getId: () => `slides-${randomUUID()}`, name }) };
    if (id === SIGNATURE) return { getMimeType: () => "image/png", getBlob: () => blob("signature.png") };
    return { setTrashed: () => drive.trashed.push(id) };
  };
  const folder = {
    getName: () => "Certificates",
    getFilesByName: (name) => {
      const found = drive.pdfs.filter((f) => f.name === name);
      return { hasNext: () => found.length > 0, next: () => found.shift() };
    },
    createFile: (pdf) => {
      const id = `pdf-${drive.pdfs.length + 1}`;
      const file = { id, name: pdf.name, getUrl: () => `https://drive.google.com/file/d/${id}/view`, setSharing() {} };
      drive.pdfs.push(file);
      return file;
    },
  };
  const properties = new Map([["CERTIFICATE_SOURCE", "api"], ["WORKER_API_URL", WORKER_URL], ["WORKER_TOKEN", WORKER_TOKEN]]);
  Object.assign(context, {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => properties.get(k) ?? null, setProperty: (k, v) => properties.set(k, v) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => "Asia/Manila", getActiveUser: () => ({ getEmail: () => "owner@x.com" }), getEffectiveUser: () => ({ getEmail: () => "owner@x.com" }) },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 16).replace("T", " "), getUuid: () => randomUUID() },
    Logger: { log() {} },
    MimeType: { GOOGLE_SLIDES: "application/vnd.google-apps.presentation" },
    ScriptApp: { getOAuthToken: () => "oauth", getProjectTriggers: () => [{ getHandlerFunction: () => "processCertificateQueue" }] },
    DriveApp: { getFolderById: () => folder, getFileById: fileOf, Access: { ANYONE_WITH_LINK: "a" }, Permission: { VIEW: "v" } },
    SlidesApp: { openById: () => ({ replaceAllText: () => 0, getSlides: () => [], getPageWidth: () => 720, getPageHeight: () => 540, saveAndClose() {} }) },
    MailApp: { getRemainingDailyQuota: () => 1500, sendEmail: (message) => mail.push(message) },
    UrlFetchApp: {
      fetch: (url, options = {}) => {
        if (url === WORKER_URL) {
          assert.equal(options.headers?.Authorization, `Bearer ${WORKER_TOKEN}`);
          const body = JSON.parse(options.payload);
          if (body.action === "workerCompleteCertificateJob" && ++reports === killOnReport)
            throw new Error("Exceeded maximum execution time"); // the run dies before this report lands
          const reply = api.worker(body);
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify(reply) };
        }
        // The QR image and the Drive PDF export.
        return { getResponseCode: () => 200, getBlob: () => blob(url.includes("quickchart") ? "qr.png" : "export.pdf"), getContentText: () => "" };
      },
    },
  });
  vm.runInContext(readFileSync(new URL("../../google-apps-script/Code.gs", import.meta.url), "utf8"), context);
  return { gas: context, drive, mail };
}

test("phase 2 exit test: 20 certificates issue through the worker, and a run killed mid-batch recovers on its own", () => {
  const api = backend();
  try {
    api.sql(`insert into portal.activities (code, title, venue, from_date, to_date, template_url, signatory_name,
               signatory_designation, signature_url, given_date)
             values ('A-FORUM', 'Leadership Forum', 'CHED Auditorium', '2026-08-24', '2026-08-25',
                     'https://drive.google.com/file/d/${TEMPLATE}/view', 'Maria Santos', 'Director',
                     'https://drive.google.com/file/d/${SIGNATURE}/view', '2026-08-26')`);
    for (let i = 1; i <= 20; i++)
      api.sql(
        `insert into portal.responses (activity_id, activity_code, activity_title, name, email, sex, age, verification_code)
         select id, code, title, $1, $2, 'Female', 30, $3 from portal.activities`,
        [`Participant ${i}`, `p${i}@example.com`, `CHED-${createHash("sha256").update(String(i)).digest("hex").slice(0, 20).toUpperCase()}`]);

    // Run 1 dies while reporting its 4th certificate: 3 recorded, 1 made but
    // unrecorded, 6 claimed and untouched.
    const first = appsScript(api, { killOnReport: 4 });
    assert.throws(() => first.gas.processCertificateQueue(), /Exceeded maximum execution time/);
    const count = (status) => api.sql(`select count(*)::int as n from portal.responses where certificate_status = $1`, [status])[0].n;
    assert.deepEqual([count("issued"), count("processing"), count("pending")], [3, 7, 10]);

    // Run 2, a minute later, takes the next 10. The dead run's 7 wait for their claims to run out.
    const second = appsScript(api);
    second.drive.pdfs.push(...first.drive.pdfs); // the same Drive folder
    assert.deepEqual(json(second.gas.processCertificateQueue()), { status: "OK", source: "api", claimed: 10, processed: 10, failed: 0, released: 0 });
    assert.equal(count("processing"), 7);

    // 16 minutes on, the claims have run out and run 3 recovers the 7.
    api.sql(`update portal.responses set claimed_at = claimed_at - interval '16 minutes' where certificate_status = 'processing'`);
    second.mail.length = 0;
    const third = second;
    assert.deepEqual(json(third.gas.processCertificateQueue()), { status: "OK", source: "api", claimed: 7, processed: 7, failed: 0, released: 0 });
    assert.equal(count("issued"), 20);

    // Every participant has a certificate, its own link, and an email date.
    const rows = api.sql(`select email, verification_code, certificate_url, emailed_at is not null as emailed, attempts
                            from portal.responses order by id`);
    assert.ok(rows.every((r) => r.emailed && r.certificate_url.startsWith("https://drive.google.com/file/d/pdf-")));
    assert.equal(new Set(rows.map((r) => r.certificate_url)).size, 20, "20 different PDFs");
    assert.equal(third.drive.pdfs.length, 20, "the one made by the dead run was reused, not made again");
    // The 4th participant's PDF was made by run 1; run 3 found it by its verification code.
    const fourth = rows[3];
    assert.equal(fourth.certificate_url, first.drive.pdfs[3].getUrl());
    assert.ok(first.drive.pdfs[3].name.endsWith(` - ${fourth.verification_code}.pdf`));

    // Emails: 4 in run 1 (the 4th never reported), 10 in run 2, 7 in run 3.
    // The 4th participant is emailed twice: the duplicate the plan accepts.
    assert.equal(first.mail.length, 4);
    assert.equal(third.mail.length, 7);
    const recovered = third.mail.find((m) => m.to === fourth.email);
    assert.ok(recovered.htmlBody.includes(fourth.certificate_url), "the second email carries the same certificate");
    assert.ok(recovered.htmlBody.includes(`${PORTAL}/verification?code=${fourth.verification_code}`));
    assert.equal(rows.find((r) => r.email === fourth.email).attempts, 2);
  } finally {
    api.stop();
  }
});

test("a certificate that cannot be made is reported failed with its reason; the run carries on", () => {
  const api = backend();
  try {
    api.sql(`insert into portal.activities (code, title, venue, from_date, template_url) values
             ('A-OK', 'Good', 'Hall', '2026-08-24', 'https://drive.google.com/file/d/${TEMPLATE}/view'),
             ('A-NOTPL', 'No template', 'Hall', '2026-08-24', '')`);
    api.sql(`insert into portal.responses (activity_id, activity_code, activity_title, name, email, sex, age, verification_code)
             select id, code, title, 'Ana', code || '@example.com', 'Female', 30,
                    'CHED-' || upper(substr(md5(code), 1, 20)) from portal.activities`);
    const apps = appsScript(api);
    assert.deepEqual(json(apps.gas.processCertificateQueue()), { status: "OK", source: "api", claimed: 2, processed: 1, failed: 1, released: 0 });
    assert.deepEqual(api.sql(`select activity_code, certificate_status::text as s, certificate_error as e from portal.responses order by activity_code`), [
      { activity_code: "A-NOTPL", s: "failed", e: "Missing certificate template for selected activity." },
      { activity_code: "A-OK", s: "issued", e: null },
    ]);
  } finally {
    api.stop();
  }
});

test("the editor check reports a working connection, and the Sheets queue stays the default", () => {
  const api = backend();
  try {
    const apps = appsScript(api);
    const check = apps.gas.checkWorkerApi();
    assert.equal(check.verdict, "Connected. Certificates are coming from the new backend.");
    assert.equal(check.workerApiUrl, WORKER_URL);

    apps.gas.PropertiesService.getScriptProperties().setProperty("CERTIFICATE_SOURCE", "");
    assert.equal(apps.gas.certificateSource_(), "sheets", "nothing changes until the property is set");
    assert.match(apps.gas.checkWorkerApi().verdict, /Set Script Property CERTIFICATE_SOURCE to "api"/);
  } finally {
    api.stop();
  }
});

function json(value) {
  return JSON.parse(JSON.stringify(value));
}
