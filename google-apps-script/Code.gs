/** Code.gs — Survey + Admin server (dedupe, validations, admin endpoints)
 * Deploy: Web app → Execute as "Me", Who has access "Anyone" (or your domain)
 */

// --------------------------- Switches / Folder IDs ---------------------------
var ENFORCE_WHITELIST = true; // gate /?admin behind Whitelist

// Folder for certificate templates (Google Slides preferred; PPT/PPTX will be converted)
var TEMPLATE_FOLDER_ID = '1wATGGRc5X0f8LgRBQULer7Bb-r7jwvO_';
// Folder where generated certificate PDFs will be stored
var CERTIFICATES_FOLDER_ID = '1LPvBeWVlo8AhJbDJxh75gq3Kz5KQpMMw';

// Queue tuning. Ten certificates per run keeps normal executions comfortably
// below Apps Script's six-minute limit. Pending rows remain in the sheet and
// are picked up by the next one-minute trigger.
var CERTIFICATE_BATCH_SIZE = 10;
var CERTIFICATE_RUN_BUDGET_MS = 270000;

// --------------------------- Web app entry ---------------------------
function doGet(e) {
  var p = (e && e.parameter) || {};
  var requested = (p.page ? String(p.page).toLowerCase() : (p.admin ? 'admin' : 'index'));

  var file = (requested === 'submit') ? 'submit'
           : (requested === 'admin')  ? 'admin'
           : 'index';

  // STRICT GATE: never send admin.html unless whitelisted
  if (file === 'admin') {
    var email = getViewerEmail_();            // blank for “Anyone with Google account” deployments
    var allowed = !!email && isWhitelisted_(email);
    if (!allowed) {
      var html = HtmlService.createHtmlOutput(
        '<!doctype html><meta charset="utf-8">' +
        '<style>body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;background:#f7f9fb;margin:0;padding:40px;color:#24323f}' +
        '.card{max-width:720px;margin:40px auto;background:#fff;border:1px solid #edf0f2;border-radius:14px;box-shadow:0 6px 14px rgba(10,30,60,.06);padding:22px}' +
        'h1{margin:0 0 8px;font-size:1.35rem;color:#1b5e20} .muted{color:#6b7c93} a.btn{display:inline-block;margin-top:14px;padding:12px 16px;border-radius:12px;' +
        'background:#eaf7ec;color:#1b5e20;text-decoration:none;border:1px solid #cfe0d0;font-weight:700}</style>' +
        '<div class="card"><h1>Forbidden</h1>' +
        '<p class="muted">You are not authorized to view this page.</p>' +
        '<div id="backWrap"><a class="btn" href="#" id="backBtn">← Back to survey</a></div>' +
        '<script>google.script.run.withSuccessHandler(function(base){' +
        'var a=document.getElementById("backBtn"); if(a) a.href=base;}).getWebAppUrl();<\/script></div>'
      );
      return html.setTitle('Forbidden').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
    }
  }

  return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial,sans-serif;background:#f5f7f2;color:#18322d;display:grid;place-items:center;min-height:90vh}.card{text-align:center;background:white;border:1px solid #dfe7e1;border-radius:18px;padding:32px;max-width:480px}img{width:110px}p{color:#6d7f79}</style><div class="card"><img src="https://ik.imagekit.io/k2qmtccm6/CHED_Logo_New.png" alt="CHED"><h1>Participant Feedback API</h1><p>The certificate service is online. Use the Netlify portal to access the application.</p></div>')
    .setTitle('CHED Participant Feedback API')
    .setFaviconUrl('https://ik.imagekit.io/k2qmtccm6/CHED-cropped-logo100x100.png');
}

/** JSON endpoint used by the Netlify frontend. */
function doPost(e) {
  var body = null, action = '', auditActor = null, requestContext = {};
  try {
    var raw = (e && e.postData && e.postData.contents) || '{}';
    if (raw.length > 6000000) throw new Error('Request payload is too large.');
    body = JSON.parse(raw);
    assertSubmitSharedToken_(body.proxyToken);
    delete body.proxyToken;
    rememberPortalBaseUrl_(body.portalBaseUrl);
    delete body.portalBaseUrl;
    requestContext = body.requestContext || {};
    delete body.requestContext;
    action = safeTrim_(body.action);
    auditActor = auditActorForRequest_(action, body);
    var data;

    if (action === 'getActivityData') data = getActivityData();
    else if (action === 'getQuestions') data = getQuestions();
    else if (action === 'submitFeedback') data = submitFeedback(body.payload || body);
    else if (action === 'adminLogin') data = adminLogin(body.email, body.password);
    else if (action === 'adminValidateSession') data = adminValidateSession(body.adminToken);
    else if (action === 'adminLogout') data = adminLogout(body.adminToken);
    else if (action === 'adminGetActivities') data = adminGetActivities(body.adminToken);
    else if (action === 'adminSaveActivity') data = adminSaveActivity(body.payload || {}, body.adminToken);
    else if (action === 'adminSetActivityStatus') data = adminSetActivityStatus(body.payload || {}, body.adminToken);
    else if (action === 'adminDeleteActivity') data = adminDeleteActivity(body.id || (body.payload && body.payload.id), body.adminToken);
    else if (action === 'adminUploadSignature') data = adminUploadSignature(body.payload || {}, body.adminToken);
    else if (action === 'adminGetFeedbackAnalytics') data = adminGetFeedbackAnalytics(body.activityId, body.adminToken);
    else if (action === 'adminGetUsers') data = adminGetUsers(body.adminToken);
    else if (action === 'adminSaveUser') data = adminSaveUser(body.payload || {}, body.adminToken);
    else if (action === 'adminGetQuestions') data = adminGetQuestions(body.adminToken);
    else if (action === 'adminSaveQuestions') data = adminSaveQuestions(body.questions || (body.payload && body.payload.questions) || [], body.adminToken);
    else if (action === 'adminGetAuditLog') data = adminGetAuditLog(body.filters || {}, body.adminToken);
    else if (action === 'verifyCertificate') data = verifyCertificate(body.code);
    else throw new Error('Unknown action: ' + action);

    if (isAuditedAction_(action)) { try { appendAuditForRequest_(action, body, true, '', auditActorForResult_(action, data, auditActor), requestContext); } catch (auditError) { console.error('Audit write failed: '+String(auditError&&auditError.message||auditError)); } }

    return jsonResponse_({ ok: true, data: data });
  } catch (error) {
    try { if (body && isAuditedAction_(action)) appendAuditForRequest_(action, body, false, error && error.message ? error.message : String(error), auditActor, requestContext); } catch (_) {}
    return jsonResponse_({ ok: false, error: error && error.message ? error.message : String(error) });
  }
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

// --------------------------- HTML include helper ---------------------------
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
function getWebAppUrl() {
  return ScriptApp.getService().getUrl();
}

// ------------------------------ Utilities ---------------------------
function safeTrim_(v){ return String(v == null ? '' : v).trim(); }
function safeSheetValue_(v){return typeof v==='string'&&/^[=+\-@]/.test(v)?("'"+v):v;}
function escapeHtml_(v){return safeTrim_(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function getViewerEmail_(){ return safeTrim_(Session.getActiveUser().getEmail() || ''); }

function getHeaderMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function(h){ return String(h || '').trim(); });
  var map = {};
  headers.forEach(function(h, i){
    if (!h) return;
    map[h.toLowerCase()] = i; // 0-based
  });
  return map;
}
function idxOf_(hdrMap, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var k = String(candidates[i]).toLowerCase();
    if (k in hdrMap) return hdrMap[k];
  }
  return -1;
}
function fmtDate_(v){
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Asia/Manila', 'yyyy-MM-dd');
  }
  return safeTrim_(v);
}
var MONTH_NAMES_ = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/** 'yyyy-MM-dd' → {y,m,d}, or null when the value is not a date key. */
function parseDateKey_(key) {
  var match = safeTrim_(key).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** '2026-08-04' → 'August 4, 2026'. Unparseable values pass through unchanged. */
function fmtLongDate_(key) {
  var parts = parseDateKey_(key);
  if (!parts || parts.m < 1 || parts.m > 12) return safeTrim_(key);
  return MONTH_NAMES_[parts.m - 1] + ' ' + parts.d + ', ' + parts.y;
}

/**
 * Reads as a sentence fragment, so a one-day activity does not print
 * "on August 24, 2026 to August 24, 2026".
 *
 *   same day          → "on August 24, 2026"
 *   same month        → "from August 24 to 26, 2026"
 *   same year         → "from August 30 to September 2, 2026"
 *   spanning years    → "from December 30, 2026 to January 2, 2027"
 */
function activityDateRangeText_(fromKey, toKey) {
  var from = parseDateKey_(fromKey), to = parseDateKey_(toKey);
  if (!from && !to) return '';
  if (!from) { from = to; fromKey = toKey; to = null; }
  if (!to || (from.y === to.y && from.m === to.m && from.d === to.d))
    return 'on ' + fmtLongDate_(fromKey);
  if (from.y === to.y && from.m === to.m)
    return 'from ' + MONTH_NAMES_[from.m - 1] + ' ' + from.d + ' to ' + to.d + ', ' + from.y;
  if (from.y === to.y)
    return 'from ' + MONTH_NAMES_[from.m - 1] + ' ' + from.d + ' to ' + MONTH_NAMES_[to.m - 1] + ' ' + to.d + ', ' + from.y;
  return 'from ' + fmtLongDate_(fromKey) + ' to ' + fmtLongDate_(toKey);
}

function extractDriveFileId_(input) {
  var s = safeTrim_(input);
  if (!s) return '';
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s; // already an ID
  var m =
    s.match(/\/d\/([a-zA-Z0-9_-]{20,})\//) ||
    s.match(/[?&]id=([a-zA-Z0-9_-]{20,})/) ||
    s.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/) ||
    s.match(/^https:\/\/drive\.google\.com\/uc\?export=download&id=([a-zA-Z0-9_-]{20,})/);
  return m ? m[1] : '';
}
function assertFolder_(folderId, label){
  folderId = safeTrim_(folderId);
  if (!folderId) throw new Error(label + " is blank.");
  try {
    var f = DriveApp.getFolderById(folderId);
    f.getName(); // assert access
    return f;
  } catch (e) {
    throw new Error(label + " is invalid or inaccessible (id=" + folderId + ").");
  }
}
function parseAndAssertFile_(input, label){
  var id = extractDriveFileId_(input);
  if (!id) throw new Error(label + " is not a Drive link or file id: " + input);
  try {
    var file = DriveApp.getFileById(id);
    var mime = file.getMimeType();
    return {id:id, file:file, mime:mime};
  } catch (e) {
    throw new Error(label + " is invalid or inaccessible (id=" + id + ").");
  }
}
function makeActivityId_(){
  // Short stable-ish ID: A-xxxxxxxx (8 chars of UUID)
  return 'A-' + Utilities.getUuid().replace(/-/g,'').slice(0,8);
}

/**
 * Run once and copy the returned submitSharedToken into Netlify as
 * SUBMIT_SHARED_TOKEN. Apps Script stores only its SHA-256 hash. The separate
 * session secret never leaves Script Properties and keys all session hashes.
 * Running this again rotates both secrets and signs out every administrator.
 */
function setupParticipantFeedbackSecurity() {
  var sharedToken = randomSecret_(), sessionSecret = randomSecret_(), properties = PropertiesService.getScriptProperties();
  var existing = properties.getProperties();
  Object.keys(existing).forEach(function(key){if(key.indexOf('ADMIN_SESSION_')===0)properties.deleteProperty(key);});
  properties.setProperties({
    SUBMIT_SHARED_TOKEN_HASH: sha256Base64_(sharedToken),
    SESSION_HASH_SECRET: sessionSecret,
    AUDIT_HASH_SECRET: existing.AUDIT_HASH_SECRET || randomSecret_(),
    SECURITY_SECRETS_UPDATED_AT: new Date().toISOString()
  }, false);
  return {
    status: 'OK',
    submitSharedToken: sharedToken,
    netlifyVariable: 'SUBMIT_SHARED_TOKEN',
    warning: 'Copy this token to Netlify now. It is not stored in plain text by Apps Script. Existing admin sessions have been invalidated.'
  };
}

/**
 * DESTRUCTIVE. Generates a NEW submit token and logs it, because Apps Script
 * does not display return values. Every existing copy of the token stops
 * working immediately, so after running this you must update BOTH .env and
 * Netlify's SUBMIT_SHARED_TOKEN, and every administrator is signed out.
 *
 * To check a token you already have without rotating, use
 * verifySubmitSharedToken('<token>') instead.
 *
 * The previous name (logSubmitSharedToken) read like a query and invited
 * exactly this mistake.
 */
function rotateSubmitSharedTokenAndLog() {
  Logger.log(JSON.stringify(setupParticipantFeedbackSecurity(), null, 2));
}

/**
 * Read-only Drive check. Run from the editor to (a) trigger the Drive consent
 * prompt if the project has never been authorized for it, and (b) confirm the
 * two hardcoded folder IDs are reachable.
 *
 * "Access denied: DriveApp" means the script is not authorized for Drive —
 * usually the editor's appsscript.json is missing the drive scope, or the grant
 * predates it. A wrong or inaccessible folder ID reports a different message
 * naming the folder instead.
 */
function checkDriveAccess() {
  var result = { templateFolder: '', certificatesFolder: '', ok: false };
  try {
    result.templateFolder = DriveApp.getFolderById(TEMPLATE_FOLDER_ID).getName();
    result.certificatesFolder = DriveApp.getFolderById(CERTIFICATES_FOLDER_ID).getName();
    result.ok = true;
    result.verdict = 'Drive is authorized and both folders are reachable.';
  } catch (error) {
    result.error = String(error && error.message || error);
    result.verdict = /access denied|authorization|permission/i.test(result.error)
      ? 'Not authorized for Drive. Enable the manifest in Project Settings, make sure appsscript.json lists https://www.googleapis.com/auth/drive, accept the consent prompt, then create a NEW deployment.'
      : 'Drive is authorized but a folder ID is wrong or not shared with this account. Check TEMPLATE_FOLDER_ID and CERTIFICATES_FOLDER_ID at the top of this file.';
  }
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Paste a token here and run verifyPastedToken() from the editor. The Run
 * button cannot pass arguments to a function, which is why this constant
 * exists — running verifySubmitSharedToken() directly checks an empty string.
 */
var TOKEN_TO_VERIFY = '';

function verifyPastedToken() {
  return verifySubmitSharedToken(TOKEN_TO_VERIFY);
}

/**
 * Read-only. Answers "is this token still valid?" without changing anything.
 * Paste the value from .env or Netlify.
 */
function verifySubmitSharedToken(token) {
  var expected = PropertiesService.getScriptProperties().getProperty('SUBMIT_SHARED_TOKEN_HASH');
  var result = {
    configured: !!expected,
    // A one-way digest, safe to read out. Comparing it against the hash of a
    // token you hold proves whether the editor and the deployed /exec URL are
    // the same Apps Script project.
    storedHash: expected || '',
    hashOfGivenToken: safeTrim_(token) ? sha256Base64_(safeTrim_(token)) : '',
    tokenLength: safeTrim_(token).length,
    matches: !!expected && !!safeTrim_(token) && constantTimeEquals_(sha256Base64_(safeTrim_(token)), expected),
    rotatedAt: PropertiesService.getScriptProperties().getProperty('SECURITY_SECRETS_UPDATED_AT') || 'unknown'
  };
  // A real hash is 43 chars of web-safe base64. Anything else means the
  // property was overwritten by hand with a raw token, in which case NO token
  // can ever validate and rotating is the only fix.
  var looksLikeHash = /^[A-Za-z0-9_-]{43}$/.test(safeTrim_(expected));
  result.storedValueLooksLikeHash = looksLikeHash;
  result.verdict = !result.configured
    ? 'Backend security is not configured. Run setupParticipantFeedbackSecurity() once.'
    : !looksLikeHash
      ? 'BROKEN: SUBMIT_SHARED_TOKEN_HASH does not hold a hash (expected 43 base64 chars). It was probably overwritten by hand with a plaintext token, so every request fails. Fix: run rotateSubmitSharedTokenAndLog() once, put the logged token in .env and Netlify ONLY, and never paste anything into Script Properties.'
      : result.matches
        ? 'This token is valid. Nothing was changed.'
        : 'This token does NOT match. Copy the token from the most recent rotation in Executions, or rotate again with rotateSubmitSharedTokenAndLog().';
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function assertSubmitSharedToken_(token) {
  var expected = PropertiesService.getScriptProperties().getProperty('SUBMIT_SHARED_TOKEN_HASH');
  if (!expected) throw new Error('Backend security is not configured. Run setupParticipantFeedbackSecurity().');
  if (!token || !constantTimeEquals_(sha256Base64_(String(token)), expected)) throw new Error('Forbidden: invalid submit token.');
}

function randomSecret_() { return Utilities.getUuid().replace(/-/g,'') + Utilities.getUuid().replace(/-/g,'') + Utilities.getUuid().replace(/-/g,''); }
function sha256Base64_(value) { return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(value||''),Utilities.Charset.UTF_8)).replace(/=+$/,''); }
function hmac256Base64_(value, secret) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(String(value||''),String(secret||''),Utilities.Charset.UTF_8)).replace(/=+$/,''); }
function rememberPortalBaseUrl_(url) { url=safeTrim_(url).replace(/\/$/,'');if(!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(url))return;var props=PropertiesService.getScriptProperties();if(props.getProperty('PORTAL_BASE_URL')!==url)props.setProperty('PORTAL_BASE_URL',url); }

