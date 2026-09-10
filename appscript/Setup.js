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
      // NHS declaration answers - filled in by the candidate themselves (via the
      // dashboard or a supplementary form), NEVER guessed or defaulted by AI.
      // Blank means "not yet provided" and the extension will flag it for a
      // human rather than fill it.
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
      'InterviewDate', 'ErrorLog'
    ],
    Prospects: [
      'ProspectID', 'FoundAt', 'CandidateID', 'Company', 'JobTitle', 'JobURL',
      'Source', 'Status', 'Notes'
    ],
    ReviewQueue: [
      'TaskID', 'CreatedAt', 'Type', 'CandidateID', 'JobID', 'RefID', 'Summary',
      'AIScore', 'AIFindings', 'Status', 'Reviewer', 'DecidedAt', 'Decision', 'Notes'
    ],
    ToneProfiles: ['ProfileName', 'Description', 'StyleInstructions'],
    AIOutputs: ['OutputID', 'CreatedAt', 'Agent', 'CandidateID', 'JobID', 'Model', 'OutputJSON'],
    ActivityLog: ['Timestamp', 'Actor', 'Action', 'RefType', 'RefID', 'Detail'],
    Reports: ['GeneratedAt', 'Period', 'MetricsJSON', 'Summary'],
    Config: ['Key', 'Value', 'Notes']
  },

  CONFIG_DEFAULTS: [
    ['FORM_ID', '', 'ID of the client Google Form. Then run installFormTrigger().'],
    ['ROOT_FOLDER_ID', '', 'Filled automatically by setup.'],
    ['API_TOKEN', '', 'Filled automatically. Shared secret for the Chrome extension.'],
    ['ANTHROPIC_MODEL', 'claude-sonnet-4-6', 'Model used by all agents.'],
    ['DEFAULT_TONE', 'Jobverse Standard', 'Tone profile applied unless overridden.'],
    ['REPORT_EMAILS', '', 'Comma separated emails for daily report.'],
    ['MAX_APPS_PER_CANDIDATE_PER_DAY', '15', 'Safety throttle: max applications started per candidate per day.'],
    ['DEFAULT_TARGET_APPLICATIONS', '50', 'Default total application goal assigned to each new candidate. Editable per candidate in the dashboard.'],
    ['REVIEW_REQUIRED', 'TRUE', 'If TRUE, extension will not submit without an approved review task.'],
    ['ADZUNA_APP_ID', '', 'Free at developer.adzuna.com. Needed for the Prospect Finder (Prospects.gs).'],
    ['ADZUNA_APP_KEY', '', 'Free at developer.adzuna.com.'],
    ['ADZUNA_COUNTRY', 'gb', 'Comma separated Adzuna country codes: gb, us, ca, au, etc. Each is queried separately and merged (Adzuna has no single global endpoint).'],
    ['ADZUNA_RESULTS_PER_CANDIDATE', '15', 'Max results fetched PER COUNTRY per search run (so 3 countries = up to 3x this many before de-duplication).'],
    ['REED_API_KEY', '', 'Free at reed.co.uk/developers. UK-only source for the Prospect Finder.'],
    ['RAPIDAPI_KEY', '', 'Free/metered at rapidapi.com, subscribe to the JSearch API. Broader global coverage for the Prospect Finder.'],
    ['PROSPECT_SOURCES', 'adzuna,reed,jsearch', 'Comma separated list of sources to use. A source with no key set is skipped silently.'],
    ['NHS_TRAC_FOLLOWUP_DEFAULT_DAYS', '14', 'If the vacancy closing date cannot be found on the NHS Jobs page, the Trac follow-up is scheduled this many days out instead.']
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

  // 1. Tabs
  Object.keys(JV.SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(JV.SHEETS[name]);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, JV.SHEETS[name].length).setFontWeight('bold');
    } else {
      // Migration for sheets that already have data: add any columns the
      // current schema expects but this sheet doesn't have yet, appended to
      // the right of whatever's already there. Existing headers, existing
      // column order, and existing row data are never touched or moved.
      var existingHeaders = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
      var existingSet = {};
      existingHeaders.forEach(function (h) { if (h) existingSet[h] = true; });
      var missing = JV.SHEETS[name].filter(function (h) { return !existingSet[h]; });
      if (missing.length) {
        var startCol = sh.getLastColumn() + 1;
        sh.getRange(1, startCol, 1, missing.length).setValues([missing]);
        sh.getRange(1, startCol, 1, missing.length).setFontWeight('bold');
        try { logActivity('system', 'schema_migrated', 'sheet', name, 'Added: ' + missing.join(', ')); } catch (ignored) {}
      }
    }
  });
  var s1 = ss.getSheetByName('Sheet1');
  if (s1 && ss.getSheets().length > 1) ss.deleteSheet(s1);


  // 2. Config defaults
  var cfg = ss.getSheetByName('Config');
  var existingKeys = cfg.getLastRow() > 1
    ? cfg.getRange(2, 1, cfg.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; })
    : [];
  JV.CONFIG_DEFAULTS.forEach(function (row) {
    if (existingKeys.indexOf(row[0]) === -1) cfg.appendRow(row);
  });

  // 3. Tone profiles
  var tones = ss.getSheetByName('ToneProfiles');
  if (tones.getLastRow() < 2) JV.TONE_DEFAULTS.forEach(function (r) { tones.appendRow(r); });

  // 4. Drive folders
  if (!getConfig('ROOT_FOLDER_ID')) {
    var root = DriveApp.createFolder('Jobverse Platform');
    root.createFolder('Candidates');
    root.createFolder('Generated CVs');
    root.createFolder('Cover Letters');
    root.createFolder('Screenshots');
    root.createFolder('Reports');
    setConfig('ROOT_FOLDER_ID', root.getId());
  }

  // 5. API token for the extension
  if (!getConfig('API_TOKEN')) {
    setConfig('API_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  }

  // 6. Daily report trigger at 07:00
  ensureTrigger_('runDailyReport', function (b) { return b.timeBased().atHour(7).everyDays(1).create(); });

  // Daily prospect refresh at 06:00 (before the 07:00 report). Only adds new
  // matches not already in the sheet, and skips inactive candidates.
  ensureTrigger_('findProspectsForAllCandidates', function (b) { return b.timeBased().atHour(6).everyDays(1).create(); });

  // Daily follow-up reminder at 07:30, between the prospect refresh and the report.
  ensureTrigger_('sendDueFollowUpReminders', function (b) { return b.timeBased().atHour(7).nearMinute(30).everyDays(1).create(); });

  logActivity('system', 'setup', 'system', '-', 'Setup completed');
  var msg = 'Jobverse setup complete. Next: 1) run createJobverseForm() or paste an existing Form ID into ' +
    'Config > FORM_ID, then run installFormTrigger(). 2) Set ANTHROPIC_API_KEY in Script properties. ' +
    '3) Deploy > New deployment > Web app, and copy the URL into the Chrome extension options.';
  Logger.log(msg);
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'Setup complete - check Execution log or ActivityLog tab for next steps.', 'Jobverse', 20
    );
  } catch (ignored) { /* toast is best-effort, never block on it */ }
}

