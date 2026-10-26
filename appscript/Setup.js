/**
 * JOBVERSE MVP - Setup.gs
 * Run setupJobverse() once from the editor. It is safe to run again; it only
 * creates what is missing. The container Sheet becomes the entire database.
 */

var JV = {
  SHEETS: {
    Candidates: [
      'CandidateID', 'CreatedAt', 'Status', 'Active', 'TargetApplications', 'FullName', 'Email', 'ApplicationEmail', 'ApplicationPassword', 'Phone',
      'Address', 'MaritalStatus', 'Nationality', 'Gender', 'DateOfBirth', 'Location',
      'RightToWork', 'VisaStatus', 'VisaExpiry', 'NINumber', 'DrivingLicence', 'MinSalary',
      'PreferredRoles', 'PreferredIndustries', 'PreferredLocations', 'WillingToRelocate',
      'WorkModel', 'EmploymentType', 'NoticePeriod', 'Registrations', 'LinkedIn', 'GitHub',
      'Portfolio', 'References', 'CVFileID', 'CertificateFileIDs', 'DriveFolderID',
      'AIProfileJSON', 'Strengths', 'Weaknesses', 'Notes',
      'NHSUnspentConvictions', 'NHSFitnessToPractice', 'NHSDisabilityGIS',
      'NHSEthnicity', 'NHSReligion', 'NHSSexualOrientation', 'NHSSocioEconomicBackground'
    ],
    FollowUps: [
      'FollowUpID', 'CreatedAt', 'CandidateID', 'ApplicationID', 'Type', 'Company', 'JobTitle',
      'DueDate', 'Status', 'Notes'
    ],
    Jobs: [
      'JobID', 'CreatedAt', 'CandidateID', 'Company', 'JobTitle', 'JobURL', 'ATS',
      'Location', 'Salary', 'ExperienceLevel', 'RequiredSkills', 'PreferredSkills',
      'ATSKeywords', 'Responsibilities', 'LikelyQuestions', 'SuitabilityScore',
      'AnalysisJSON', 'Status'
    ],
    CVVersions: [
      'VersionID', 'CreatedAt', 'CandidateID', 'JobID', 'DocURL', 'DocID',
      'ReviewScore', 'ReviewStatus', 'ReviewerNotes', 'ToneProfile'
    ],
    CoverLetters: [
      'LetterID', 'CreatedAt', 'CandidateID', 'JobID', 'DocURL', 'DocID',
      'ReviewScore', 'ReviewStatus', 'ReviewerNotes', 'ToneProfile'
    ],
    NHSStatements: [
      'StatementID', 'CreatedAt', 'CandidateID', 'JobID', 'DocURL', 'DocID',
      'ReviewScore', 'ReviewStatus', 'ReviewerNotes', 'ToneProfile'
    ],
    Applications: [
      'ApplicationID', 'CreatedAt', 'CandidateID', 'JobID', 'Company', 'JobTitle',
      'JobURL', 'ATS', 'Status', 'DedupeHash', 'CVVersionID', 'LetterID',
      'SubmittedAt', 'ConfirmationScreenshotURL', 'RecruiterEmail', 'Outcome',
      'InterviewDate', 'ErrorLog', 'FilledBy'
    ],
    Prospects: [
      'ProspectID', 'FoundAt', 'CandidateID', 'Company', 'JobTitle', 'JobURL',
      'Source', 'Status', 'Notes'
    ],
    ReviewQueue: [
      'TaskID', 'CreatedAt', 'Type', 'CandidateID', 'JobID', 'RefID', 'Summary',
      'AIScore', 'AIFindings', 'Status', 'Reviewer', 'DecidedAt', 'Decision', 'Notes', 'RevisedAs'
    ],
    ToneProfiles: ['ProfileName', 'Description', 'StyleInstructions'],
    AIOutputs: ['OutputID', 'CreatedAt', 'Agent', 'CandidateID', 'JobID', 'Model', 'OutputJSON'],
    ActivityLog: ['Timestamp', 'Actor', 'Action', 'RefType', 'RefID', 'Detail'],
    Reports: ['GeneratedAt', 'Period', 'MetricsJSON', 'Summary'],
    Config: ['Key', 'Value', 'Notes'],
    // Per-candidate, per-site accounts created for sign-in walls (Workday,
    // iCIMS, career portals...). ATSDomain is the actual site hostname (e.g.
    // acmecorp.wd5.myworkdayjobs.com), never just "Workday" - each employer's
    // instance is a separate account. Status: 'Pending', 'Created',
    // 'Blocked-CAPTCHA', 'Blocked-EmailVerification', 'LoginFailed', 'Failed'.
    // Each account's random password lives in Script Properties
    // (PLATFORM_PW_<AccountID>), never in this sheet - see Api.gs.
    PlatformAccounts: [
      'AccountID', 'CreatedAt', 'CandidateID', 'ATSDomain', 'Email', 'LoginURL', 'Status', 'Notes', 'UpdatedAt'
    ]
  },

  CONFIG_DEFAULTS: [
    ['FORM_ID', '', 'ID of the client Google Form. Then run installFormTrigger().'],
    ['ROOT_FOLDER_ID', '', 'Filled automatically by setup.'],
    ['API_TOKEN', '', 'Filled automatically. Shared secret for the Chrome extension.'],
    ['DASHBOARD_KEY', '', 'Filled automatically. Open the console as <web app URL>?key=<this value>. Change it to revoke old links.'],
    ['DASHBOARD_EMAILS', '', 'Comma separated Google accounts that can open the console without the key (Workspace accounts only - Google hides the email of other viewers). Blank = only the deploying account.'],
    ['ANTHROPIC_MODEL', 'claude-sonnet-4-6', 'Model used by all agents.'],
    ['DEFAULT_TONE', 'Jobverse Standard', 'Tone profile applied unless overridden.'],
    ['CV_TEMPLATE', 'Classic', 'CV layout: Classic (the agency format - black serif, centred header, ruled sections; used for any value except ATS Simple) or ATS Simple (plain single column).'],
    ['CV_FONT', 'Lato', 'Font used by the ATS Simple CV layout (any Google Docs font, e.g. Lato, Roboto, Arial). Classic always uses Source Serif Pro.'],
    ['CV_ACCENT_COLOR', '#1F4E79', 'Hex accent colour for the ATS Simple CV layout. Classic is black and white.'],
    ['REPORT_EMAILS', '', 'Comma separated emails for daily report.'],
    ['MAX_APPS_PER_CANDIDATE_PER_DAY', '15', 'Safety throttle: max applications started per candidate per day.'],
    ['ACCOUNT_REVEAL_EMAILS', '', 'Comma separated Google accounts allowed to reveal saved job-site passwords in the dashboard. Blank = only the deploying account.'],
    ['DEFAULT_TARGET_APPLICATIONS', '50', 'Default total application goal assigned to each new candidate. Editable per candidate in the dashboard.'],
    ['REVIEW_REQUIRED', 'TRUE', 'If TRUE, extension will not submit without an approved review task.'],
    ['ADZUNA_APP_ID', '', 'Free at developer.adzuna.com. Needed for the Prospect Finder (Prospects.gs).'],
    ['ADZUNA_APP_KEY', '', 'Free at developer.adzuna.com.'],
    ['ADZUNA_COUNTRY', 'gb', 'Comma separated Adzuna country codes: gb, us, ca, au, etc. Each is queried separately and merged (Adzuna has no single global endpoint).'],
    ['ADZUNA_RESULTS_PER_CANDIDATE', '15', 'Max results fetched PER COUNTRY per search run (so 3 countries = up to 3x this many before de-duplication).'],
    ['REED_API_KEY', '', 'Free at reed.co.uk/developers. UK-only source for the Prospect Finder.'],
    ['RAPIDAPI_KEY', '', 'Free/metered at rapidapi.com, subscribe to the JSearch API. Broader global coverage for the Prospect Finder.'],
    ['PROSPECT_SOURCES', 'adzuna,reed,jsearch,nhs,workable,myjobmag', 'Comma separated sources to search: adzuna, reed, jsearch (Google for Jobs - brings in LinkedIn, Indeed, Glassdoor, Civil Service Jobs, Jobberman listings), remotive, nhs (NHS Jobs, incl. Trac-run vacancies), jobbank (Canada Job Bank, Canada-wide), workable, myjobmag (Nigeria). A source with no key set is skipped silently.'],
    ['NHS_TRAC_FOLLOWUP_DEFAULT_DAYS', '14', 'If the vacancy closing date cannot be found on the NHS Jobs page, the Trac follow-up is scheduled this many days out instead.'],
    ['FOLLOWUP_DAYS_AFTER_SUBMIT', '7', 'Every submitted application gets a follow-up (chase the employer) due this many days after submission.']
  ],

  TONE_DEFAULTS: [
    ['Jobverse Standard', 'Default agency voice',
     'British English. Confident, warm, plain. Short sentences. No cliches such as "team player" or "passionate". Every claim must be backed by evidence from the profile. No em dashes or en dashes anywhere.'],
    ['NHS', 'NHS and public health roles',
     'British English. Values led. Reference NHS values (care, compassion, respect) where evidenced. Formal but human. Address person specification points directly. No em dashes or en dashes.'],
    ['Corporate', 'Finance, consulting, large enterprise',
     'British English. Results first. Quantify outcomes. Formal register, active voice. No em dashes or en dashes.'],
    ['Technical', 'Engineering and data roles',
     'British English. Precise, concrete. Name technologies exactly as the JD does. Lead with systems built and measurable impact. No buzzwords. No em dashes or en dashes.'],
    ['Executive', 'Senior leadership',
     'British English. Strategic scope, P&L, headcount, transformation outcomes. Measured, authoritative. No em dashes or en dashes.'],
    ['Graduate', 'Entry level and graduate schemes',
     'British English. Enthusiastic but grounded. Emphasise projects, placements, coursework and transferable skills. No em dashes or en dashes.']
  ]
};