// --------------------------- First-time sheet setup ---------------------------
/**
 * Creates the spreadsheet schema required by this portal.
 * Safe to run again: existing rows and recognized columns are preserved, and
 * only missing columns are appended. Run seedUsers() separately after replacing
 * its host email and temporary password.
 */
function setupParticipantFeedbackSheets() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Sheet setup is already running. Please try again.');
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var setupProperties=PropertiesService.getScriptProperties();
    if(!setupProperties.getProperty('AUDIT_HASH_SECRET'))setupProperties.setProperty('AUDIT_HASH_SECRET',randomSecret_());
    var activity = ensureSetupSheet_(ss, 'Activity', [
      setupColumn_('Title', ['activity title','activity']),
      setupColumn_('Venue', ['location']),
      setupColumn_('FromDate', ['from date','start']),
      setupColumn_('ToDate', ['to date','end']),
      setupColumn_('Certificate Template', ['template']),
      setupColumn_('Focal-in-Charge', ['focal in charge','in-charge','in charge']),
      setupColumn_('Timestamp', ['created at','last updated']),
      setupColumn_('Given Date', ['date given','givendate','issued','schedule']),
      setupColumn_('ActivityID', ['activity id','id']),
      setupColumn_('Region', ['ched region']),
      setupColumn_('Signatory Designation', ['designation']),
      setupColumn_('E-Signature', ['signature','signature image']),
      setupColumn_('Created By', ['createdby','owner','creator']),
      setupColumn_('Active', ['enabled','status'])
    ]);

    var responseColumns = [
      setupColumn_('Timestamp', ['submitted at']), setupColumn_('Name'),
      setupColumn_('Responder Email', ['email','e-mail']), setupColumn_('Sex'), setupColumn_('Age'),
      setupColumn_('ActivityID', ['activity id','id']), setupColumn_('Title of Activity', ['title','activity title','activity']),
      setupColumn_('Venue', ['location']), setupColumn_('Activity_Date', ['date of activity'])
    ];
    for (var q = 1; q <= 15; q++) responseColumns.push(setupColumn_('Answer' + q, ['q' + q,'question' + q]));
    responseColumns = responseColumns.concat([
      setupColumn_('Takeaways', ['key takeaways','most valuable takeaway']),
      setupColumn_('Suggestions', ['recommendations','improvements']),
      setupColumn_('Email Sent', ['emailsent','email_sent','sent','date emailed']),
      setupColumn_('Certificate Link', ['certificate','cert link','certificate url']),
      setupColumn_('Verification Code', ['verification id','certificate id']),
      setupColumn_('Verification URL', ['verify url']),
      setupColumn_('cStatus', ['status','processing status'])
    ]);
    var responses = ensureSetupSheet_(ss, 'Responses', responseColumns);

    var questionColumns = [], defaultQuestions = [
      'The activity objectives were clearly communicated.', 'The topics were relevant to my work.',
      'The speakers demonstrated strong subject knowledge.', 'The presentations were clear and well organized.',
      'The learning materials supported the sessions.', 'The activities encouraged meaningful participation.',
      'The time allotted for each session was appropriate.', 'The venue and facilities supported learning.',
      'The event staff were helpful and professional.', 'The registration process was smooth.',
      'The activity met my expectations.', 'I gained knowledge I can apply in my role.',
      'I would recommend this activity to colleagues.', 'Overall, how satisfied are you with the activity?',
      'How likely are you to attend a similar activity?'
    ];
    for (var i = 1; i <= 15; i++) questionColumns.push(setupColumn_('question' + i, ['question ' + i]));
    for (var ti = 1; ti <= 15; ti++) questionColumns.push(setupColumn_('type' + ti, ['type ' + ti, 'question' + ti + ' type']));
    var questions = ensureSetupSheet_(ss, 'Questions', questionColumns);
    var questionSheet = questions.sheet;
    if (questionSheet.getLastRow() < 2 || questionSheet.getRange(2,1,1,15).getDisplayValues()[0].every(function(value){return !safeTrim_(value);})) {
      questionSheet.getRange(2,1,1,15).setValues([defaultQuestions]);
      questions.seeded = true;
    }
    // Blank types already read as 'rating'; writing them makes the sheet
    // self-explanatory for anyone editing it by hand.
    var typeHeaderMap = getHeaderMap_(questionSheet), firstTypeCol = idxOf_(typeHeaderMap, ['type1']);
    if (firstTypeCol >= 0) {
      var existingTypes = questionSheet.getRange(2, firstTypeCol + 1, 1, 15).getDisplayValues()[0];
      if (existingTypes.every(function(value){ return !safeTrim_(value); }))
        questionSheet.getRange(2, firstTypeCol + 1, 1, 15).setValues([existingTypes.map(function(){ return 'rating'; })]);
    }

    var whitelist = ensureSetupSheet_(ss, 'Whitelist', [
      setupColumn_('user_id'), setupColumn_('name'), setupColumn_('role'), setupColumn_('email', ['e-mail']),
      setupColumn_('active', ['enabled']), setupColumn_('created_at'), setupColumn_('updated_at')
    ]);
    var users = ensureSetupSheet_(ss, 'Users', [
      setupColumn_('Email'), setupColumn_('PasswordHash', ['password hash']), setupColumn_('Salt'),
      setupColumn_('Name', ['display name']), setupColumn_('Role'), setupColumn_('Active'), setupColumn_('CreatedAt', ['created at'])
    ]);
    var audit = ensureSetupSheet_(ss, 'Audit', [
      setupColumn_('timestamp'),setupColumn_('audit_id'),setupColumn_('actor_email'),setupColumn_('actor_role'),
      setupColumn_('action'),setupColumn_('target_type'),setupColumn_('target_id'),setupColumn_('outcome'),
      setupColumn_('details'),setupColumn_('request_id'),setupColumn_('previous_hash'),setupColumn_('entry_hash')
    ]);
    audit.sheet.getRange('A:A').setNumberFormat('@');

    return {
      status: 'OK',
      spreadsheetUrl: ss.getUrl(),
      sheets: [activity, responses, questions, whitelist, users, audit].map(function(result){
        return {name:result.sheet.getName(),created:result.created,headersAdded:result.headersAdded,seeded:!!result.seeded};
      }),
      nextStep: 'Run setupParticipantFeedbackSecurity(), copy its submit token to Netlify, then run seedUsers() and setupCertificateQueueTrigger().'
    };
  } finally { lock.releaseLock(); }
}

function setupColumn_(header, aliases) { return {header:header, aliases:[header].concat(aliases || [])}; }

function ensureSetupSheet_(ss, sheetName, columns) {
  var sh = ss.getSheetByName(sheetName), created = false, added = [];
  if (!sh) { sh = ss.insertSheet(sheetName); created = true; }
  var hdr = getHeaderMap_(sh);
  columns.forEach(function(column){
    if (idxOf_(hdr, column.aliases) < 0) {
      var nextColumn = sh.getLastColumn() + 1;
      // A sheet has a fixed column count (26 on a new one). Writing past it
      // throws instead of growing the sheet.
      var maxColumns = sh.getMaxColumns();
      if (nextColumn > maxColumns) sh.insertColumnsAfter(maxColumns, nextColumn - maxColumns);
      sh.getRange(1,nextColumn).setValue(column.header);
      hdr[String(column.header).toLowerCase()] = nextColumn - 1;
      added.push(column.header);
    }
  });
  sh.setFrozenRows(1);
  if (sh.getLastColumn() > 0) {
    sh.getRange(1,1,1,sh.getLastColumn()).setFontWeight('bold').setBackground('#0b4b3c').setFontColor('#ffffff');
    sh.autoResizeColumns(1,sh.getLastColumn());
  }
  return {sheet:sh,created:created,headersAdded:added};
}

// --------------------------- Tamper-evident audit log ---------------------------
function isAuditedAction_(action) { return ['adminLogin','adminLogout','adminSaveActivity','adminSetActivityStatus','adminDeleteActivity','adminUploadSignature','adminSaveUser','adminSaveQuestions'].indexOf(action)>=0; }

function auditActorForRequest_(action, body) {
  if(action==='adminLogin')return {email:safeTrim_(body.email).toLowerCase(),role:''};
  var session=getAdminSession_(body.adminToken);
  return session?{email:session.email,role:session.role}:{email:'',role:''};
}

function auditActorForResult_(action, data, fallback) {
  if(action==='adminLogin'&&data&&data.user)return {email:safeTrim_(data.user.email).toLowerCase(),role:safeTrim_(data.user.role).toLowerCase()};
  return fallback||{email:'',role:''};
}

function auditTargetForRequest_(action, body) {
  var payload=body.payload||{};
  if(action==='adminLogin'||action==='adminLogout')return {type:'session',id:safeTrim_(body.email||(auditActorForRequest_(action,body)||{}).email)};
  if(action==='adminSaveActivity')return {type:'activity',id:safeTrim_(payload.activityId||payload.id||payload.title),details:{operation:payload.id?'update':'create',title:safeTrim_(payload.title).slice(0,160)}};
  if(action==='adminSetActivityStatus')return {type:'activity',id:safeTrim_(payload.id),details:{operation:(payload.active===true||String(payload.active).toLowerCase()==='true')?'enable':'disable'}};
  if(action==='adminDeleteActivity')return {type:'activity',id:safeTrim_(body.id||(body.payload&&body.payload.id))};
  if(action==='adminUploadSignature')return {type:'signature',id:safeTrim_(payload.filename).slice(0,180)};
  if(action==='adminSaveUser')return {type:'user',id:safeTrim_(payload.user_id||payload.email).toLowerCase(),details:{role:safeTrim_(payload.role).toLowerCase(),active:payload.active!==false}};
  if(action==='adminSaveQuestions')return {type:'survey',id:'Questions',details:{questionCount:(body.questions||(body.payload&&body.payload.questions)||[]).length}};
  return {type:'system',id:''};
}

function auditActionLabel_(action) { return {adminLogin:'LOGIN',adminLogout:'LOGOUT',adminSaveActivity:'ACTIVITY_SAVE',adminDeleteActivity:'ACTIVITY_DELETE',adminUploadSignature:'SIGNATURE_UPLOAD',adminSaveUser:'USER_SAVE',adminSaveQuestions:'QUESTIONS_SAVE'}[action]||safeTrim_(action).toUpperCase(); }

function ensureAuditSheet_() {
  var ss=SpreadsheetApp.getActiveSpreadsheet(),sh=ss.getSheetByName('Audit');
  if(!sh){
    sh=ensureSetupSheet_(ss,'Audit',[
      setupColumn_('timestamp'),setupColumn_('audit_id'),setupColumn_('actor_email'),setupColumn_('actor_role'),setupColumn_('action'),setupColumn_('target_type'),setupColumn_('target_id'),setupColumn_('outcome'),setupColumn_('details'),setupColumn_('request_id'),setupColumn_('previous_hash'),setupColumn_('entry_hash')
    ]).sheet;
  }
  forceAuditTimestampAsText_(sh);
  return sh;
}

/**
 * The timestamp is hashed as the literal string "yyyy-MM-dd HH:mm:ss", but
 * Sheets silently coerces that into a datetime and getDisplayValues() then
 * re-renders it — dropping the leading zero on hours below 10. The row's HMAC
 * no longer matches its own stored text, so the chain reports tampering that
 * never happened. Pinning the column to plain text keeps what was hashed.
 */
function forceAuditTimestampAsText_(sheet) {
  try {
    var col = idxOf_(getHeaderMap_(sheet), ['timestamp']);
    if (col < 0) return;
    // Sample a data row, not the header: a multi-cell getNumberFormat() reports
    // the top-left cell, and a text-formatted header would make this skip the
    // fix while every data row stayed a coerced date.
    var probeRow = sheet.getLastRow() >= 2 ? 2 : 1;
    if (sheet.getRange(probeRow, col + 1).getNumberFormat() === '@') return;
    sheet.getRange(1, col + 1, sheet.getMaxRows()).setNumberFormat('@');
  } catch (ignored) {}
}

function auditCanonical_(entry) { return [entry.timestamp,entry.audit_id,entry.actor_email,entry.actor_role,entry.action,entry.target_type,entry.target_id,entry.outcome,entry.details,entry.request_id,entry.previous_hash].map(safeTrim_).join('|'); }

