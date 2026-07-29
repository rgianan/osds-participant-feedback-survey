/** Code.gs — Survey + Admin server (dedupe, validations, admin endpoints)
 * Deploy: Web app → Execute as "Me", Who has access "Anyone" (or your domain)
 */

// --------------------------- Switches / Folder IDs ---------------------------
var ENFORCE_WHITELIST = true; // gate /?admin behind Whitelist

// Folder for certificate templates (Google Slides preferred; PPT/PPTX will be converted)
var TEMPLATE_FOLDER_ID = '1p621gez5fInaAywXdy7vqoyqQfQctlkY';
// Folder where generated certificate PDFs will be stored
var CERTIFICATES_FOLDER_ID = '1wvfjg33QkmO_WkRsDJuW5QTMBWCJ-8T8';

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
  try {
    var raw = (e && e.postData && e.postData.contents) || '{}';
    if (raw.length > 6000000) throw new Error('Request payload is too large.');
    var body = JSON.parse(raw);
    var action = safeTrim_(body.action);
    var data;

    if (action === 'getActivityData') data = getActivityData();
    else if (action === 'getQuestions') data = getQuestions();
    else if (action === 'submitFeedback') data = submitFeedback(body.payload || body);
    else if (action === 'adminLogin') data = adminLogin(body.email, body.password);
    else if (action === 'adminValidateSession') data = adminValidateSession(body.adminToken);
    else if (action === 'adminLogout') data = adminLogout(body.adminToken);
    else if (action === 'adminGetActivities') data = adminGetActivities(body.adminToken);
    else if (action === 'adminSaveActivity') data = adminSaveActivity(body.payload || {}, body.adminToken);
    else if (action === 'adminDeleteActivity') data = adminDeleteActivity(body.id || (body.payload && body.payload.id), body.adminToken);
    else if (action === 'adminUploadSignature') data = adminUploadSignature(body.payload || {}, body.adminToken);
    else if (action === 'adminGetFeedbackAnalytics') data = adminGetFeedbackAnalytics(body.activityId, body.adminToken);
    else if (action === 'adminGetUsers') data = adminGetUsers(body.adminToken);
    else if (action === 'adminSaveUser') data = adminSaveUser(body.payload || {}, body.adminToken);
    else if (action === 'adminGetQuestions') data = adminGetQuestions(body.adminToken);
    else if (action === 'adminSaveQuestions') data = adminSaveQuestions(body.questions || (body.payload && body.payload.questions) || [], body.adminToken);
    else throw new Error('Unknown action: ' + action);

    return jsonResponse_({ ok: true, data: data });
  } catch (error) {
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
      setupColumn_('E-Signature', ['signature','signature image'])
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
    var questions = ensureSetupSheet_(ss, 'Questions', questionColumns);
    var questionSheet = questions.sheet;
    if (questionSheet.getLastRow() < 2 || questionSheet.getRange(2,1,1,15).getDisplayValues()[0].every(function(value){return !safeTrim_(value);})) {
      questionSheet.getRange(2,1,1,15).setValues([defaultQuestions]);
      questions.seeded = true;
    }

    var whitelist = ensureSetupSheet_(ss, 'Whitelist', [
      setupColumn_('user_id'), setupColumn_('name'), setupColumn_('role'), setupColumn_('email', ['e-mail']),
      setupColumn_('active', ['enabled']), setupColumn_('created_at'), setupColumn_('updated_at')
    ]);
    var users = ensureSetupSheet_(ss, 'Users', [
      setupColumn_('Email'), setupColumn_('PasswordHash', ['password hash']), setupColumn_('Salt'),
      setupColumn_('Name', ['display name']), setupColumn_('Role'), setupColumn_('Active'), setupColumn_('CreatedAt', ['created at'])
    ]);

    return {
      status: 'OK',
      spreadsheetUrl: ss.getUrl(),
      sheets: [activity, responses, questions, whitelist, users].map(function(result){
        return {name:result.sheet.getName(),created:result.created,headersAdded:result.headersAdded,seeded:!!result.seeded};
      }),
      nextStep: 'Edit the host account in seedUsers(), run seedUsers(), then run setupCertificateQueueTrigger().'
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
function getActivityData() {
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

  var out = [];
  rows.forEach(function(r){
    var title = cTitle >= 0 ? safeTrim_(r[cTitle]) : '';
    if (!title) return;

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

  return out;
}

// ----------------- Public: load 15 questions for survey --------------
/** Returns question1..question15 from 'Questions' (row 2) */
function getQuestions() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Questions');
  if (!sh) throw new Error("Sheet 'Questions' not found.");

  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  var out = {};
  for (var i = 1; i <= 15; i++) out['question' + i] = '';
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
  }
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

    // Prepare to write row using header map (resilient to order)
    var hdrMap = getHeaderMap_(sh);
    var lastCol = sh.getLastColumn();
    nextRow = sh.getLastRow() + 1;

    // Start with an empty row array (preserve existing width)
    var rowArr = new Array(lastCol).fill('');

    function setCol_(names, value){
      var c = idxOf_(hdrMap, names);
      if (c >= 0) rowArr[c] = value;
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
      setCol_(['answer'+i, 'q'+i, 'question'+i], safeTrim_(formData['answer'+i] || formData['question'+i] || ''));
    }

    setCol_(['takeaways','key takeaways','most valuable takeaway'], safeTrim_(formData.takeaways || ''));
    setCol_(['suggestions','recommendations','improvements'], safeTrim_(formData.suggestions || ''));

    // Email sent / Certificate link / cStatus — initialized here
    setCol_(['email sent','emailsent','email_sent','sent','date emailed'], '');
    setCol_(['certificate','certificate link','cert link','certificate url'], '');
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
    var queueRows = [];
    for (var i = 0; i < values.length && queueRows.length < Math.min(CERTIFICATE_BATCH_SIZE, remainingMail); i++) {
      if (safeTrim_(values[i][cStatus]).toUpperCase() === 'PENDING') queueRows.push(i + 2);
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
    return { status: 'OK', processed: processed, failed: failed, queued: queueRows.length - processed - failed };
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
  pres.replaceAllText('{{Name}}', name);
  pres.replaceAllText('{{Title}}', aTitle);
  if (aVenue) pres.replaceAllText('{{Venue}}', aVenue);
  if (aDate)  pres.replaceAllText('{{Date}}', aDate);
  if (aFrom)  pres.replaceAllText('{{FromDate}}', aFrom);
  if (aTo)    pres.replaceAllText('{{ToDate}}', aTo);
  if (aGiven) pres.replaceAllText('{{GivenDate}}', aGiven);
  if (aSignatory) pres.replaceAllText('{{Signatory}}', aSignatory);
  if (aDesignation) pres.replaceAllText('{{Designation}}', aDesignation);
  if (aSignature) replaceSignaturePlaceholder_(pres, aSignature);
  pres.saveAndClose();

  // --- Export to PDF, store, and share ---
  var pdfBlob = driveExportFileAsPdf_(slidesId);
  pdfBlob.setName('Certificate - ' + name + ' - ' + aTitle + '.pdf');

  var pdfFile = certFolder.createFile(pdfBlob);
  try {
    // Choose policy: ANYONE_WITH_LINK or DOMAIN_WITH_LINK
    pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    // pdfFile.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (_){}
  var certUrl = pdfFile.getUrl();

  // --- Email link (no attachment) ---
  var emailStatus = '';
  if (email) {
    var tz = Session.getScriptTimeZone() || 'UTC';
    var sentAt = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');
    var subject = 'Certificate: ' + aTitle;

    var bodyText =
      'Dear ' + name + ',\n\n' +
      'Your certificate for "' + aTitle + '" is ready:\n' + certUrl + '\n\n' +
      'Thank you.';
    var bodyHtml =
      '<p>Dear ' + escapeHtml_(name) + ',</p>' +
      '<p>Your certificate for "<b>' + escapeHtml_(aTitle) + '</b>" is ready:</p>' +
      '<p><a href="' + escapeHtml_(certUrl) + '">Open certificate (PDF)</a></p>' +
      '<p>Thank you.</p>';

    MailApp.sendEmail({
      to: email,
      subject: subject,
      body: bodyText,
      htmlBody: bodyHtml,
      name: 'Certificates'
    });

    emailStatus = sentAt;
  } else {
    emailStatus = 'No recipient email';
  }

  return { certificateUrl: certUrl, emailStatus: emailStatus };
}

function replaceSignaturePlaceholder_(presentation, signatureUrl) {
  var signature = parseAndAssertFile_(signatureUrl, 'E-signature').file.getBlob();
  presentation.getSlides().forEach(function(slide){
    slide.getShapes().forEach(function(shape){
      try {
        if(shape.getText().asString().indexOf('{{Signature}}')<0)return;
        var left=shape.getLeft(),top=shape.getTop(),width=shape.getWidth(),height=shape.getHeight();
        shape.remove(); slide.insertImage(signature,left,top,width,height);
      } catch (_) {}
    });
  });
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
    activityId: safeTrim_(cell(cols.activityId))
  };
}

/** GET: list activities for admin table (header-based, column-order safe) */
function adminGetActivities(adminToken) {
  if (!isAdminAuthorized_(adminToken)) throw new Error('Forbidden: administrator authorization required.');

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
  };

  var values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var out = [];

  for (var i = 0; i < values.length; i++) {
    out.push(_activityRowToObj_(values[i], i + 2, cols));
  }
  return out;
}

/** SAVE (insert or update) an activity row
 * payload: {id?, title, venue, fromDate, toDate, template, inCharge, givenDate, date?, activityId?}
 * - If activityId is blank on insert, we generate one.
 * - On update, if sheet cell is blank, we also generate and write it.
 */
function adminSaveActivity(payload, adminToken) {
  if (!isAdminAuthorized_(adminToken)) throw new Error('Forbidden: administrator authorization required.');

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

  var requiredHeaders = ['Region','Signatory Designation','E-Signature'];
  var hdr = getHeaderMap_(sh);
  requiredHeaders.forEach(function(header){ if(idxOf_(hdr,[header])<0){sh.getRange(1,sh.getLastColumn()+1).setValue(header);hdr=getHeaderMap_(sh);} });
  var lastCol=sh.getLastColumn(), rowValues=new Array(lastCol).fill('');
  if (isFinite(rowId) && rowId >= 2 && rowId <= sh.getLastRow()) rowValues=sh.getRange(rowId,1,1,lastCol).getValues()[0];
  function put(names,value){var col=idxOf_(hdr,names);if(col>=0)rowValues[col]=value;}
  put(['title','activity title','activity'],title); put(['venue','location'],venue); put(['fromdate','from date','start'],fromDate); put(['todate','to date','end'],toDate);
  put(['certificate template','template'],template); put(['focal-in-charge','focal in charge','in-charge','in charge'],inCharge); put(['timestamp','created at','last updated'],new Date());
  put(['given date','date given','givendate','issued','schedule'],givenDate); put(['activityid','activity id','id'],activityId); put(['region','ched region'],region);
  put(['signatory designation','designation'],signatoryDesignation); put(['e-signature','signature','signature image'],signature);

  if (isFinite(rowId) && rowId >= 2) {
    // UPDATE existing row
    sh.getRange(rowId, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    // INSERT new row
    sh.appendRow(rowValues);
  }
  return 'OK';
}

/** DELETE a row by its sheet row index (the "Row" shown in the table) */
function adminDeleteActivity(id, adminToken) {
  if (!isAdminAuthorized_(adminToken)) throw new Error('Forbidden: administrator authorization required.');
  var rowId = parseInt(String(id || ''), 10);
  if (!isFinite(rowId) || rowId < 2) throw new Error('Invalid row id.');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Activity');
  if (!sh) throw new Error("Sheet 'Activity' not found.");

  var lastRow = sh.getLastRow();
  if (rowId > lastRow) throw new Error('Row does not exist.');
  sh.deleteRow(rowId);
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
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (_){}

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
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (_) {}
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
  var answeredRows = 0, queue = {queued:0,processing:0,issued:0,failed:0};
  values.forEach(function(row){
    var answered = 0;
    questionCols.forEach(function(col,index){
      if(col<0)return; var score=Number(row[col]);
      if(score>=1&&score<=5){questionTotals[index]+=score;questionCounts[index]++;distribution[Math.round(score)-1]++;answered++;}
    });
    if(answered===15)answeredRows++;
    var status=statusCol>=0?safeTrim_(row[statusCol]).toUpperCase():'';
    if(status==='PENDING')queue.queued++; else if(status==='PROCESSING')queue.processing++; else if(status==='OK')queue.issued++; else if(status.indexOf('ERROR')===0)queue.failed++;
  });
  var totalScore=questionTotals.reduce(function(a,b){return a+b;},0), totalAnswers=questionCounts.reduce(function(a,b){return a+b;},0);
  var average=totalAnswers?Number((totalScore/totalAnswers).toFixed(2)):0;
  return {scope:activityId||'all',totalResponses:values.length,averageScore:average,overallAverage:overall.averageScore,overallResponses:allValues.length,scoreDelta:Number((average-overall.averageScore).toFixed(2)),completionRate:values.length?Number((answeredRows/values.length*100).toFixed(1)):0,certificateIssueRate:values.length?Number((queue.issued/values.length*100).toFixed(1)):0,positiveRate:totalAnswers?Number(((distribution[3]+distribution[4])/totalAnswers*100).toFixed(1)):0,certificates:queue,distribution:distribution,questions:questionTotals.map(function(total,index){return{label:'Question '+(index+1),average:questionCounts[index]?Number((total/questionCounts[index]).toFixed(2)):0};})};
}

function computeScoreSummary_(values,hdr){var total=0,count=0;for(var q=1;q<=15;q++){var col=idxOf_(hdr,['answer'+q,'q'+q,'question'+q]);if(col<0)continue;values.forEach(function(row){var score=Number(row[col]);if(score>=1&&score<=5){total+=score;count++;}});}return{averageScore:count?Number((total/count).toFixed(2)):0};}

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
  Object.keys(values).forEach(function(key){sh.getRange(row, hdr[key] + 1).setValue(values[key]);});
  return values;
}

function syncCredentialMetadata_(user) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Users'), row = sh ? findRowByEmail_(sh, user.email) : 0;
  if (!sh || !row) throw new Error('A password is required when creating a new user.');
  var hdr = getHeaderMap_(sh), updates = {name:user.name, role:user.role, active:user.active};
  Object.keys(updates).forEach(function(key){var col=idxOf_(hdr,[key]);if(col>=0)sh.getRange(row,col+1).setValue(updates[key]);});
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
  for (var i=1;i<=15;i++) out.push(safeTrim_(data['question'+i]));
  return out;
}

function adminSaveQuestions(questions, adminToken) {
  requireSuperadmin_(adminToken);
  if (!Array.isArray(questions) || questions.length !== 15) throw new Error('Exactly 15 questions are required.');
  questions = questions.map(function(question){return safeTrim_(question);});
  if (questions.some(function(question){return !question;})) throw new Error('Questions cannot be blank.');
  var sh = ensureQuestionsSheet_(), lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Question management is busy. Please try again.');
  try { sh.getRange(2,1,1,15).setValues([questions]); } finally { lock.releaseLock(); }
  return questions;
}

function ensureQuestionsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName('Questions');
  if (!sh) sh = ss.insertSheet('Questions');
  var headers=[];for(var i=1;i<=15;i++)headers.push('question'+i);
  sh.getRange(1,1,1,15).setValues([headers]);
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
  function put(names,value){var col=idxOf_(hdr,names);if(col>=0)values[col]=value;}
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
function adminSessionKey_(token){var digest=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(token||''),Utilities.Charset.UTF_8);return'ADMIN_SESSION_'+Utilities.base64EncodeWebSafe(digest).replace(/=+$/,'');}
function adminLoginThrottleKey_(email){var digest=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(email||'unknown'),Utilities.Charset.UTF_8);return'LOGIN_ATTEMPTS_'+Utilities.base64EncodeWebSafe(digest).replace(/=+$/,'').slice(0,32);}
function hashAdminPassword_(password,salt){var value=String(salt||'')+'|'+String(password||'');for(var i=0;i<12000;i++){var digest=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value,Utilities.Charset.UTF_8);value=Utilities.base64EncodeWebSafe(digest);}return value;}
function constantTimeEquals_(a,b){a=String(a||'');b=String(b||'');var diff=a.length^b.length,len=Math.max(a.length,b.length);for(var i=0;i<len;i++)diff|=(a.charCodeAt(i%Math.max(1,a.length))||0)^(b.charCodeAt(i%Math.max(1,b.length))||0);return diff===0;}