function setupJobverse() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(JV.SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(JV.SHEETS[name]);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, JV.SHEETS[name].length).setFontWeight('bold');
    } else {
      var existingHeaders = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
      var existingSet = {};
      existingHeaders.forEach(function (h) { if (h) existingSet[h] = true; });
      var missing = JV.SHEETS[name].filter(function (h) { return !existingSet[h]; });
      if (missing.length) {
        var startCol = sh.getLastColumn() + 1;
        sh.getRange(1, startCol, 1, missing.length).setValues([missing]);
        sh.getRange(1, startCol, 1, missing.length).setFontWeight('bold');
        try { logActivity_('system', 'schema_migrated', 'sheet', name, 'Added: ' + missing.join(', ')); } catch (ignored) {}
      }
    }
  });
  var s1 = ss.getSheetByName('Sheet1');
  if (s1 && ss.getSheets().length > 1) ss.deleteSheet(s1);


  var cfg = ss.getSheetByName('Config');
  var existingKeys = cfg.getLastRow() > 1
    ? cfg.getRange(2, 1, cfg.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; })
    : [];
  JV.CONFIG_DEFAULTS.forEach(function (row) {
    if (existingKeys.indexOf(row[0]) === -1) cfg.appendRow(row);
  });

  var tones = ss.getSheetByName('ToneProfiles');
  if (tones.getLastRow() < 2) JV.TONE_DEFAULTS.forEach(function (r) { tones.appendRow(r); });

  if (!getConfig_('ROOT_FOLDER_ID')) {
    var root = DriveApp.createFolder('Jobverse Platform');
    root.createFolder('Candidates');
    root.createFolder('Generated CVs');
    root.createFolder('Cover Letters');
    root.createFolder('Screenshots');
    root.createFolder('Reports');
    setConfig_('ROOT_FOLDER_ID', root.getId());
  }

  if (!getConfig_('API_TOKEN')) {
    setConfig_('API_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  }
  if (!getConfig_('DASHBOARD_KEY')) {
    setConfig_('DASHBOARD_KEY', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  }

  ensureTrigger_('runDailyReport', function (b) { return b.timeBased().atHour(7).everyDays(1).create(); });
  ensureTrigger_('findProspectsForAllCandidates', function (b) { return b.timeBased().atHour(6).everyDays(1).create(); });
  ensureTrigger_('sendDueFollowUpReminders', function (b) { return b.timeBased().atHour(7).nearMinute(30).everyDays(1).create(); });
  // Fallback for sent-back documents - normally dashDecide schedules a run within seconds (Revisions.gs)
  ensureTrigger_('processRevisionQueue', function (b) { return b.timeBased().everyMinutes(10).create(); });

  logActivity_('system', 'setup', 'system', '-', 'Setup completed');
  var msg = 'Jobverse setup complete. Next: 1) run createJobverseForm() or paste an existing Form ID into ' +
    'Config > FORM_ID, then run installFormTrigger(). 2) Set ANTHROPIC_API_KEY in Script properties. ' +
    '3) Deploy > New deployment > Web app, and copy the URL into the Chrome extension options. ' +
    '4) Open the console at <web app URL>?key=<Config > DASHBOARD_KEY>.';
  Logger.log(msg);
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'Setup complete - check Execution log or ActivityLog tab for next steps.', 'Jobverse', 20
    );
  } catch (ignored) { /* toast is best-effort, never block on it */ }
}