function appendAuditForRequest_(action, body, success, errorMessage, actor, requestContext) {
  var secret=PropertiesService.getScriptProperties().getProperty('AUDIT_HASH_SECRET');
  if(!secret)return;
  var lock=LockService.getScriptLock();if(!lock.tryLock(5000))return;
  try{
    var sh=ensureAuditSheet_(),hdr=getHeaderMap_(sh),target=auditTargetForRequest_(action,body),lastRow=sh.getLastRow();
    var cHash=idxOf_(hdr,['entry_hash']),previous=lastRow>=2&&cHash>=0?safeTrim_(sh.getRange(lastRow,cHash+1).getValue()):'';
    var entry={timestamp:Utilities.formatDate(new Date(),Session.getScriptTimeZone()||'Asia/Manila','yyyy-MM-dd HH:mm:ss'),audit_id:'AUD-'+Utilities.getUuid().replace(/-/g,'').slice(0,16).toUpperCase(),actor_email:safeTrim_((actor||{}).email).toLowerCase(),actor_role:safeTrim_((actor||{}).role).toLowerCase(),action:auditActionLabel_(action),target_type:target.type,target_id:target.id,outcome:success?'SUCCESS':'FAILURE',details:JSON.stringify(success?(target.details||{}):{error:safeTrim_(errorMessage).slice(0,300)}),request_id:safeTrim_((requestContext||{}).requestId).slice(0,100),previous_hash:previous};
    entry.entry_hash=hmac256Base64_(auditCanonical_(entry),secret);
    var row=new Array(sh.getLastColumn()).fill('');Object.keys(entry).forEach(function(key){if(key in hdr)row[hdr[key]]=safeSheetValue_(entry[key]);});
    sh.appendRow(row);
    PropertiesService.getScriptProperties().setProperty('AUDIT_HEAD_HASH',entry.entry_hash);
  }finally{lock.releaseLock();}
}

function adminGetAuditLog(filters, adminToken) {
  requireSuperadmin_(adminToken);filters=filters||{};
  var sh=ensureAuditSheet_(),expectedHead=PropertiesService.getScriptProperties().getProperty('AUDIT_HEAD_HASH')||'';if(sh.getLastRow()<2)return {entries:[],integrity:{valid:!expectedHead,checkedRows:0}};
  var hdr=getHeaderMap_(sh),rows=sh.getRange(2,1,sh.getLastRow()-1,sh.getLastColumn()).getDisplayValues(),secret=PropertiesService.getScriptProperties().getProperty('AUDIT_HASH_SECRET')||'',integrity=true,previousShown=null;
  var entries=rows.map(function(row){function cell(name){return name in hdr?safeTrim_(row[hdr[name]]):'';}return{timestamp:cell('timestamp'),audit_id:cell('audit_id'),actor_email:cell('actor_email'),actor_role:cell('actor_role'),action:cell('action'),target_type:cell('target_type'),target_id:cell('target_id'),outcome:cell('outcome'),details:cell('details'),request_id:cell('request_id'),previous_hash:cell('previous_hash'),entry_hash:cell('entry_hash')};});
  entries.forEach(function(entry){if(!secret||!constantTimeEquals_(hmac256Base64_(auditCanonical_(entry),secret),entry.entry_hash)||(previousShown!==null&&entry.previous_hash!==previousShown))integrity=false;previousShown=entry.entry_hash;});if(expectedHead&&previousShown!==expectedHead)integrity=false;
  var action=safeTrim_(filters.action).toUpperCase(),outcome=safeTrim_(filters.outcome).toUpperCase(),query=safeTrim_(filters.query).toLowerCase();
  var filtered=entries.filter(function(entry){return(!action||entry.action===action)&&(!outcome||entry.outcome===outcome)&&(!query||[entry.actor_email,entry.target_id,entry.action,entry.details,entry.request_id].join(' ').toLowerCase().indexOf(query)>=0);});
  var limit=Math.min(500,Math.max(25,Number(filters.limit)||200));
  return {entries:filtered.slice(-limit).reverse().map(function(entry){delete entry.previous_hash;delete entry.entry_hash;try{entry.details=JSON.parse(entry.details||'{}');}catch(_){entry.details={};}return entry;}),integrity:{valid:integrity,checkedRows:entries.length},total:filtered.length};
}

// --- Whitelist helper ---
function isWhitelisted_(email) {
  email = (email || '').trim().toLowerCase();
  if (!email) return false;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Whitelist');
  if (!sh) return false;
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return false;
  var hdr = getHeaderMap_(sh);
  var cEmail = idxOf_(hdr, ['email','e-mail']);
  var cActive = idxOf_(hdr, ['active','enabled']);
  if (cEmail < 0) return false;
  var values = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  for (var i = 0; i < values.length; i++) {
    var e = String(values[i][cEmail] || '').trim().toLowerCase();
    var active = cActive < 0 || String(values[i][cActive]).toLowerCase() !== 'false';
    if (e && e === email && active) return true;
  }
  return false;
}

// ----------------- Public: activity data for the survey ----------------
/** Returns [{id, title, venue, date}] from 'Activity'
 * Assumes ActivityID was added as the LAST column (I, after Date Given).
 */
/** Public read caches. Cleared by invalidatePublicCache_() on admin writes. */
var PUBLIC_CACHE_SECONDS = 900;

/**
 * Days the feedback form stays open after ToDate. 0 = closes at the end of the
 * last activity day. Raise this if participants are expected to answer later.
 */
var FEEDBACK_GRACE_DAYS = 0;

/** Today at 00:00 in the script timezone, as yyyy-MM-dd. */
function todayKey_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Manila', 'yyyy-MM-dd');
}

function shiftDateKey_(key, days) {
  key = safeTrim_(key);
  if (!key) return '';
  var parts = key.split('-');
  if (parts.length !== 3) return key;
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (isNaN(d)) return key;
  d.setDate(d.getDate() + (days || 0));
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Asia/Manila', 'yyyy-MM-dd');
}

/**
 * Is the feedback window open today? Dates are compared as yyyy-MM-dd strings,
 * which sort lexicographically, so no timezone arithmetic is involved.
 * A blank FromDate means "no start restriction"; a blank ToDate means the
 * activity runs for the single FromDate day.
 */
function isFeedbackWindowOpen_(fromDate, toDate) {
  var today = todayKey_();
  var from = safeTrim_(fromDate);
  var to = safeTrim_(toDate) || from;
  if (from && today < from) return false;
  if (to && today > shiftDateKey_(to, FEEDBACK_GRACE_DAYS)) return false;
  return true;
}

/**
 * Shared gate used by submitFeedback and the certificate queue.
 * Returns {open, active, inWindow, message} for an Activity row.
 */
function activityGateState_(row, hdr) {
  var cActive = idxOf_(hdr, ['active','enabled','status']);
  var cFrom   = idxOf_(hdr, ['fromdate','from date','start']);
  var cTo     = idxOf_(hdr, ['todate','to date','end']);
  var cDate   = idxOf_(hdr, ['date']);

  var active = cActive < 0 ? true : isActiveCellEnabled_(row[cActive]);
  var from = cFrom >= 0 ? fmtDate_(row[cFrom]) : '';
  if (!from && cDate >= 0) from = fmtDate_(row[cDate]);
  var to = cTo >= 0 ? fmtDate_(row[cTo]) : '';
  var inWindow = isFeedbackWindowOpen_(from, to);

  var message = '';
  if (!active) message = 'This activity has been closed by its organizer. Feedback is no longer being collected.';
  else if (!inWindow) {
    var today = todayKey_();
    message = (from && today < from)
      ? ('Feedback for this activity opens on ' + from + '.')
      : 'The feedback period for this activity has ended.';
  }
  return { open: active && inWindow, active: active, inWindow: inWindow, message: message };
}

/**
 * Lookup of switched-off activities, by lowercased ActivityID and by title.
 * Read once per queue run rather than per response row.
 */
function disabledActivityKeys_() {
  var empty = { ids: {}, titles: {} };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Activity');
  if (!sh) return empty;
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return empty;

  var hdr = getHeaderMap_(sh);
  var cActive = idxOf_(hdr, ['active','enabled','status']);
  if (cActive < 0) return empty;
  var cId = idxOf_(hdr, ['activityid','activity id','id']);
  var cTitle = idxOf_(hdr, ['title','activity title','activity']);

  var rows = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  rows.forEach(function(row){
    if (isActiveCellEnabled_(row[cActive])) return;
    if (cId >= 0) { var id = safeTrim_(row[cId]).toLowerCase(); if (id) empty.ids[id] = true; }
    if (cTitle >= 0) { var t = safeTrim_(row[cTitle]).toLowerCase(); if (t) empty.titles[t] = true; }
  });
  return empty;
}

/** Activities are enabled unless the Active cell explicitly says otherwise. */
function isActiveCellEnabled_(value) {
  var raw = safeTrim_(value).toLowerCase();
  if (!raw) return true;
  return ['false','no','off','0','disabled','inactive','closed'].indexOf(raw) < 0;
}

/** The activity list is date-filtered, so its cache key carries today's date. */
function activitiesCacheKey_() {
  return 'PUBLIC_ACTIVITIES_' + todayKey_();
}

function invalidatePublicCache_() {
  CacheService.getScriptCache().removeAll([activitiesCacheKey_(), 'PUBLIC_QUESTIONS']);
}

/**
 * CacheService rejects values over 100 KB, so a long Activity sheet would throw
 * mid-request. Skipping the write only costs a slower read next time.
 */
function putPublicCache_(key, value) {
  var json = JSON.stringify(value);
  if (json.length > 90000) return;
  try {
    CacheService.getScriptCache().put(key, json, PUBLIC_CACHE_SECONDS);
  } catch (ignored) {}
}

function getActivityData() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(activitiesCacheKey_());
  if (hit) return JSON.parse(hit);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Activity');
  if (!sh) throw new Error("Sheet 'Activity' not found.");

  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  var hdrMap = getHeaderMap_(sh);
  var lastCol = sh.getLastColumn();
  var rows = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

  var cTitle = idxOf_(hdrMap, ['title','activity title','activity','Title']);
  var cVenue = idxOf_(hdrMap, ['venue','location','Venue']);
  var cDate  = idxOf_(hdrMap, ['date','Date']); // single date column if present
  var cFrom  = idxOf_(hdrMap, ['fromdate','from date','start']);
  var cTo    = idxOf_(hdrMap, ['todate','to date','end']);
  var cId    = idxOf_(hdrMap, ['activityid','activity id','id']);
  var cActive = idxOf_(hdrMap, ['active','enabled','status']);

  var out = [];
  rows.forEach(function(r){
    var title = cTitle >= 0 ? safeTrim_(r[cTitle]) : '';
    if (!title) return;

    // Participants only ever see activities that are switched on and inside
    // their feedback window. submitFeedback re-checks both server-side.
    if (cActive >= 0 && !isActiveCellEnabled_(r[cActive])) return;
    var winFrom = cFrom >= 0 ? fmtDate_(r[cFrom]) : '';
    var winTo   = cTo   >= 0 ? fmtDate_(r[cTo])   : '';
    if (cDate >= 0 && !winFrom) winFrom = fmtDate_(r[cDate]);
    if (!isFeedbackWindowOpen_(winFrom, winTo)) return;

    var venue = cVenue >= 0 ? safeTrim_(r[cVenue]) : '';
    var dateStr = '';
    if (cDate >= 0) {
      dateStr = fmtDate_(r[cDate]);
    } else {
      var fromV = cFrom >= 0 ? fmtDate_(r[cFrom]) : '';
      var toV   = cTo   >= 0 ? fmtDate_(r[cTo])   : '';
      dateStr = (fromV && toV && fromV !== toV)
        ? (fromV + ' – ' + toV)
        : (fromV || toV || '');
    }

    var id = cId >= 0 ? safeTrim_(r[cId]) : '';
    out.push({
      id: id,
      title: title,
      venue: venue,
      date : dateStr
    });
  });

  putPublicCache_(activitiesCacheKey_(), out);
  return out;
}

// ----------------- Public: load 15 questions for survey --------------
/** Returns question1..question15 from 'Questions' (row 2) */
function getQuestions() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('PUBLIC_QUESTIONS');
  if (hit) return JSON.parse(hit);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Questions');
  if (!sh) throw new Error("Sheet 'Questions' not found.");

  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  var out = {};
  for (var i = 1; i <= 15; i++) { out['question' + i] = ''; out['type' + i] = 'rating'; }
  if (lastRow < 2 || lastCol < 1) return out;

  var hdrMap = getHeaderMap_(sh);
  var row = sh.getRange(2, 1, 1, lastCol).getValues()[0];

  function candidatesFor(j){
    return [
      'question'+j, 'Question'+j, 'QUESTION'+j,
      'question '+j, 'Question '+j, 'QUESTION '+j
    ];
  }
  for (var j = 1; j <= 15; j++) {
    var key = 'question' + j;
    var idx = idxOf_(hdrMap, candidatesFor(j));
    out[key] = safeTrim_(idx >= 0 ? (row[idx] || '') : '');
    var typeIdx = idxOf_(hdrMap, ['type'+j, 'Type'+j, 'type '+j, 'question'+j+' type']);
    out['type' + j] = normalizeQuestionType_(typeIdx >= 0 ? (row[typeIdx] || '') : '');
  }
  putPublicCache_('PUBLIC_QUESTIONS', out);
  return out;
}

// ----------------- Activity lookups -----------------
function findActivityByIdOrTitle_(activityId, title) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Activity');
  if (!sh) throw new Error("Sheet 'Activity' not found.");

  var hdr = getHeaderMap_(sh);
  var cId     = idxOf_(hdr, ['activityid','activity id','id']);
  var cTitle  = idxOf_(hdr, ['title','activity title','activity']);
  if (cTitle < 0 && cId < 0) throw new Error("Activity sheet is missing Title/ActivityID columns.");

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2) return null;
  var rows = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

  var wantId = safeTrim_(activityId).toLowerCase();
  var wantTitle = safeTrim_(title).toLowerCase();

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var rowId = (cId >= 0) ? safeTrim_(row[cId]).toLowerCase() : '';
    var rowTitle = (cTitle >= 0) ? safeTrim_(row[cTitle]).toLowerCase() : '';
    var idMatch = wantId && rowId && (rowId === wantId);
    var titleMatch = wantTitle && rowTitle && (rowTitle === wantTitle);
    if (idMatch || titleMatch) {
      return { rowIndex: i + 2, row: row, header: hdr };
    }
  }
  return null;
}

// ----------------- Duplicate check (server) -----------------
/**
 * Check if a user already responded to a given Activity.
 * Match priority:
 *  1) ActivityID + Email (case-insensitive)
 *  2) ActivityID + Name (case-insensitive)
 *  3) Title + Email
 *  4) Title + Name
 * Returns: {already:boolean, by:'email'|'name'|''}
 *
 * NOTE: Rows whose status column (cStatus) starts with "ERROR"
 *       are ignored so that failed certificate/email attempts
 *       do not permanently block re-submission.
 */