/** Run after putting the Form ID into Config. */
function installFormTrigger() {
  var formId = getConfig('FORM_ID');
  if (!formId) throw new Error('Set Config > FORM_ID first.');
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'onFormSubmit';
  });
  if (!exists) {
    ScriptApp.newTrigger('onFormSubmit').forForm(FormApp.openById(formId)).onFormSubmit().create();
  }
  logActivity('system', 'trigger_installed', 'form', formId, 'Form submit trigger active');
}

function ensureTrigger_(fnName, builderFn) {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === fnName;
  });
  if (!exists) builderFn(ScriptApp.newTrigger(fnName));
}

/* ------------------------- shared helpers ------------------------- */

function sheet_(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function getConfig(key) {
  var sh = sheet_('Config');
  if (!sh || sh.getLastRow() < 2) return '';
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  for (var i = 0; i < data.length; i++) if (data[i][0] === key) return String(data[i][1]);
  return '';
}

function setConfig(key, value) {
  var sh = sheet_('Config');
  var data = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 1).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === key) { sh.getRange(i + 2, 2).setValue(value); return; }
  }
  sh.appendRow([key, value, '']);
}

function newId(prefix) {
  return prefix + '-' + Utilities.formatDate(new Date(), 'GMT', 'yyMMdd') + '-' +
    Math.random().toString(36).slice(2, 8).toUpperCase();
}

function logActivity(actor, action, refType, refId, detail) {
  sheet_('ActivityLog').appendRow([new Date(), actor, action, refType, refId, detail || '']);
}

/**
 * Row helpers: read a sheet into objects, or find/update one row by ID
 * column. All four look up columns BY HEADER NAME from the sheet's actual
 * row 1, never by position in the JV.SHEETS[name] code array. This matters:
 * JV.SHEETS[name] can be reordered or extended as the schema grows without
 * ever risking misalignment of data that's already in the sheet - the code
 * array is only used to know which columns SHOULD exist (for setup/migration
 * below), never to decide where a value lives in an existing row.
 */
function getHeaderMap_(sh) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var headerRow = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  headerRow.forEach(function (h, i) { if (h) map[h] = i + 1; }); // 1-based column index
  return map;
}

function readRows(name) {
  var sh = sheet_(name);
  if (sh.getLastRow() < 2) return [];
  var map = getHeaderMap_(sh);
  var lastCol = sh.getLastColumn();
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, lastCol).getValues();
  var headerNames = Object.keys(map);
  return values.map(function (row, i) {
    var o = { _row: i + 2 };
    headerNames.forEach(function (h) { o[h] = row[map[h] - 1]; });
    return o;
  });
}

function findRow(name, idField, idValue) {
  var rows = readRows(name);
  for (var i = 0; i < rows.length; i++) if (String(rows[i][idField]) === String(idValue)) return rows[i];
  return null;
}

function appendObject(name, obj) {
  var sh = sheet_(name);
  var map = getHeaderMap_(sh);
  var lastCol = Math.max(sh.getLastColumn(), Object.keys(map).length);
  var row = new Array(lastCol).fill('');
  Object.keys(obj).forEach(function (k) {
    if (map[k]) row[map[k] - 1] = obj[k];
  });
  sh.appendRow(row);
}

function updateRow(name, rowNumber, patch) {
  var sh = sheet_(name);
  var map = getHeaderMap_(sh);
  Object.keys(patch).forEach(function (k) {
    if (map[k]) sh.getRange(rowNumber, map[k]).setValue(patch[k]);
  });
}

/**
 * Delete every row in a sheet whose idField equals idValue. Deletes from the
 * bottom up so earlier row numbers don't shift while we're still deleting.
 * Returns how many rows were removed.
 */
function deleteRowsWhere(name, idField, idValue) {
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
  rowsToDelete.sort(function (a, b) { return b - a; }); // descending
  rowsToDelete.forEach(function (rowNum) { sh.deleteRow(rowNum); });
  return rowsToDelete.length;
}