function installFormTrigger() {
  var formId = getConfig_('FORM_ID');
  if (!formId) throw new Error('Set Config > FORM_ID first.');
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'onFormSubmit';
  });
  if (!exists) {
    ScriptApp.newTrigger('onFormSubmit').forForm(FormApp.openById(formId)).onFormSubmit().create();
  }
  logActivity_('system', 'trigger_installed', 'form', formId, 'Form submit trigger active');
}

function ensureTrigger_(fnName, builderFn) {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === fnName;
  });
  if (!exists) builderFn(ScriptApp.newTrigger(fnName));
}

/* ------------------------- shared helpers ------------------------- */

/*
 * Per-execution caches. Each google.script.run call / doPost / trigger is a
 * fresh execution, so these never go stale across requests - they only stop
 * the same execution re-reading the Config tab and header rows over and over
 * (every read is a round-trip to Sheets, and they add up to seconds).
 */
var SHEET_CACHE_ = {}, HEADER_CACHE_ = {}, CONFIG_CACHE_ = null;

function sheet_(name) {
  if (!SHEET_CACHE_[name]) SHEET_CACHE_[name] = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  return SHEET_CACHE_[name];
}

function getConfig_(key) {
  if (!CONFIG_CACHE_) {
    CONFIG_CACHE_ = {};
    var sh = sheet_('Config');
    if (sh && sh.getLastRow() >= 2) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
        if (r[0] !== '' && !(r[0] in CONFIG_CACHE_)) CONFIG_CACHE_[r[0]] = String(r[1]);
      });
    }
  }
  return CONFIG_CACHE_[key] || '';
}