function hasAlreadyResponded(name, email, activityId, title) {
  name      = safeTrim_(name).toLowerCase();
  email     = safeTrim_(email).toLowerCase();
  activityId= safeTrim_(activityId).toLowerCase();
  title     = safeTrim_(title).toLowerCase();

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Responses');
  if (!sh) return { already: false, by: '' };

  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { already: false, by: '' };

  var hdrMap = getHeaderMap_(sh);
  var lastCol = sh.getLastColumn();
  var data = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

  var cTitle  = idxOf_(hdrMap, ['title of activity','title','activity title','activity']);
  var cEmail  = idxOf_(hdrMap, ['responder email','email','e-mail']);
  var cName   = idxOf_(hdrMap, ['name']);
  var cActId  = idxOf_(hdrMap, ['activityid','activity id','id']);
  var cStatus = idxOf_(hdrMap, ['cstatus','status','processing status']); // NEW

  for (var i = data.length - 1; i >= 0; i--) {
    var row = data[i];

    // Skip rows that are explicitly in ERROR state (e.g., cert/email failed)
    if (cStatus >= 0) {
      var rowStatus = safeTrim_(row[cStatus]).toUpperCase();
      if (rowStatus.indexOf('ERROR') === 0) {
        // Treat as non-final: allow user to submit again
        continue;
      }
    }

    var rowTitle = (cTitle >= 0) ? safeTrim_(row[cTitle]).toLowerCase() : '';
    var rowEmail = (cEmail >= 0) ? safeTrim_(row[cEmail]).toLowerCase() : '';
    var rowName  = (cName  >= 0) ? safeTrim_(row[cName]).toLowerCase()  : '';
    var rowActId = (cActId >= 0) ? safeTrim_(row[cActId]).toLowerCase() : '';

    // 1) ActivityID + Email
    if (activityId && rowActId && activityId === rowActId && email && rowEmail && email === rowEmail) {
      return { already: true, by: 'email' };
    }
    // 2) ActivityID + Name
    if (activityId && rowActId && activityId === rowActId && name && rowName && name === rowName) {
      return { already: true, by: 'name' };
    }
    // 3) Title + Email
    if (title && rowTitle && title === rowTitle && email && rowEmail && email === rowEmail) {
      return { already: true, by: 'email' };
    }
    // 4) Title + Name
    if (title && rowTitle && title === rowTitle && name && rowName && name === rowName) {
      return { already: true, by: 'name' };
    }
  }
  return { already: false, by: '' };
}


function getSubmitUrl(state, title){
  var base = getWebAppUrl();
  return base + '?page=submit&state=' + encodeURIComponent(state || 'ok') +
         '&title=' + encodeURIComponent(title || '');
}

// --------- Public: append response + generate email & certificate -----
// --------- Public: append response + generate email & certificate (refactored) -----
function submitFeedback(formData) {
  formData = formData || {};
  if (safeTrim_(formData.website)) return { status:'QUEUED', message:'Feedback received.' };
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);

  var nextRow = -1;

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('Responses');
    if (!sh) throw new Error("Sheet 'Responses' not found.");

    // If client-side email missed, try viewer email
    if (!formData.email) {
      var viewer = getViewerEmail_();
      if (viewer) formData.email = viewer;
    }

    // --- authoritative validations under document lock (NO heavy IO here) ---
    var nameT   = safeTrim_(formData.name || '');
    var emailT  = safeTrim_(formData.email || '');
    var actIdT  = safeTrim_(formData.activityId || formData.activity_id || ''); // accept either key
    var titleT  = safeTrim_(formData.title || formData.activityTitle || '');
    var venueT  = safeTrim_(formData.venue || '');
    var dateT   = safeTrim_(formData.activity_date || formData.date || '');

    if (!actIdT && !titleT) {
      // No row written yet → just return (finally will still release the lock)
      return { status: 'BAD_REQUEST', message: 'Activity selection is required.' };
    }

    if (!nameT || nameT.length > 160) {
      return { status: 'BAD_REQUEST', message: 'Name is required.' };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailT) || emailT.length > 254) {
      return { status: 'BAD_REQUEST', message: 'A valid email is required.' };
    }
    if (!formData.sex) {
      return { status: 'BAD_REQUEST', message: 'Sex is required.' };
    }
    var ageNum = parseInt(formData.age, 10);
    if (!ageNum || ageNum < 1 || ageNum > 120) {
      return { status: 'BAD_REQUEST', message: 'Age must be between 1 and 120.' };
    }

    // Duplicate check (race-proof: inside lock)
    var dup = hasAlreadyResponded(nameT, emailT, actIdT, titleT);
    if (dup && dup.already) {
      return { status: 'DUP', by: dup.by || '' };
    }

    // Activity existence check
    var act = findActivityByIdOrTitle_(actIdT, titleT);
    if (!act) {
      return { status: 'BAD_REQUEST', message: 'Selected activity not found. Please re-select the activity.' };
    }

    // Re-check the switch and the date window here: the browser may have loaded
    // the activity list days ago, or before an administrator closed it.
    var gate = activityGateState_(act.row, act.header);
    if (!gate.open) {
      return { status: 'CLOSED', message: gate.message };
    }

    // Prepare to write row using header map (resilient to order)
    var hdrMap = getHeaderMap_(sh);
    var lastCol = sh.getLastColumn();
    nextRow = sh.getLastRow() + 1;

    // Start with an empty row array (preserve existing width)
    var rowArr = new Array(lastCol).fill('');

    function setCol_(names, value){
      var c = idxOf_(hdrMap, names);
      if (c >= 0) rowArr[c] = safeSheetValue_(value);
    }

    // Set known columns (if present)
    setCol_(['timestamp','date','submitted at'], new Date());
    setCol_(['name'], formData.name || '');
    setCol_(['responder email','email','e-mail'], formData.email || '');
    setCol_(['sex'], formData.sex || '');
    setCol_(['age'], formData.age || '');
    setCol_(['activityid','activity id','id'], actIdT || '');
    setCol_(['title of activity','title','activity title','activity'], titleT || '');
    setCol_(['venue','location'], venueT || '');
    setCol_(['activity_date','date of activity','date'], dateT || '');

    // Answers 1..15
    for (var i = 1; i <= 15; i++) {
      // Long-text answers are capped here too: the browser's maxLength is not
      // a control a crafted request has to respect.
      setCol_(['answer'+i, 'q'+i, 'question'+i], safeTrim_(formData['answer'+i] || formData['question'+i] || '').slice(0, 2000));
    }

    setCol_(['takeaways','key takeaways','most valuable takeaway'], safeTrim_(formData.takeaways || ''));
    setCol_(['suggestions','recommendations','improvements'], safeTrim_(formData.suggestions || ''));

    // Email sent / Certificate link / cStatus — initialized here
    setCol_(['email sent','emailsent','email_sent','sent','date emailed'], '');
    setCol_(['certificate','certificate link','cert link','certificate url'], '');
    setCol_(['verification code','verification id','certificate id'], makeVerificationCode_());
    setCol_(['verification url','verify url'], '');
    setCol_(['cstatus','status','processing status'], 'PENDING');

    // Single write under lock
    sh.getRange(nextRow, 1, 1, lastCol).setValues([rowArr]);

    ensureCertificateQueueTrigger_();

  } catch (e) {
    // Best-effort write error status back to the cStatus column IF we already know nextRow
    try {
      var ss2 = SpreadsheetApp.getActiveSpreadsheet();
      var sh2 = ss2.getSheetByName('Responses');
      if (nextRow > 0 && sh2) {
        var hdr2 = getHeaderMap_(sh2);
        var cStatus2 = idxOf_(hdr2, ['cstatus','status','processing status']);
        if (cStatus2 >= 0) {
          sh2.getRange(nextRow, cStatus2 + 1).setValue('ERROR: ' + e.message);
        }
      }
    } catch (_){}
    throw e; // let the client failureHandler handle it
  } finally {
    try { lock.releaseLock(); } catch (_){}
  }

  return {
    status: 'QUEUED',
    queueRow: nextRow,
    message: 'Feedback received. Your certificate will be emailed after processing.'
  };
}

/** Creates the one-minute processor once. Safe to run manually after deploy. */
function setupCertificateQueueTrigger() {
  var handler = 'processCertificateQueue';
  var triggers = ScriptApp.getProjectTriggers();
  var exists = triggers.some(function(trigger) {
    return trigger.getHandlerFunction() === handler;
  });
  if (!exists) ScriptApp.newTrigger(handler).timeBased().everyMinutes(1).create();
  PropertiesService.getScriptProperties().setProperty('CERTIFICATE_QUEUE_TRIGGER_READY', '1');
  return { status: exists ? 'EXISTS' : 'CREATED' };
}

function ensureCertificateQueueTrigger_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('CERTIFICATE_QUEUE_TRIGGER_READY') === '1') return;
  setupCertificateQueueTrigger();
}

function makeVerificationCode_() { return 'CHED-' + Utilities.getUuid().replace(/-/g,'').slice(0,20).toUpperCase(); }

function ensureResponseVerification_(sheet, header, rowIndex, rowValues) {
  var cCode=idxOf_(header,['verification code','verification id','certificate id']),cUrl=idxOf_(header,['verification url','verify url']);
  if(cCode<0){sheet.getRange(1,sheet.getLastColumn()+1).setValue('Verification Code');header=getHeaderMap_(sheet);cCode=idxOf_(header,['verification code']);}
  if(cUrl<0){sheet.getRange(1,sheet.getLastColumn()+1).setValue('Verification URL');header=getHeaderMap_(sheet);cUrl=idxOf_(header,['verification url']);}
  var code=safeTrim_(rowValues[cCode])||makeVerificationCode_(),base=PropertiesService.getScriptProperties().getProperty('PORTAL_BASE_URL')||'';
  if(!base)throw new Error('Portal URL is not configured. Submit through the deployed Netlify portal once, or set PORTAL_BASE_URL in Script Properties.');
  var url=base.replace(/\/$/,'')+'/verification?code='+encodeURIComponent(code);
  sheet.getRange(rowIndex,cCode+1).setValue(code);sheet.getRange(rowIndex,cUrl+1).setValue(url);
  return {code:code,url:url};
}

function verifyCertificate(code) {
  code=safeTrim_(code).toUpperCase();
  if(!/^CHED-[A-F0-9]{20}$/.test(code))return {valid:false};
  var sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Responses');
  if(!sh||sh.getLastRow()<2)return {valid:false};
  var hdr=getHeaderMap_(sh),cCode=idxOf_(hdr,['verification code','verification id','certificate id']),cStatus=idxOf_(hdr,['cstatus','status','processing status']);
  if(cCode<0||cStatus<0)return {valid:false};
  var match=sh.getRange(2,cCode+1,sh.getLastRow()-1,1).createTextFinder(code).matchEntireCell(true).matchCase(false).findNext();
  if(!match)return {valid:false};
  var row=sh.getRange(match.getRow(),1,1,sh.getLastColumn()).getValues()[0];
  if(safeTrim_(row[cStatus]).toUpperCase()!=='OK')return {valid:false};
  function value(names){var col=idxOf_(hdr,names);return col>=0?row[col]:'';}
  return {valid:true,verificationCode:code,name:safeTrim_(value(['name'])),activity:safeTrim_(value(['title of activity','title','activity title'])),activityDate:fmtDate_(value(['activity_date','date of activity'])),venue:safeTrim_(value(['venue','location'])),issuedAt:fmtDate_(value(['email sent','date emailed'])),certificateUrl:safeTrim_(value(['certificate link','certificate','certificate url']))};
}

/**
 * Processes queued certificates outside web requests. Only one processor may
 * run at a time, and the remaining Google Workspace Mail quota caps each batch.
 */
function processCertificateQueue() {
  var processorLock = LockService.getScriptLock();
  if (!processorLock.tryLock(1000)) return { status: 'BUSY' };

  var startedAt = Date.now();
  var processed = 0;
  var failed = 0;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('Responses');
    if (!sh || sh.getLastRow() < 2) return { status: 'EMPTY', processed: 0 };

    var hdr = getHeaderMap_(sh);
    var cStatus = idxOf_(hdr, ['cstatus','status','processing status']);
    var cEmailSent = idxOf_(hdr, ['email sent','emailsent','email_sent','sent','date emailed']);
    var cCertLink = idxOf_(hdr, ['certificate','certificate link','cert link','certificate url']);
    if (cStatus < 0) throw new Error('Responses processing-status column is required.');

    var remainingMail = MailApp.getRemainingDailyQuota();
    if (remainingMail < 1) return { status: 'EMAIL_QUOTA_EXHAUSTED', processed: 0 };

    var values = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
    var cRespActivityId = idxOf_(hdr, ['activityid','activity id','id']);
    var cRespTitle = idxOf_(hdr, ['title of activity','title','activity title','activity']);
    var disabledActivities = disabledActivityKeys_();
    var queueRows = [];
    var held = 0;
    for (var i = 0; i < values.length && queueRows.length < Math.min(CERTIFICATE_BATCH_SIZE, remainingMail); i++) {
      if (safeTrim_(values[i][cStatus]).toUpperCase() !== 'PENDING') continue;
      // Rows for a switched-off activity stay PENDING and are picked up again
      // automatically if it is switched back on.
      var respId = cRespActivityId >= 0 ? safeTrim_(values[i][cRespActivityId]).toLowerCase() : '';
      var respTitle = cRespTitle >= 0 ? safeTrim_(values[i][cRespTitle]).toLowerCase() : '';
      if ((respId && disabledActivities.ids[respId]) || (respTitle && disabledActivities.titles[respTitle])) {
        held++;
        continue;
      }
      queueRows.push(i + 2);
    }

    for (var q = 0; q < queueRows.length; q++) {
      if (Date.now() - startedAt > CERTIFICATE_RUN_BUDGET_MS) break;
      var rowIndex = queueRows[q];
      sh.getRange(rowIndex, cStatus + 1).setValue('PROCESSING');
      SpreadsheetApp.flush();
      try {
        var meta = sendCertificateForResponse_(rowIndex);
        if (cCertLink >= 0) sh.getRange(rowIndex, cCertLink + 1).setValue(meta.certificateUrl || '');
        if (cEmailSent >= 0) sh.getRange(rowIndex, cEmailSent + 1).setValue(meta.emailStatus || 'No recipient email');
        sh.getRange(rowIndex, cStatus + 1).setValue('OK');
        processed++;
      } catch (error) {
        sh.getRange(rowIndex, cStatus + 1).setValue('ERROR: ' + String(error.message || error).slice(0, 450));
        failed++;
      }
    }
    return { status: 'OK', processed: processed, failed: failed, held: held, queued: queueRows.length - processed - failed };
  } finally {
    try { processorLock.releaseLock(); } catch (_) {}
  }
}


/**
 * Creates & emails a certificate PDF for the given Responses row.
 * Placeholders in template: {{Name}}, {{Title}}, {{Venue}}, {{Date}}, {{FromDate}}, {{ToDate}}, {{GivenDate}}
 */