function setConfig_(key, value) {
  var sh = sheet_('Config');
  CONFIG_CACHE_ = null;
  var data = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 1).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === key) { sh.getRange(i + 2, 2).setValue(value); return; }
  }
  sh.appendRow([key, value, '']);
}

function newId_(prefix) {
  return prefix + '-' + Utilities.formatDate(new Date(), 'GMT', 'yyMMdd') + '-' +
    Math.random().toString(36).slice(2, 8).toUpperCase();
}

function logActivity_(actor, action, refType, refId, detail) {
  sheet_('ActivityLog').appendRow([new Date(), actor, action, refType, refId, detail || '']);
}

function getHeaderMap_(sh) {
  var key = sh.getSheetId();
  if (HEADER_CACHE_[key]) return HEADER_CACHE_[key];
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var headerRow = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  headerRow.forEach(function (h, i) { if (h) map[h] = i + 1; });
  HEADER_CACHE_[key] = map;
  return map;
}

/** Drops a cached header map after columns are added to a sheet. */
function clearHeaderCache_(sh) {
  delete HEADER_CACHE_[sh.getSheetId()];
}

/**
 * All data rows as objects keyed by header. Pass `cols` (header names) to
 * read only those columns - much faster on tabs with big JSON columns
 * (AIProfileJSON, AIFindings, AnalysisJSON) the caller doesn't need.
 */