function sendCertificateForResponse_(responsesRowIndex) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // --- Responses row lookup ---
  var respSh = ss.getSheetByName('Responses');
  if (!respSh) throw new Error("Responses sheet not found.");
  var respHdr = getHeaderMap_(respSh);
  var lastCol = respSh.getLastColumn();
  var r = respSh.getRange(responsesRowIndex, 1, 1, lastCol).getValues()[0];

  var cName   = idxOf_(respHdr, ['name']);
  var cTitle  = idxOf_(respHdr, ['title of activity','title','activity title','activity']);
  var cEmail  = idxOf_(respHdr, ['responder email','email','e-mail']);
  var cActId  = idxOf_(respHdr, ['activityid','activity id','id']);

  if (cName < 0)  throw new Error('Responses "Name" column not found.');
  if (cTitle < 0 && cActId < 0) throw new Error('Responses needs Title or ActivityID column.');

  var name  = safeTrim_(r[cName]);
  var title = (cTitle >= 0) ? safeTrim_(r[cTitle]) : '';
  var email = (cEmail >= 0) ? safeTrim_(r[cEmail]) : '';
  var activityId = (cActId >= 0) ? safeTrim_(r[cActId]) : '';
  var verification = ensureResponseVerification_(respSh,respHdr,responsesRowIndex,r);

  if (!name)  throw new Error('Response "Name" is blank.');
  if (!activityId && !title) throw new Error('Response missing ActivityID/Title.');

  // --- Activity lookup (prefer ActivityID) ---
  var activity = findActivityByIdOrTitle_(activityId, title);
  if (!activity) throw new Error('No matching Activity for ActivityID/Title.');

  var actSh = ss.getSheetByName('Activity');
  var actHdr = activity.header;
  var aRow = activity.row;

  var cTpl   = idxOf_(actHdr, ['certificate template','template']);
  var cVenue = idxOf_(actHdr, ['venue','location']);
  var cDate  = idxOf_(actHdr, ['date']);
  var cFrom  = idxOf_(actHdr, ['fromdate','from date','start']);
  var cTo    = idxOf_(actHdr, ['todate','to date','end']);
  var cGiven = idxOf_(actHdr, ['givendate','given date','date given','issued','schedule']);
  var cATitle= idxOf_(actHdr, ['title','activity title','activity']);
  var cDesignation = idxOf_(actHdr, ['signatory designation','designation']);
  var cSignature = idxOf_(actHdr, ['e-signature','signature','signature image']);
  var cSignatory = idxOf_(actHdr, ['focal-in-charge','focal in charge','in-charge','in charge']);

  if (cTpl < 0) throw new Error("Activity 'Certificate Template' column missing.");

  var templateUrl = safeTrim_(aRow[cTpl]);
  var aVenue = cVenue >= 0 ? safeTrim_(aRow[cVenue]) : '';
  var aDate  = cDate  >= 0 ? fmtDate_(aRow[cDate])   : '';
  var aFrom  = cFrom  >= 0 ? fmtDate_(aRow[cFrom])   : '';
  var aTo    = cTo    >= 0 ? fmtDate_(aRow[cTo])     : '';
  var aGiven = cGiven >= 0 ? fmtDate_(aRow[cGiven])  : '';
  var aTitle = cATitle>= 0 ? safeTrim_(aRow[cATitle]): (title || '');
  var aDesignation = cDesignation>=0?safeTrim_(aRow[cDesignation]):'';
  var aSignature = cSignature>=0?safeTrim_(aRow[cSignature]):'';
  var aSignatory = cSignatory>=0?safeTrim_(aRow[cSignatory]):'';

  if (!templateUrl) throw new Error('Missing certificate template for selected activity.');

  // --- Validate template & destination folder ---
  var tpl = parseAndAssertFile_(templateUrl, "Template");
  var certFolder = assertFolder_(CERTIFICATES_FOLDER_ID, "Certificates folder");

  // --- Prepare editable Slides doc ---
  var slidesId, baseTitle = ('Cert - ' + name + ' - ' + aTitle).slice(0, 180);
  if (tpl.mime === MimeType.GOOGLE_SLIDES) {
    slidesId = tpl.file.makeCopy(baseTitle, certFolder).getId();
  } else {
    // Convert Office → Slides
    var blob = tpl.file.getBlob();
    blob.setName(baseTitle + '.pptx');
    var created = driveCreateGoogleSlidesFromOffice_(blob, baseTitle, CERTIFICATES_FOLDER_ID);
    slidesId = created.id;
  }

  // --- Replace placeholders ---
  var pres = SlidesApp.openById(slidesId);
  // Unconditional: a guarded replace leaves a literal "{{Venue}}" printed on
  // the certificate whenever the field happens to be empty.
  pres.replaceAllText('{{Name}}', name);
  pres.replaceAllText('{{Title}}', aTitle);
  pres.replaceAllText('{{Venue}}', aVenue);
  // Dates print as "August 4, 2026" — no leading zeros. {{DateRange}} is the
  // preferred placeholder: it collapses a one-day activity to a single date
  // instead of "on <date> to <same date>".
  pres.replaceAllText('{{DateRange}}', activityDateRangeText_(aFrom, aTo));
  pres.replaceAllText('{{Date}}', fmtLongDate_(aDate));
  pres.replaceAllText('{{FromDate}}', fmtLongDate_(aFrom));
  pres.replaceAllText('{{ToDate}}', fmtLongDate_(aTo));
  pres.replaceAllText('{{GivenDate}}', fmtLongDate_(aGiven));
  pres.replaceAllText('{{Signatory}}', aSignatory);
  pres.replaceAllText('{{Designation}}', aDesignation);
  if (aSignature) replaceSignaturePlaceholder_(pres, aSignature);
  pres.replaceAllText('{{VerificationCode}}', verification.code);
  pres.replaceAllText('{{VerificationUrl}}', verification.url);
  replaceQrPlaceholder_(pres, verification.url);
  pres.saveAndClose();

  // --- Export to PDF, store, and share ---
  var pdfBlob = driveExportFileAsPdf_(slidesId);
  pdfBlob.setName('Certificate - ' + name + ' - ' + aTitle + '.pdf');

  var pdfFile = certFolder.createFile(pdfBlob);
  var sharingWarning = '';
  try {
    // Choose policy: ANYONE_WITH_LINK or DOMAIN_WITH_LINK
    pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    // pdfFile.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (sharingError){
    // A Workspace policy can forbid link sharing. The email would then carry a
    // link the recipient cannot open, so record it instead of failing silently.
    sharingWarning = ' (link sharing blocked: ' + String(sharingError && sharingError.message || sharingError).slice(0, 120) + ')';
  }
  var certUrl = pdfFile.getUrl();

  // The editable Slides copy was only an intermediate step. Left behind, every
  // certificate would leave a second, modifiable file in the certificates
  // folder carrying the participant's name.
  try { DriveApp.getFileById(slidesId).setTrashed(true); } catch (cleanupError) {}

  // --- Email link (no attachment) ---
  var emailStatus = '';
  if (email) {
    var sentAt = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'UTC', 'yyyy-MM-dd HH:mm');
    var mail = buildCertificateEmail_({
      name: name,
      title: aTitle,
      venue: aVenue,
      dateRange: activityDateRangeText_(aFrom, aTo),
      certificateUrl: certUrl,
      verificationCode: verification.code,
      verificationUrl: verification.url
    });
    MailApp.sendEmail({
      to: email,
      subject: mail.subject,
      body: mail.text,
      htmlBody: mail.html,
      name: 'CHED Office of Student Development and Services'
    });
    emailStatus = sentAt + sharingWarning;
  } else {
    emailStatus = 'No recipient email' + sharingWarning;
  }

  return { certificateUrl: certUrl, emailStatus: emailStatus };
}

/**
 * Swap a text placeholder for an image WITHOUT destroying the rest of the text.
 *
 * The previous version called shape.remove() on any shape containing the token,
 * which deleted the whole text box. In a template where {{Signature}} shares a
 * box with {{Signatory}} and {{Designation}} — or {{QRCode}} shares one with
 * {{VerificationCode}} — that silently erased every one of those lines from the
 * finished certificate.
 *
 * Only a shape whose entire text IS the placeholder is safe to remove. In that
 * case the image takes the shape's exact rectangle, which is the arrangement
 * that gives correct placement. Otherwise the token alone is stripped and the
 * image is anchored at the token's estimated line, leaving surrounding text
 * intact.
 */
function replaceImagePlaceholder_(presentation, token, blob, options) {
  options = options || {};
  var placed = false;
  presentation.getSlides().forEach(function(slide){
    slide.getShapes().forEach(function(shape){
      try {
        var text = shape.getText().asString();
        if (text.indexOf(token) < 0) return;

        var left = shape.getLeft(), top = shape.getTop();
        var width = shape.getWidth(), height = shape.getHeight();

        if (safeTrim_(text) === token) {
          // The placeholder owns the whole box: exact placement.
          shape.remove();
          slide.insertImage(blob, left, top, width, height);
          placed = true;
          return;
        }

        // Mixed box: keep the text, estimate where the token's line sits.
        var lines = text.split(String.fromCharCode(10));
        var lineIndex = 0;
        for (var i = 0; i < lines.length; i++) { if (lines[i].indexOf(token) >= 0) { lineIndex = i; break; } }
        var lineHeight = height / Math.max(1, lines.length);
        var imageHeight = Math.max(lineHeight, height * (options.heightRatio || 0.25));
        var imageWidth = width * (options.widthRatio || 0.35);
        var imageLeft = left + (options.align === 'left' ? 0 : (width - imageWidth) / 2);
        var imageTop = top + (lineIndex * lineHeight) - (imageHeight - lineHeight) / 2;

        shape.getText().replaceAllText(token, '');
        slide.insertImage(blob, imageLeft, Math.max(top, imageTop), imageWidth, imageHeight);
        placed = true;
      } catch (ignored) {}
    });
  });
  return placed;
}

function replaceSignaturePlaceholder_(presentation, signatureUrl) {
  var signature = parseAndAssertFile_(signatureUrl, 'E-signature').file.getBlob();
  return replaceImagePlaceholder_(presentation, '{{Signature}}', signature, { heightRatio: 0.22, widthRatio: 0.35 });
}

function replaceQrPlaceholder_(presentation, verificationUrl) {
  var blob;
  try {
    blob = UrlFetchApp.fetch('https://quickchart.io/qr?size=300&margin=2&text=' + encodeURIComponent(verificationUrl))
      .getBlob().setName('verification-qr.png');
  } catch (fetchError) {
    // No QR service: strip the token so the certificate does not print it raw.
    try { presentation.replaceAllText('{{QRCode}}', ''); } catch (ignored) {}
    return false;
  }
  return replaceImagePlaceholder_(presentation, '{{QRCode}}', blob, { heightRatio: 0.3, widthRatio: 0.18, align: 'left' });
}

// --------------------- Drive REST helpers ----------------------------
/** Convert PPT/PPTX blob into Google Slides using Drive v3 REST. */
function driveCreateGoogleSlidesFromOffice_(officeBlob, newTitle, parentFolderId) {
  var boundary = '-------314159265358979323846';
  var delimiter = '\r\n--' + boundary + '\r\n';
  var closeDelim = '\r\n--' + boundary + '--';

  var metadata = {
    name: newTitle || (officeBlob.getName() || 'Imported Slides'),
    mimeType: 'application/vnd.google-apps.presentation',
    parents: parentFolderId ? [parentFolderId] : []
  };

  var body =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    delimiter +
    'Content-Type: ' + (officeBlob.getContentType() || 'application/vnd.openxmlformats-officedocument.presentationml.presentation') + '\r\n' +
    'Content-Transfer-Encoding: base64\r\n' +
    '\r\n' +
    Utilities.base64Encode(officeBlob.getBytes()) +
    closeDelim;

  var params = {
    method: 'post',
    contentType: 'multipart/related; boundary=' + boundary,
    payload: body,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  };

  var url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType';
  var res = UrlFetchApp.fetch(url, params);
  if (res.getResponseCode() >= 300) {
    throw new Error('Drive upload failed (' + res.getResponseCode() + '): ' + res.getContentText());
  }
  var obj = JSON.parse(res.getContentText());
  return { id: obj.id, name: obj.name, mimeType: obj.mimeType };
}

/** Export a Google file as PDF using Drive v3 REST. */
function driveExportFileAsPdf_(fileId) {
  var url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) +
            '/export?mimeType=application/pdf';
  var res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Drive export failed (' + res.getResponseCode() + '): ' + res.getContentText());
  }
  var blob = res.getBlob();
  blob.setName('export.pdf');
  return blob;
}

// ========================= Admin API for Activity sheet ======================
/* Expected Activity sheet columns (A..I):
 *  A: Title
 *  B: Venue
 *  C: fromDate
 *  D: toDate
 *  E: Certificate Template (URL or text)
 *  F: Focal-in-Charge
 *  G: Timestamp (auto-managed here)
 *  H: Date Given
 *  I: ActivityID   <-- NEW last field
 */

// Map a single Activity row → object using header-based column indices
function _activityRowToObj_(rowValues, rowIndex, cols) {
  function cell(c) {
    return (typeof c === 'number' && c >= 0 && c < rowValues.length)
      ? rowValues[c]
      : '';
  }

  var tsVal = cell(cols.timestamp);
  var tsOut;
  if (tsVal instanceof Date) {
    tsOut = Utilities.formatDate(
      tsVal,
      Session.getScriptTimeZone() || 'Asia/Manila',
      'yyyy-MM-dd HH:mm'
    );
  } else {
    tsOut = safeTrim_(tsVal);
  }

  return {
    id: rowIndex, // visible sheet row number (2..)
    title:     safeTrim_(cell(cols.title)),
    venue:     safeTrim_(cell(cols.venue)),
    fromDate:  fmtDate_(cell(cols.fromDate)),
    toDate:    fmtDate_(cell(cols.toDate)),
    template:  safeTrim_(cell(cols.template)),
    inCharge:  safeTrim_(cell(cols.inCharge)),
    region: safeTrim_(cell(cols.region)),
    signatoryDesignation: safeTrim_(cell(cols.signatoryDesignation)),
    signature: safeTrim_(cell(cols.signature)),
    Timestamp: tsOut,
    givenDate: fmtDate_(cell(cols.givenDate)),
    activityId: safeTrim_(cell(cols.activityId)),
    createdBy: safeTrim_(cell(cols.createdBy)).toLowerCase(),
    active: isActiveCellEnabled_(cell(cols.active)),
    // Mirrors getActivityData's fallback so the admin badge cannot disagree
    // with what participants actually see.
    windowOpen: isFeedbackWindowOpen_(fmtDate_(cell(cols.fromDate)) || fmtDate_(cell(cols.date)), fmtDate_(cell(cols.toDate)))
  };
}

/** GET: list activities for admin table (header-based, column-order safe) */
function adminGetActivities(adminToken) {
  var session = getAdminSession_(adminToken);
  if (!session) throw new Error('Forbidden: administrator authorization required.');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Activity');
  if (!sh) throw new Error("Sheet 'Activity' not found.");

  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];

  var hdr = getHeaderMap_(sh);

  // Resolve all needed columns ONCE using header names / aliases
  var cols = {
    title:      idxOf_(hdr, ['title','activity title','activity']),
    venue:      idxOf_(hdr, ['venue','location']),
    fromDate:   idxOf_(hdr, ['fromdate','from date','start']),
    toDate:     idxOf_(hdr, ['todate','to date','end']),
    template:   idxOf_(hdr, ['certificate template','template']),
    inCharge:   idxOf_(hdr, ['focal-in-charge','focal in charge','in-charge','in charge']),
    timestamp:  idxOf_(hdr, ['timestamp','created at','last updated']),
    givenDate:  idxOf_(hdr, ['given date','date given','givendate','issued','schedule']),
    activityId: idxOf_(hdr, ['activityid','activity id','id'])
    ,region: idxOf_(hdr, ['region','ched region'])
    ,signatoryDesignation: idxOf_(hdr, ['signatory designation','designation'])
    ,signature: idxOf_(hdr, ['e-signature','signature','signature image'])
    ,createdBy: idxOf_(hdr, ['created by','createdby','owner','creator'])
    ,active: idxOf_(hdr, ['active','enabled','status'])
    ,date: idxOf_(hdr, ['date'])
  };

  var values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var out = [];

  // canManage drives whether the UI offers edit / end / delete. Every one of
  // those endpoints re-checks the same rule, so a crafted request cannot
  // bypass a disabled button.
  var actor = safeTrim_(session.email).toLowerCase();
  var isSuperadmin = safeTrim_(session.role).toLowerCase() === 'superadmin';

  for (var i = 0; i < values.length; i++) {
    var obj = _activityRowToObj_(values[i], i + 2, cols);
    obj.canManage = isSuperadmin || (!!obj.createdBy && obj.createdBy === actor);
    out.push(obj);
  }
  return out;
}

/** SAVE (insert or update) an activity row
 * payload: {id?, title, venue, fromDate, toDate, template, inCharge, givenDate, date?, activityId?}
 * - If activityId is blank on insert, we generate one.
 * - On update, if sheet cell is blank, we also generate and write it.
 */
function adminSaveActivity(payload, adminToken) {
  var session = getAdminSession_(adminToken);
  if (!session) throw new Error('Forbidden: administrator authorization required.');

  payload = payload || {};
  var title    = safeTrim_(payload.title);
  var venue    = safeTrim_(payload.venue);
  var fromDate = fmtDate_(payload.fromDate || payload.date);
  var toDate   = fmtDate_(payload.toDate);
  var template = safeTrim_(payload.template);
  var inCharge = safeTrim_(payload.inCharge);
  var givenDate= fmtDate_(payload.givenDate);
  var rowId    = parseInt(String(payload.id || ''), 10);
  var activityId = safeTrim_(payload.activityId);
  var region = safeTrim_(payload.region);
  var signatoryDesignation = safeTrim_(payload.signatoryDesignation);
  var signature = safeTrim_(payload.signature);

  if (!title || !venue || !fromDate || !inCharge || !template || !region || !signatoryDesignation || !signature) {
    throw new Error('Please fill all required activity, region, template, and signatory fields.');
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Activity');
  if (!sh) throw new Error("Sheet 'Activity' not found.");

  // Ensure we have an ActivityID for new rows or blank ones
  if (!activityId) activityId = makeActivityId_();

  var requiredHeaders = ['Region','Signatory Designation','E-Signature','Created By','Active'];
  var hdr = getHeaderMap_(sh);
  requiredHeaders.forEach(function(header){ if(idxOf_(hdr,[header])<0){sh.getRange(1,sh.getLastColumn()+1).setValue(header);hdr=getHeaderMap_(sh);} });
  var lastCol=sh.getLastColumn(), rowValues=new Array(lastCol).fill('');
  if (isFinite(rowId) && rowId >= 2 && rowId <= sh.getLastRow()) {
    // Editing an existing activity is restricted the same way as ending it.
    assertCanManageActivity_(sh, rowId, session, 'edit');
    rowValues=sh.getRange(rowId,1,1,lastCol).getValues()[0];
  }
  function put(names,value){var col=idxOf_(hdr,names);if(col>=0)rowValues[col]=safeSheetValue_(value);}
  put(['title','activity title','activity'],title); put(['venue','location'],venue); put(['fromdate','from date','start'],fromDate); put(['todate','to date','end'],toDate);
  put(['certificate template','template'],template); put(['focal-in-charge','focal in charge','in-charge','in charge'],inCharge); put(['timestamp','created at','last updated'],new Date());
  put(['given date','date given','givendate','issued','schedule'],givenDate); put(['activityid','activity id','id'],activityId); put(['region','ched region'],region);
  put(['signatory designation','designation'],signatoryDesignation); put(['e-signature','signature','signature image'],signature);

  // Ownership is stamped on create and never reassigned while it is set, since
  // it is what adminSetActivityStatus checks. Rows predating this column are
  // blank, so the first administrator to edit one adopts it — harmless, because
  // any administrator can already delete any activity.
  var isUpdate = isFinite(rowId) && rowId >= 2 && rowId <= sh.getLastRow();
  var cCreatedBy = idxOf_(hdr, ['created by','createdby','owner','creator']);
  if (!isUpdate || (cCreatedBy >= 0 && !safeTrim_(rowValues[cCreatedBy]))) {
    put(['created by','createdby','owner','creator'], safeTrim_(session.email).toLowerCase());
  }
  var cActive = idxOf_(hdr, ['active','enabled','status']);
  if (!isUpdate || (cActive >= 0 && !safeTrim_(rowValues[cActive]))) {
    put(['active','enabled','status'], 'TRUE');
  }

  if (isFinite(rowId) && rowId >= 2) {
    // UPDATE existing row
    sh.getRange(rowId, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    // INSERT new row
    sh.appendRow(rowValues);
  }
  invalidatePublicCache_();
  return 'OK';
}

/**
 * Switch an activity on or off.
 *
 * Off means: it disappears from the participant form, submitFeedback refuses it,
 * and the certificate queue stops issuing for it. Already-issued certificates
 * are untouched; responses queued but not yet processed stay PENDING and resume
 * if it is switched back on.
 *
 * Permitted for the administrator named in Created By, or any superadmin.
 */
/**
 * Editing, ending, and deleting an activity are all restricted to the
 * administrator named in Created By, or any superadmin. Returns the row values
 * so callers do not have to read the row twice.
 */
function assertCanManageActivity_(sh, rowId, session, verb) {
  var hdr = getHeaderMap_(sh);
  var row = sh.getRange(rowId, 1, 1, sh.getLastColumn()).getValues()[0];
  var cCreatedBy = idxOf_(hdr, ['created by','createdby','owner','creator']);
  var owner = cCreatedBy >= 0 ? safeTrim_(row[cCreatedBy]).toLowerCase() : '';
  var actor = safeTrim_(session.email).toLowerCase();
  if (safeTrim_(session.role).toLowerCase() === 'superadmin') return { row: row, hdr: hdr };
  if (!owner || owner !== actor)
    throw new Error('Forbidden: only the administrator who created this activity, or a superadmin, can ' + (verb || 'manage') + ' it.');
  return { row: row, hdr: hdr };
}

function adminSetActivityStatus(payload, adminToken) {
  var session = getAdminSession_(adminToken);
  if (!session) throw new Error('Forbidden: administrator authorization required.');

  payload = payload || {};
  var rowId = parseInt(String(payload.id || ''), 10);
  if (!isFinite(rowId) || rowId < 2) throw new Error('Invalid activity row id.');
  var active = payload.active === true || String(payload.active).toLowerCase() === 'true';

  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Activity');
  if (!sh) throw new Error("Sheet 'Activity' not found.");
  if (rowId > sh.getLastRow()) throw new Error('Activity does not exist.');

  var managed = assertCanManageActivity_(sh, rowId, session, active ? 'reopen' : 'end');
  var cActive = idxOf_(managed.hdr, ['active','enabled','status']);
  if (cActive < 0) throw new Error('Activity sheet is missing the Active column. Run setupParticipantFeedbackSheets().');

  sh.getRange(rowId, cActive + 1).setValue(active ? 'TRUE' : 'FALSE');
  invalidatePublicCache_();
  return { id: rowId, active: active };
}

/** DELETE a row by its sheet row index (the "Row" shown in the table) */
function adminDeleteActivity(id, adminToken) {
  var session = getAdminSession_(adminToken);
  if (!session) throw new Error('Forbidden: administrator authorization required.');
  var rowId = parseInt(String(id || ''), 10);
  if (!isFinite(rowId) || rowId < 2) throw new Error('Invalid row id.');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Activity');
  if (!sh) throw new Error("Sheet 'Activity' not found.");

  var lastRow = sh.getLastRow();
  if (rowId > lastRow) throw new Error('Row does not exist.');
  assertCanManageActivity_(sh, rowId, session, 'delete');
  sh.deleteRow(rowId);
  invalidatePublicCache_();
  return 'OK';
}

/**
 * Admin: re-run certificate + email for a given Responses row index.
 * - rowIndex is the sheet row number in the "Responses" sheet (2..n).
 * - Only whitelisted users can call this.
 * - Updates certificate URL, email sent, and cStatus columns.
 * Returns: { status, certificateUrl, emailStatus }
 */
function adminReprocessCertificate(rowIndex) {
  if (ENFORCE_WHITELIST && !isWhitelisted_(getViewerEmail_())) {
    throw new Error('Forbidden: you are not whitelisted.');
  }

  var rowId = parseInt(String(rowIndex || ''), 10);
  if (!isFinite(rowId) || rowId < 2) {
    throw new Error('Invalid Responses row index (must be ≥ 2).');
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Responses');
  if (!sh) throw new Error("Sheet 'Responses' not found.");

  var lastRow = sh.getLastRow();
  if (rowId > lastRow) {
    throw new Error('Responses row ' + rowId + ' does not exist.');
  }

  // Resolve columns once
  var hdr = getHeaderMap_(sh);
  var cEmailSent = idxOf_(hdr, ['email sent','emailsent','email_sent','sent','date emailed']);
  var cCertLink  = idxOf_(hdr, ['certificate','certificate link','cert link','certificate url']);
  var cStatus    = idxOf_(hdr, ['cstatus','status','processing status']);

  try {
    // Mark as PENDING before reprocess (if status column exists)
    if (cStatus >= 0) {
      sh.getRange(rowId, cStatus + 1).setValue('PENDING');
    }

    // Do the heavy work using the existing helper
    var meta = sendCertificateForResponse_(rowId);

    // Update post-processing fields
    if (cCertLink  >= 0) sh.getRange(rowId, cCertLink  + 1).setValue(meta.certificateUrl || '');
    if (cEmailSent >= 0) sh.getRange(rowId, cEmailSent + 1).setValue(meta.emailStatus || 'No recipient email');
    if (cStatus    >= 0) sh.getRange(rowId, cStatus    + 1).setValue('OK');

    return {
      status: 'OK',
      certificateUrl: meta.certificateUrl || '',
      emailStatus: meta.emailStatus || ''
    };
  } catch (e) {
    // Mark as ERROR and bubble up for the admin UI to see
    try {
      if (cStatus >= 0) {
        sh.getRange(rowId, cStatus + 1).setValue('ERROR: ' + e.message);
      }
    } catch (_) {}
    throw e;
  }
}

/** UPLOAD template PPT/PPTX from the admin UI overlay
 * fileObj: { filename, mimeType, base64 }
 * Returns: { id, name, url }
 */
function adminUploadTemplate(fileObj) {
  if (ENFORCE_WHITELIST && !isWhitelisted_(getViewerEmail_())) {
    throw new Error('Forbidden: you are not whitelisted.');
  }
  if (!fileObj || !fileObj.base64 || !fileObj.filename) {
    throw new Error('No file payload.');
  }
  if (fileObj.base64.length > 14000000 || !/\.(ppt|pptx)$/i.test(fileObj.filename)) throw new Error('Certificate templates must be PPT/PPTX files no larger than 10 MB.');

  var folder = assertFolder_(TEMPLATE_FOLDER_ID, 'Template folder');
  var bytes = Utilities.base64Decode(fileObj.base64);
  var blob = Utilities.newBlob(bytes, fileObj.mimeType || 'application/vnd.ms-powerpoint', fileObj.filename);

  var file = folder.createFile(blob);

  return { id: file.getId(), name: file.getName(), url: file.getUrl() };
}

/** Whitelist names for admin dropdown */
function adminGetWhitelistNames() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Whitelist');
  if (!sh) return [];

  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  var hdr = getHeaderMap_(sh);
  var cName = idxOf_(hdr, ['name','full name','whitelist name']);
  if (cName < 0) return [];

  var vals = sh.getRange(2, cName + 1, lastRow - 1, 1).getValues();
  var out = [], seen = {};
  for (var i = 0; i < vals.length; i++) {
    var v = safeTrim_(vals[i][0]);
    if (!v) continue;
    var key = v.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push(v);
  }
  return out;
}

/** Identity flag for admin badge */
function adminWhoAmI() {
  var email = getViewerEmail_(); // blank for anonymous on public deploys
  var authorized = !ENFORCE_WHITELIST || isWhitelisted_(email);
  return { email: email, authorized: authorized };
}

function adminUploadSignature(fileObj, adminToken) {
  if (!isAdminAuthorized_(adminToken)) throw new Error('Forbidden: administrator authorization required.');
  if (!fileObj || !fileObj.base64 || !fileObj.filename || !/^image\/(png|jpeg|webp)$/i.test(String(fileObj.mimeType || '')) || fileObj.base64.length > 2800000) throw new Error('Please upload a PNG, JPG, or WebP signature image no larger than 2 MB.');
  var folder = assertFolder_(TEMPLATE_FOLDER_ID, 'Template folder');
  var blob = Utilities.newBlob(Utilities.base64Decode(fileObj.base64), fileObj.mimeType, fileObj.filename);
  var file = folder.createFile(blob);
  return {id:file.getId(),name:file.getName(),url:file.getUrl()};
}

/** Aggregates participant ratings and certificate queue health for admin charts. */
function adminGetFeedbackAnalytics(activityId, adminToken) {
  if (!isAdminAuthorized_(adminToken)) throw new Error('Forbidden: administrator authorization required.');
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Responses');
  if (!sh || sh.getLastRow() < 2) return { totalResponses:0, averageScore:0, completionRate:0, certificates:{queued:0,processing:0,issued:0,failed:0}, distribution:[0,0,0,0,0], questions:[] };
  var hdr = getHeaderMap_(sh);
  var values = sh.getRange(2,1,sh.getLastRow()-1,sh.getLastColumn()).getValues();
  var statusCol = idxOf_(hdr,['cstatus','status','processing status']);
  var activityCol = idxOf_(hdr,['activityid','activity id','id']);
  var allValues = values;
  var overall = computeScoreSummary_(allValues, hdr);
  if (activityId && activityCol >= 0) values = values.filter(function(row){return safeTrim_(row[activityCol])===safeTrim_(activityId);});
  var questionCols = [];
  for (var q=1;q<=15;q++) questionCols.push(idxOf_(hdr,['answer'+q,'q'+q,'question'+q]));
  var questionTotals = new Array(15).fill(0), questionCounts = new Array(15).fill(0), distribution = [0,0,0,0,0];
  var yesCounts = new Array(15).fill(0), yesNoCounts = new Array(15).fill(0);
  var answeredRows = 0, queue = {queued:0,processing:0,issued:0,failed:0};
  // Long-text answers are not scores: they count toward completion but never
  // toward averages or the 1-5 distribution.
  var questionMeta = questionTypesSafe_();
  values.forEach(function(row){
    var answered = 0;
    questionCols.forEach(function(col,index){
      if(col<0)return;
      var raw=safeTrim_(row[col]);
      if(raw!=='')answered++;
      var qType=normalizeQuestionType_(questionMeta['type'+(index+1)]);
      if(qType==='yesno'&&raw!==''){yesNoCounts[index]++;if(/^y(es)?$/i.test(raw))yesCounts[index]++;}
      var score=Number(row[col]);
      if(score>=1&&score<=5&&qType==='rating'){questionTotals[index]+=score;questionCounts[index]++;distribution[Math.round(score)-1]++;}
    });
    if(answered===15)answeredRows++;
    var status=statusCol>=0?safeTrim_(row[statusCol]).toUpperCase():'';
    if(status==='PENDING')queue.queued++; else if(status==='PROCESSING')queue.processing++; else if(status==='OK')queue.issued++; else if(status.indexOf('ERROR')===0)queue.failed++;
  });
  var totalScore=questionTotals.reduce(function(a,b){return a+b;},0), totalAnswers=questionCounts.reduce(function(a,b){return a+b;},0);
  var average=totalAnswers?Number((totalScore/totalAnswers).toFixed(2)):0;
  return {scope:activityId||'all',totalResponses:values.length,averageScore:average,overallAverage:overall.averageScore,overallResponses:allValues.length,scoreDelta:Number((average-overall.averageScore).toFixed(2)),completionRate:values.length?Number((answeredRows/values.length*100).toFixed(1)):0,certificateIssueRate:values.length?Number((queue.issued/values.length*100).toFixed(1)):0,positiveRate:totalAnswers?Number(((distribution[3]+distribution[4])/totalAnswers*100).toFixed(1)):0,certificates:queue,distribution:distribution,questions:questionTotals.map(function(total,index){var type=normalizeQuestionType_(questionMeta['type'+(index+1)]);return{label:'Question '+(index+1),type:type,responses:type==='yesno'?yesNoCounts[index]:questionCounts[index],average:questionCounts[index]?Number((total/questionCounts[index]).toFixed(2)):0,yesRate:yesNoCounts[index]?Number((yesCounts[index]/yesNoCounts[index]*100).toFixed(1)):0};})};
}

function computeScoreSummary_(values,hdr){var total=0,count=0,meta=questionTypesSafe_();for(var q=1;q<=15;q++){var col=idxOf_(hdr,['answer'+q,'q'+q,'question'+q]);if(col<0)continue;if(normalizeQuestionType_(meta['type'+q])!=='rating')continue;values.forEach(function(row){var score=Number(row[col]);if(score>=1&&score<=5){total+=score;count++;}});}return{averageScore:count?Number((total/count).toFixed(2)):0};}

function isAdminAuthorized_(adminToken) { return !!getAdminSession_(adminToken); }

function requireSuperadmin_(adminToken) {
  var session = getAdminSession_(adminToken);
  if (!session) throw new Error('Forbidden: administrator authorization required.');
  if (safeTrim_(session.role).toLowerCase() !== 'superadmin') throw new Error('Forbidden: superadmin access required.');
  return session;
}

function ensureWhitelistSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName('Whitelist');
  var headers = ['user_id','name','role','email','active','created_at','updated_at'];
  if (!sh) sh = ss.insertSheet('Whitelist');
  var existing = getHeaderMap_(sh);
  headers.forEach(function(header){
    if (!(header in existing)) {
      var col = sh.getLastColumn() + 1;
      sh.getRange(1, col).setValue(header);
      existing[header] = col - 1;
    }
  });
  return sh;
}

function findRowByEmail_(sheet, email) {
  if (sheet.getLastRow() < 2) return 0;
  var hdr = getHeaderMap_(sheet), col = idxOf_(hdr, ['email','e-mail']);
  if (col < 0) return 0;
  var values = sheet.getRange(2, col + 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) if (safeTrim_(values[i][0]).toLowerCase() === email) return i + 2;
  return 0;
}

function upsertWhitelistUser_(user) {
  var sh = ensureWhitelistSheet_(), hdr = getHeaderMap_(sh), row = findRowByEmail_(sh, user.email), now = new Date();
  var existing = row ? sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0] : [];
  var createdCol = idxOf_(hdr, ['created_at']);
  var values = {
    user_id: user.user_id || (row ? safeTrim_(existing[idxOf_(hdr,['user_id'])]) : '') || ('U-' + Utilities.getUuid().replace(/-/g,'').slice(0,8)),
    name: user.name,
    role: user.role,
    email: user.email,
    active: user.active,
    created_at: (row && createdCol >= 0 && existing[createdCol]) || now,
    updated_at: now
  };
  if (!row) row = Math.max(2, sh.getLastRow() + 1);
  Object.keys(values).forEach(function(key){sh.getRange(row, hdr[key] + 1).setValue(safeSheetValue_(values[key]));});
  return values;
}