function readRows_(name, cols) {
  var sh = sheet_(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var map = getHeaderMap_(sh);
  var n = sh.getLastRow() - 1;
  var wanted = (cols || Object.keys(map)).filter(function (h) { return map[h]; });
  var out = [];
  for (var i = 0; i < n; i++) out.push({ _row: i + 2 });

  // Read the wanted columns as a few contiguous blocks rather than the whole sheet,
  // never stretching a block over a big column nobody asked for
  var avoid = HEAVY_COLS_.filter(function (h) { return map[h] && wanted.indexOf(h) === -1; })
    .map(function (h) { return map[h]; });
  colRuns_(wanted.map(function (h) { return map[h]; }), avoid).forEach(function (run) {
    var values = sh.getRange(2, run[0], n, run[1] - run[0] + 1).getValues();
    wanted.forEach(function (h) {
      var c = map[h];
      if (c < run[0] || c > run[1]) return;
      for (var i = 0; i < n; i++) out[i][h] = values[i][c - run[0]];
    });
  });
  return out;
}

/** Columns that can hold tens of KB per row - only read when asked for by name. */
var HEAVY_COLS_ = ['AIFindings', 'AIProfileJSON', 'AnalysisJSON', 'OutputJSON', 'MetricsJSON', 'ErrorLog'];

/**
 * Groups column numbers into [from, to] ranges, merging small gaps (cheaper
 * to over-read than to make another call) unless a gap holds an `avoid` column.
 */
function colRuns_(colNums, avoid) {
  var sorted = colNums.slice().sort(function (a, b) { return a - b; });
  var runs = [];
  sorted.forEach(function (c) {
    var last = runs[runs.length - 1];
    var gapIsCheap = last && c - last[1] <= 8 && !(avoid || []).some(function (a) { return a > last[1] && a < c; });
    if (gapIsCheap) last[1] = Math.max(last[1], c);
    else runs.push([c, c]);
  });
  return runs;
}

/**
 * The row whose idField equals idValue, or null. Scans only the ID column,
 * then reads just the matching row (newest match first - IDs are unique, and
 * recent rows are the ones usually looked up).
 */
function findRow_(name, idField, idValue) {
  var sh = sheet_(name);
  if (!sh || sh.getLastRow() < 2) return null;
  var map = getHeaderMap_(sh);
  if (!map[idField]) return null;
  var ids = sh.getRange(2, map[idField], sh.getLastRow() - 1, 1).getValues();
  var target = String(idValue);
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]) !== target) continue;
    var row = sh.getRange(i + 2, 1, 1, sh.getLastColumn()).getValues()[0];
    var o = { _row: i + 2 };
    Object.keys(map).forEach(function (h) { o[h] = row[map[h] - 1]; });
    return o;
  }
  return null;
}

function appendObject_(name, obj) {
  var sh = sheet_(name);
  var map = getHeaderMap_(sh);
  var lastCol = Math.max(sh.getLastColumn(), Object.keys(map).length);
  var row = new Array(lastCol).fill('');
  Object.keys(obj).forEach(function (k) {
    if (map[k]) row[map[k] - 1] = obj[k];
  });
  sh.appendRow(row);
}

function updateRow_(name, rowNumber, patch) {
  var sh = sheet_(name);
  var map = getHeaderMap_(sh);
  Object.keys(patch).forEach(function (k) {
    if (map[k]) sh.getRange(rowNumber, map[k]).setValue(patch[k]);
  });
}

/** Sets one column to `value` on many rows at once (e.g. bulk status changes). */
function setColumnForRows_(name, field, rowNumbers, value) {
  if (!rowNumbers.length) return;
  var sh = sheet_(name);
  var col = getHeaderMap_(sh)[field];
  if (!col) return;
  sh.getRangeList(rowNumbers.map(function (r) { return sh.getRange(r, col).getA1Notation(); })).setValue(value);
}

function deleteRowsWhere_(name, idField, idValue) {
  var sh = sheet_(name);
  if (sh.getLastRow() < 2) return 0;
  var map = getHeaderMap_(sh);
  var col = map[idField];
  if (!col) return 0;
  var values = sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues();
  var rowsToDelete = [];
  values.forEach(function (r, i) {
    if (String(r[0]) === String(idValue)) rowsToDelete.push(i + 2);
  });
  rowsToDelete.sort(function (a, b) { return b - a; });
  rowsToDelete.forEach(function (rowNum) { sh.deleteRow(rowNum); });
  return rowsToDelete.length;
}