function syncCredentialMetadata_(user) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Users'), row = sh ? findRowByEmail_(sh, user.email) : 0;
  if (!sh || !row) throw new Error('A password is required when creating a new user.');
  var hdr = getHeaderMap_(sh), updates = {name:user.name, role:user.role, active:user.active};
  Object.keys(updates).forEach(function(key){var col=idxOf_(hdr,[key]);if(col>=0)sh.getRange(row,col+1).setValue(safeSheetValue_(updates[key]));});
}

function adminGetUsers(adminToken) {
  requireSuperadmin_(adminToken);
  var sh = ensureWhitelistSheet_();
  if (sh.getLastRow() < 2) return [];
  var hdr = getHeaderMap_(sh), rows = sh.getRange(2,1,sh.getLastRow()-1,sh.getLastColumn()).getValues();
  return rows.filter(function(row){return safeTrim_(row[idxOf_(hdr,['email'])]);}).map(function(row){
    return {user_id:safeTrim_(row[idxOf_(hdr,['user_id'])]),name:safeTrim_(row[idxOf_(hdr,['name'])]),role:safeTrim_(row[idxOf_(hdr,['role'])]),email:safeTrim_(row[idxOf_(hdr,['email'])]),active:String(row[idxOf_(hdr,['active'])]).toLowerCase()!=='false',created_at:fmtDate_(row[idxOf_(hdr,['created_at'])]),updated_at:fmtDate_(row[idxOf_(hdr,['updated_at'])])};
  });
}

function adminSaveUser(payload, adminToken) {
  var session = requireSuperadmin_(adminToken), email = safeTrim_(payload.email).toLowerCase(), name = safeTrim_(payload.name), role = safeTrim_(payload.role).toLowerCase();
  var active = payload.active !== false && String(payload.active).toLowerCase() !== 'false', password = String(payload.password || '');
  if (!name) throw new Error('Name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid email is required.');
  if (['admin','superadmin'].indexOf(role) < 0) throw new Error('Role must be admin or superadmin.');
  if (session.email === email && (role !== 'superadmin' || !active)) throw new Error('You cannot demote or deactivate your own superadmin account.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('User management is busy. Please try again.');
  try {
    var existing = findRowByEmail_(ensureWhitelistSheet_(), email);
    if (!existing && password.length < 12) throw new Error('New users require a password of at least 12 characters.');
    if (password && password.length < 12) throw new Error('Passwords must contain at least 12 characters.');
    if (password) seedUser(email, password, name, role, active); else syncCredentialMetadata_({email:email,name:name,role:role,active:active});
    return upsertWhitelistUser_({user_id:safeTrim_(payload.user_id),name:name,role:role,email:email,active:active});
  } finally { lock.releaseLock(); }
}

function adminGetQuestions(adminToken) {
  requireSuperadmin_(adminToken);
  ensureQuestionsSheet_();
  var data = getQuestions(), out = [];
  for (var i=1;i<=15;i++) out.push({ text: safeTrim_(data['question'+i]), type: normalizeQuestionType_(data['type'+i]) });
  return out;
}

function adminSaveQuestions(questions, adminToken) {
  requireSuperadmin_(adminToken);
  if (!Array.isArray(questions) || questions.length !== 15) throw new Error('Exactly 15 questions are required.');
  // Accepts [{text, type}] and, for older clients, plain strings.
  questions = questions.map(function(question){
    var isObject = question && typeof question === 'object';
    return {
      text: safeTrim_(isObject ? question.text : question),
      type: normalizeQuestionType_(isObject ? question.type : 'rating')
    };
  });
  if (questions.some(function(question){return !question.text;})) throw new Error('Questions cannot be blank.');
  if (questions.some(function(question){return QUESTION_TYPES.indexOf(question.type) < 0;})) throw new Error('Question type must be rating or text.');
  var sh = ensureQuestionsSheet_(), lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Question management is busy. Please try again.');
  try {
    sh.getRange(2,1,1,30).setValues([
      questions.map(function(question){return safeSheetValue_(question.text);})
        .concat(questions.map(function(question){return safeSheetValue_(question.type);}))
    ]);
  } finally { lock.releaseLock(); }
  invalidatePublicCache_();
  return questions;
}

/** Supported answer formats. 'rating' is the 1-5 scale. */
var QUESTION_TYPES = ['rating','text','yesno'];

/**
 * Question types for analytics. Never throws: a missing or unreadable
 * Questions sheet must not take down the whole dashboard, so it falls back to
 * treating every question as a rating.
 */
function questionTypesSafe_() {
  try {
    return getQuestions();
  } catch (ignored) {
    var out = {};
    for (var i = 1; i <= 15; i++) out['type' + i] = 'rating';
    return out;
  }
}

function normalizeQuestionType_(value) {
  var raw = safeTrim_(value).toLowerCase();
  if (raw === 'text' || raw === 'long text' || raw === 'longtext' || raw === 'essay') return 'text';
  if (raw === 'yesno' || raw === 'yes/no' || raw === 'yes-no' || raw === 'yn' || raw === 'boolean') return 'yesno';
  return 'rating';
}

function ensureQuestionsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName('Questions');
  if (!sh) sh = ss.insertSheet('Questions');
  // A new sheet has 26 columns, and older Questions sheets have 15. Writing a
  // 30-column range without widening first throws "dimensions of the range
  // are invalid".
  var maxColumns = sh.getMaxColumns();
  if (maxColumns < 30) sh.insertColumnsAfter(maxColumns, 30 - maxColumns);
  var headers=[];
  for(var i=1;i<=15;i++)headers.push('question'+i);
  for(var t=1;t<=15;t++)headers.push('type'+t);
  sh.getRange(1,1,1,30).setValues([headers]);
  return sh;
}

// ----------------------- Admin credentials & sessions -----------------------
function seedUsers() {
  // Edit these values before running this function once from the Apps Script editor.
  var users = [
    { email:'host@example.com', password:'CHANGE_THIS_PASSWORD', name:'Portal Host', role:'superadmin' }
  ];
  if (users.some(function(user){return user.password === 'CHANGE_THIS_PASSWORD';})) throw new Error('Edit seedUsers() and replace CHANGE_THIS_PASSWORD before running it.');
  return users.map(function(user){return seedUser(user.email,user.password,user.name,user.role);});
}

function seedUser(email, password, displayName, role, active) {
  email=safeTrim_(email).toLowerCase(); password=String(password||''); displayName=safeTrim_(displayName); role=safeTrim_(role||'admin').toLowerCase(); active=active !== false;
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('A valid user email is required.');
  if(password.length<12)throw new Error('Admin passwords must contain at least 12 characters.');
  var ss=SpreadsheetApp.getActiveSpreadsheet(),setup=ensureSetupSheet_(ss,'Users',[
    setupColumn_('Email'),setupColumn_('PasswordHash',['password hash']),setupColumn_('Salt'),
    setupColumn_('Name',['display name']),setupColumn_('Role'),setupColumn_('Active'),setupColumn_('CreatedAt',['created at'])
  ]),sh=setup.sheet,hdr=getHeaderMap_(sh),row=findRowByEmail_(sh,email);
  var salt=Utilities.getUuid()+Utilities.getUuid(),hash=hashAdminPassword_(password,salt),lastCol=sh.getLastColumn();
  var values=row?sh.getRange(row,1,1,lastCol).getValues()[0]:new Array(lastCol).fill('');
  function put(names,value){var col=idxOf_(hdr,names);if(col>=0)values[col]=safeSheetValue_(value);}
  put(['email'],email);put(['passwordhash','password hash'],hash);put(['salt'],salt);put(['name','display name'],displayName||email);
  put(['role'],role);put(['active'],active);if(!row)put(['createdat','created at'],new Date());
  if(row)sh.getRange(row,1,1,lastCol).setValues([values]);else sh.appendRow(values);
  upsertWhitelistUser_({name:displayName||email,role:role,email:email,active:active});
  return {email:email,name:displayName||email,role:role};
}

function adminLogin(email,password) {
  email=safeTrim_(email).toLowerCase(); password=String(password||'');
  var throttleKey=adminLoginThrottleKey_(email),cache=CacheService.getScriptCache(),attempts=Number(cache.get(throttleKey)||0);
  if(attempts>=5)throw new Error('Too many sign-in attempts. Try again in 15 minutes.');
  cache.put(throttleKey,String(attempts+1),900);
  var sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Users');
  if(!sh||sh.getLastRow()<2)throw new Error('Invalid email or password.');
  var hdr=getHeaderMap_(sh),rows=sh.getRange(2,1,sh.getLastRow()-1,sh.getLastColumn()).getValues();
  var cEmail=idxOf_(hdr,['email']),cHash=idxOf_(hdr,['passwordhash','password hash']),cSalt=idxOf_(hdr,['salt']),cName=idxOf_(hdr,['name','display name']),cRole=idxOf_(hdr,['role']),cActive=idxOf_(hdr,['active']);
  var match=null;for(var i=0;i<rows.length;i++)if(safeTrim_(rows[i][cEmail]).toLowerCase()===email){match=rows[i];break;}
  if(!match||String(match[cActive]).toLowerCase()==='false'||!constantTimeEquals_(hashAdminPassword_(password,match[cSalt]),safeTrim_(match[cHash])))throw new Error('Invalid email or password.');
  cache.remove(throttleKey);
  var token=Utilities.getUuid().replace(/-/g,'')+Utilities.getUuid().replace(/-/g,''),session={email:email,name:safeTrim_(match[cName])||email,role:safeTrim_(match[cRole])||'admin',expiresAt:Date.now()+21600000};
  var key=adminSessionKey_(token),json=JSON.stringify(session);CacheService.getScriptCache().put(key,json,21600);PropertiesService.getScriptProperties().setProperty(key,json);
  return {token:token,user:{email:session.email,name:session.name,role:session.role},expiresAt:session.expiresAt};
}

function adminValidateSession(token){var session=getAdminSession_(token);if(!session)throw new Error('Your admin session has expired.');return{user:{email:session.email,name:session.name,role:session.role},expiresAt:session.expiresAt};}
function adminLogout(token){var key=adminSessionKey_(token);CacheService.getScriptCache().remove(key);PropertiesService.getScriptProperties().deleteProperty(key);return true;}
function getAdminSession_(token){
  token=safeTrim_(token);if(!token)return null;
  var key=adminSessionKey_(token),cache=CacheService.getScriptCache(),json=cache.get(key)||PropertiesService.getScriptProperties().getProperty(key);
  if(!json)return null;
  try{
    var storedJson=json,session=JSON.parse(json);
    if(!session.expiresAt||session.expiresAt<Date.now()){adminLogout(token);return null;}
    var current=getCredentialUser_(session.email);
    if(!current||!current.active){adminLogout(token);return null;}
    session.name=current.name;session.role=current.role;
    json=JSON.stringify(session);
    cache.put(key,json,Math.min(21600,Math.max(1,Math.floor((session.expiresAt-Date.now())/1000))));
    if(json!==storedJson)PropertiesService.getScriptProperties().setProperty(key,json);
    return session;
  }catch(_){return null;}
}
function getCredentialUser_(email){
  email=safeTrim_(email).toLowerCase();
  var sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Users');
  if(!sh||sh.getLastRow()<2)return null;
  var hdr=getHeaderMap_(sh),row=findRowByEmail_(sh,email);
  if(!row)return null;
  var values=sh.getRange(row,1,1,sh.getLastColumn()).getValues()[0],cName=idxOf_(hdr,['name','display name']),cRole=idxOf_(hdr,['role']),cActive=idxOf_(hdr,['active']);
  return {email:email,name:cName>=0?safeTrim_(values[cName])||email:email,role:cRole>=0?safeTrim_(values[cRole]).toLowerCase()||'admin':'admin',active:cActive<0||String(values[cActive]).toLowerCase()!=='false'};
}
function adminSessionKey_(token){var secret=PropertiesService.getScriptProperties().getProperty('SESSION_HASH_SECRET');if(!secret)throw new Error('Session security is not configured. Run setupParticipantFeedbackSecurity().');return'ADMIN_SESSION_'+hmac256Base64_(String(token||''),secret);}
function adminLoginThrottleKey_(email){var digest=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(email||'unknown'),Utilities.Charset.UTF_8);return'LOGIN_ATTEMPTS_'+Utilities.base64EncodeWebSafe(digest).replace(/=+$/,'').slice(0,32);}
function hashAdminPassword_(password,salt){var value=String(salt||'')+'|'+String(password||'');for(var i=0;i<12000;i++){var digest=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value,Utilities.Charset.UTF_8);value=Utilities.base64EncodeWebSafe(digest);}return value;}
function constantTimeEquals_(a,b){a=String(a||'');b=String(b||'');var diff=a.length^b.length,len=Math.max(a.length,b.length);for(var i=0;i<len;i++)diff|=(a.charCodeAt(i%Math.max(1,a.length))||0)^(b.charCodeAt(i%Math.max(1,b.length))||0);return diff===0;}

// =====================================================================
// Staging cleanup — remove test data before going live
//
// Deliberately NOT routed through doPost. These functions are run by hand
// from the Apps Script editor, so no HTTP request can ever trigger them.
//
// Usage:
//   1. previewTestingDataReset()  → counts only, changes nothing
//   2. resetTestingData(RESET_CONFIRMATION_PHRASE)          → default scope
//      resetTestingData(RESET_CONFIRMATION_PHRASE, {...})   → custom scope
//
// Never touched: Users/Whitelist (you would lock yourself out), Questions,
// the Activity sheet unless you opt in, and the security secrets.
// =====================================================================

var RESET_CONFIRMATION_PHRASE = 'RESET PARTICIPANT FEEDBACK TEST DATA';

/** Rows below the header, or 0 for an empty/missing sheet. */
function dataRowCount_(sheetName) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sh) return 0;
  return Math.max(0, sh.getLastRow() - 1);
}

function clearSheetRows_(sheetName) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sh) return 0;
  var rows = sh.getLastRow() - 1;
  if (rows < 1) return 0;
  sh.deleteRows(2, rows);
  return rows;
}

/** Count of files in the generated-certificates folder. */
function certificateFileCount_() {
  try {
    var files = DriveApp.getFolderById(CERTIFICATES_FOLDER_ID).getFiles(), n = 0;
    while (files.hasNext()) { files.next(); n++; }
    return n;
  } catch (error) {
    return -1; // folder missing or inaccessible
  }
}

/**
 * Read-only. Run this first and read it carefully — it is exactly what
 * resetTestingData() will remove.
 */
function previewTestingDataReset() {
  var properties = PropertiesService.getScriptProperties().getProperties();
  var sessions = Object.keys(properties).filter(function(key){ return key.indexOf('ADMIN_SESSION_') === 0; }).length;
  var summary = {
    mode: 'PREVIEW — nothing has been changed',
    responses: dataRowCount_('Responses'),
    activities: dataRowCount_('Activity'),
    auditEntries: dataRowCount_('Audit'),
    certificateFiles: certificateFileCount_(),
    adminSessions: sessions,
    defaultScope: 'responses + certificates + sessions (activities and audit log are kept unless you opt in)',
    toProceed: "resetTestingData('" + RESET_CONFIRMATION_PHRASE + "')"
  };
  Logger.log(JSON.stringify(summary, null, 2));
  return summary;
}

/**
 * Delete staging data. Requires the exact confirmation phrase.
 *
 * options (all optional):
 *   responses    default true   clear every row of the Responses sheet
 *   certificates default true   move generated certificate PDFs to Drive trash
 *   sessions     default true   sign out every administrator
 *   activities   default false  clear the Activity sheet as well
 *   auditLog     default false  clear the Audit sheet and reset its hash chain
 *
 * Certificates are trashed, not purged, so Drive's trash is a 30-day undo.
 */
function resetTestingData(confirmation, options) {
  if (safeTrim_(confirmation) !== RESET_CONFIRMATION_PHRASE)
    throw new Error(
      'Refusing to delete anything. Run previewTestingDataReset() first, then call ' +
      "resetTestingData('" + RESET_CONFIRMATION_PHRASE + "')."
    );

  options = options || {};
  var doResponses = options.responses !== false;
  var doCertificates = options.certificates !== false;
  var doSessions = options.sessions !== false;
  var doActivities = options.activities === true;
  var doAuditLog = options.auditLog === true;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('The script is busy. Try again in a moment.');

  var result = { startedAt: new Date().toISOString(), responses: 0, activities: 0, auditEntries: 0, certificatesTrashed: 0, certificatesRemaining: 0, adminSessions: 0 };
  try {
    if (doResponses) result.responses = clearSheetRows_('Responses');
    if (doActivities) result.activities = clearSheetRows_('Activity');

    if (doCertificates) {
      try {
        var startedAt = Date.now();
        var files = DriveApp.getFolderById(CERTIFICATES_FOLDER_ID).getFiles();
        while (files.hasNext()) {
          if (Date.now() - startedAt > CERTIFICATE_RUN_BUDGET_MS) {
            // Ran out of execution time; report what is left and run again.
            while (files.hasNext()) { files.next(); result.certificatesRemaining++; }
            break;
          }
          files.next().setTrashed(true);
          result.certificatesTrashed++;
        }
      } catch (driveError) {
        result.certificateError = String(driveError.message || driveError);
      }
    }

    var properties = PropertiesService.getScriptProperties();
    if (doSessions) {
      var sessionKeys = Object.keys(properties.getProperties()).filter(function(key){
        return key.indexOf('ADMIN_SESSION_') === 0;
      });
      sessionKeys.forEach(function(key){ properties.deleteProperty(key); });
      if (sessionKeys.length) CacheService.getScriptCache().removeAll(sessionKeys);
      result.adminSessions = sessionKeys.length;
    }

    if (doAuditLog) {
      result.auditEntries = clearSheetRows_('Audit');
      // The chain head must go too, or adminGetAuditLog reports tampering
      // because the stored head no longer matches an empty sheet.
      properties.deleteProperty('AUDIT_HEAD_HASH');
    }

    invalidatePublicCache_();
    result.finishedAt = new Date().toISOString();
    result.note = result.certificatesRemaining
      ? 'Execution time ran out. Run resetTestingData again to trash the remaining certificates.'
      : 'Done. Certificates are in Drive trash and recoverable for 30 days.';
    Logger.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

function __authCheck2() {
  var out = {};
  try { out.rootWrite = DriveApp.createFile(Utilities.newBlob('x','text/plain','__ac.txt')).getId(); }
  catch (e) { out.rootWrite = 'FAIL: ' + e.message; }
  try { out.folderName = DriveApp.getFolderById(TEMPLATE_FOLDER_ID).getName(); }
  catch (e) { out.folderName = 'FAIL: ' + e.message; }
  try { out.folderWrite = DriveApp.getFolderById(TEMPLATE_FOLDER_ID)
          .createFile(Utilities.newBlob('x','text/plain','__ac.txt')).getId(); }
  catch (e) { out.folderWrite = 'FAIL: ' + e.message; }
  out.user = Session.getEffectiveUser().getEmail();
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}
/**
 * Read-only. Explains WHY the audit chain reports a mismatch, instead of
 * leaving "a row may have been edited" as the only hypothesis.
 *
 * Reports the first failing row and separates the three real causes:
 *   - every row fails            → AUDIT_HASH_SECRET changed or was overwritten
 *   - only some rows fail        → those rows were edited/deleted, OR their
 *                                  timestamp was reformatted by Sheets
 *   - rows verify but head fails → the last entries were deleted
 */
function auditChainDiagnose() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('AUDIT_HASH_SECRET') || '';
  var expectedHead = props.getProperty('AUDIT_HEAD_HASH') || '';
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Audit');
  var out = { rows: 0, hashFailures: 0, linkFailures: 0, firstBadRow: 0, secretPresent: !!secret, headMatches: true, timestampReformatted: false, samples: [] };
  if (!sh || sh.getLastRow() < 2) { out.verdict = 'Audit log is empty.'; Logger.log(JSON.stringify(out, null, 2)); return out; }

  var hdr = getHeaderMap_(sh);
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getDisplayValues();
  out.rows = rows.length;
  var previous = null;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    function cell(name){ return name in hdr ? safeTrim_(row[hdr[name]]) : ''; }
    var entry = {timestamp:cell('timestamp'),audit_id:cell('audit_id'),actor_email:cell('actor_email'),actor_role:cell('actor_role'),action:cell('action'),target_type:cell('target_type'),target_id:cell('target_id'),outcome:cell('outcome'),details:cell('details'),request_id:cell('request_id'),previous_hash:cell('previous_hash'),entry_hash:cell('entry_hash')};

    // A timestamp Sheets has reformatted no longer looks like what was hashed.
    if (entry.timestamp && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(entry.timestamp)) {
      out.timestampReformatted = true;
      if (out.samples.length < 3) out.samples.push({ row: i + 2, timestamp: entry.timestamp });
    }

    var hashOk = secret && constantTimeEquals_(hmac256Base64_(auditCanonical_(entry), secret), entry.entry_hash);
    if (!hashOk) { out.hashFailures++; if (!out.firstBadRow) out.firstBadRow = i + 2; }
    if (previous !== null && entry.previous_hash !== previous) { out.linkFailures++; if (!out.firstBadRow) out.firstBadRow = i + 2; }
    previous = entry.entry_hash;
  }
  out.headMatches = !expectedHead || previous === expectedHead;

  out.verdict = !secret
    ? 'AUDIT_HASH_SECRET is missing. Nothing can be verified. It is set by setupParticipantFeedbackSheets().'
    : out.timestampReformatted
      ? 'Timestamps were reformatted by Google Sheets, so their hashes cannot match. This is a formatting artifact, NOT tampering. ensureAuditSheet_() now pins the column to plain text; clear the log once (resetTestingData with auditLog:true) and future rows will verify.'
      : out.hashFailures === out.rows
        ? 'Every row fails: AUDIT_HASH_SECRET changed after these rows were written.'
        : out.hashFailures || out.linkFailures
          ? 'Some rows fail starting at sheet row ' + out.firstBadRow + '. Those rows were edited or deleted directly in Sheets.'
          : out.headMatches ? 'Chain is intact.' : 'Rows verify but the head does not: the most recent entries were deleted.';
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * Certificate email. Built with tables and inline styles because Gmail,
 * Outlook and most mobile clients strip <style> blocks and ignore flexbox.
 * Every interpolated value is escaped: the participant's name and the activity
 * title are user-supplied.
 */
function buildCertificateEmail_(data) {
  data = data || {};
  var name = safeTrim_(data.name);
  var title = safeTrim_(data.title);
  var venue = safeTrim_(data.venue);
  var dateRange = safeTrim_(data.dateRange);
  var certificateUrl = safeTrim_(data.certificateUrl);
  var code = safeTrim_(data.verificationCode);
  var verifyUrl = safeTrim_(data.verificationUrl);
  // submitFeedback rejects a blank name, but this is outbound mail: a fallback
  // costs nothing and "Dear ," reaching a participant would not be recoverable.
  var firstName = name.split(' ')[0] || name || 'Participant';

  var whenWhere = dateRange ? (' held ' + dateRange) : '';
  if (venue) whenWhere += (whenWhere ? ' at ' : ' held at ') + venue;

  var subject = 'Your certificate for ' + title;

  var text =
    'Dear ' + firstName + ',\n\n' +
    'Thank you for taking part in ' + title + whenWhere + ', and for sharing your feedback.\n\n' +
    'Your Certificate of Participation is ready:\n' + certificateUrl + '\n\n' +
    'Verification code: ' + code + '\n' +
    'Anyone can confirm this certificate is genuine at:\n' + verifyUrl + '\n\n' +
    'Please keep this email for your records.\n\n' +
    'Office of Student Development and Services\n' +
    'Commission on Higher Education';

  var html =
    '<div style="margin:0;padding:24px 12px;background:#f5f7f2;font-family:Arial,Helvetica,sans-serif;">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #dfe7e1;border-radius:14px;overflow:hidden;">' +
        '<tr><td style="background:#0b4b3c;padding:20px 28px;">' +
          '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
            '<td style="padding-right:12px;"><img src="https://ik.imagekit.io/k2qmtccm6/CHED-cropped-logo100x100.png" width="40" height="40" alt="CHED" style="display:block;border:0;"></td>' +
            '<td style="color:#ffffff;font-size:14px;font-weight:bold;line-height:1.3;">Commission on Higher Education' +
              '<div style="color:#b9d1c9;font-size:11px;font-weight:normal;">Office of Student Development and Services</div>' +
            '</td>' +
          '</tr></table>' +
        '</td></tr>' +
        '<tr><td style="padding:30px 28px 8px;">' +
          '<div style="text-transform:uppercase;letter-spacing:.12em;font-size:11px;font-weight:bold;color:#36836c;">Certificate of Participation</div>' +
          '<h1 style="margin:10px 0 0;font-size:22px;line-height:1.25;color:#143f34;">Your certificate is ready</h1>' +
        '</td></tr>' +
        '<tr><td style="padding:14px 28px 0;color:#3c4f49;font-size:14px;line-height:1.65;">' +
          '<p style="margin:0 0 14px;">Dear ' + escapeHtml_(firstName) + ',</p>' +
          '<p style="margin:0 0 14px;">Thank you for taking part in <strong style="color:#143f34;">' + escapeHtml_(title) + '</strong>' + escapeHtml_(whenWhere) + ', and for sharing your feedback.</p>' +
        '</td></tr>' +
        '<tr><td style="padding:12px 28px 4px;">' +
          '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#0b4b3c;border-radius:10px;">' +
            '<a href="' + escapeHtml_(certificateUrl) + '" style="display:inline-block;padding:13px 26px;color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;">Open your certificate (PDF)</a>' +
          '</td></tr></table>' +
        '</td></tr>' +
        '<tr><td style="padding:20px 28px 4px;">' +
          '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f1f7f0;border:1px solid #dce9da;border-radius:10px;">' +
            '<tr><td style="padding:14px 16px;font-size:13px;color:#3c4f49;line-height:1.6;">' +
              '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#6d7f79;font-weight:bold;">Verification code</div>' +
              '<div style="font-family:Consolas,Menlo,monospace;font-size:15px;color:#143f34;font-weight:bold;padding:4px 0;">' + escapeHtml_(code) + '</div>' +
              '<a href="' + escapeHtml_(verifyUrl) + '" style="color:#0b4b3c;font-size:12px;">Confirm this certificate is genuine</a>' +
            '</td></tr>' +
          '</table>' +
        '</td></tr>' +
        '<tr><td style="padding:18px 28px 26px;color:#6d7f79;font-size:12px;line-height:1.6;">' +
          '<p style="margin:0 0 6px;">Please keep this email for your records. If the button does not work, copy this link:<br>' +
            '<span style="color:#3c4f49;word-break:break-all;">' + escapeHtml_(certificateUrl) + '</span></p>' +
        '</td></tr>' +
        '<tr><td style="background:#f8faf7;border-top:1px solid #edf0ed;padding:16px 28px;color:#6d7f79;font-size:11px;line-height:1.5;">' +
          'Office of Student Development and Services<br>Commission on Higher Education' +
        '</td></tr>' +
      '</table>' +
    '</div>';

  return { subject: subject, text: text, html: html };
}
