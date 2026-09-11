#!/usr/bin/env bash
# Jobverse: platform-account handling for sign-in/sign-up walls (Workday etc).
#
# Adds:
#   - appscript/Setup.js: new PlatformAccounts tab (additive - existing tabs,
#     columns, and data are never touched, same safe migration path setup
#     already uses)
#   - appscript/Api.js: two new endpoints (checkPlatformAccount,
#     recordPlatformAccount) and a small backward-compatible extension to
#     apiCaptchaPause_ (adds an optional `reason`, defaults to 'CAPTCHA' so
#     any existing caller that doesn't pass it behaves exactly as before)
#   - worker/ats/workday.js: new Playwright module implementing the
#     check -> sign-in-or-signup -> record -> pause-if-blocked flow
#
# Usage: run from inside your jobverse-repo clone:
#   bash apply-batch-2.sh

set -euo pipefail

if [ ! -d ".git" ]; then
  echo "Run this from inside your jobverse-repo clone (the folder with .git in it)." >&2
  exit 1
fi

echo "Pulling latest..."
git pull origin main

echo "Rewriting appscript/Setup.js (adds PlatformAccounts tab)..."
cat > appscript/Setup.js << 'SETUPJS_EOF'
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
    Config: ['Key', 'Value', 'Notes'],
    // NEW: tracks per-candidate, per-ATS-tenant accounts created for sign-in
    // walls (Workday etc). ATSDomain is the actual tenant hostname (e.g.
    // acmecorp.wd5.myworkdayjobs.com), never just "Workday" - each employer's
    // instance is a separate account. Status: 'Created' (usable, sign in next
    // time), 'Blocked-CAPTCHA', 'Blocked-EmailVerification', or 'Failed'.
    // Always uses the candidate's existing ApplicationEmail/ApplicationPassword -
    // no separate credentials stored here.
    PlatformAccounts: [
      'AccountID', 'CreatedAt', 'CandidateID', 'ATSDomain', 'Status', 'Notes', 'UpdatedAt'
    ]
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
        try { logActivity('system', 'schema_migrated', 'sheet', name, 'Added: ' + missing.join(', ')); } catch (ignored) {}
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

  if (!getConfig('ROOT_FOLDER_ID')) {
    var root = DriveApp.createFolder('Jobverse Platform');
    root.createFolder('Candidates');
    root.createFolder('Generated CVs');
    root.createFolder('Cover Letters');
    root.createFolder('Screenshots');
    root.createFolder('Reports');
    setConfig('ROOT_FOLDER_ID', root.getId());
  }

  if (!getConfig('API_TOKEN')) {
    setConfig('API_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  }

  ensureTrigger_('runDailyReport', function (b) { return b.timeBased().atHour(7).everyDays(1).create(); });
  ensureTrigger_('findProspectsForAllCandidates', function (b) { return b.timeBased().atHour(6).everyDays(1).create(); });
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

function getHeaderMap_(sh) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var headerRow = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  headerRow.forEach(function (h, i) { if (h) map[h] = i + 1; });
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
  rowsToDelete.sort(function (a, b) { return b - a; });
  rowsToDelete.forEach(function (rowNum) { sh.deleteRow(rowNum); });
  return rowsToDelete.length;
}
SETUPJS_EOF

echo "Rewriting appscript/Api.js (adds platform-account endpoints, extends apiCaptchaPause_)..."
cat > appscript/Api.js << 'APIJS_EOF'
/**
 * JOBVERSE MVP - Api.gs
 * One web app deployment serves both:
 *  - GET  (no params)      -> the dashboard (Dashboard.html)
 *  - POST (JSON + token)   -> the Chrome extension API
 *
 * Extension requests are authenticated with the shared API_TOKEN from Config.
 */

function doGet(e) {
  return HtmlService.createTemplateFromFile('Dashboard').evaluate()
    .setTitle('Jobverse Console')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    if (req.token !== getConfig('API_TOKEN')) throw new Error('Unauthorised');
    var handlers = {
      listCandidates: apiListCandidates_,
      getCandidatePayload: apiGetCandidatePayload_,
      analyseJob: apiAnalyseJob_,
      startApplication: apiStartApplication_,
      precheckApplication: apiPrecheckApplication_,
      answerQuestion: apiAnswerQuestion_,
      requestReview: apiRequestReview_,
      checkApproval: apiCheckApproval_,
      captchaPause: apiCaptchaPause_,
      confirmSubmission: apiConfirmSubmission_,
      reportError: apiReportError_,
      listProspects: apiListProspects_,
      updateProspectStatus: apiUpdateProspectStatus_,
      getCandidateCVText: apiGetCandidateCVText_,
      generateNHSStatement: apiGenerateNHSStatement_,
      createNHSFollowUp: apiCreateNHSFollowUp_,
      checkPlatformAccount: apiCheckPlatformAccount_,
      recordPlatformAccount: apiRecordPlatformAccount_
    };
    if (!handlers[req.action]) throw new Error('Unknown action: ' + req.action);
    out = { ok: true, data: handlers[req.action](req) };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/* --------------------------- extension handlers -------------------------- */

function apiListCandidates_(req) {
  return readRows('Candidates')
    .filter(function (c) { return c.Status !== 'Archived' && String(c.Active).toUpperCase() !== 'FALSE'; })
    .map(function (c) {
      return { id: c.CandidateID, name: c.FullName, email: c.Email, status: c.Status };
    });
}

function apiGetCandidatePayload_(req) {
  var c = findRow('Candidates', 'CandidateID', req.candidateId);
  if (!c) throw new Error('Candidate not found');
  var profile = {};
  try { profile = JSON.parse(c.AIProfileJSON || '{}'); } catch (ignored) {}
  return {
    id: c.CandidateID,
    fields: {
      fullName: c.FullName, email: c.Email, phone: c.Phone, location: c.Location,
      rightToWork: c.RightToWork, visa: c.VisaStatus, licence: c.DrivingLicence,
      minSalary: c.MinSalary, noticePeriod: c.NoticePeriod, linkedin: c.LinkedIn,
      github: c.GitHub, portfolio: c.Portfolio, relocate: c.WillingToRelocate,
      workModel: c.WorkModel, employmentType: c.EmploymentType,
      registrations: c.Registrations, nationality: c.Nationality,
      NHSUnspentConvictions: c.NHSUnspentConvictions, NHSFitnessToPractice: c.NHSFitnessToPractice,
      NHSDisabilityGIS: c.NHSDisabilityGIS, NHSEthnicity: c.NHSEthnicity,
      NHSReligion: c.NHSReligion, NHSSexualOrientation: c.NHSSexualOrientation,
      NHSSocioEconomicBackground: c.NHSSocioEconomicBackground
    },
    profile: profile,
    cvFileId: c.CVFileID
  };
}

function apiAnalyseJob_(req) {
  var jobId = runJobAnalyst(req.candidateId, req.jobUrl, req.jdText, req.ats);
  var job = findRow('Jobs', 'JobID', jobId);

  var cvId = runResumeBuilder(req.candidateId, jobId, req.tone);
  var letterId = runCoverLetterBuilder(req.candidateId, jobId, req.tone);
  var cv = findRow('CVVersions', 'VersionID', cvId);
  var letter = findRow('CoverLetters', 'LetterID', letterId);

  return {
    jobId: jobId, company: job.Company, title: job.JobTitle, suitability: job.SuitabilityScore,
    cvUrl: cv.DocURL, letterUrl: letter.DocURL
  };
}

function apiPrecheckApplication_(req) {
  var cand = findRow('Candidates', 'CandidateID', req.candidateId);
  if (!cand) throw new Error('Candidate not found');
  if (String(cand.Active).toUpperCase() === 'FALSE') return { block: 'inactive' };

  var allApps = readRows('Applications');

  var basis = req.candidateId + '|' + normaliseJobKey_(req.jobUrl, req.company, req.jobTitle);
  var hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, basis)).slice(0, 24);
  if (allApps.some(function (a) { return a.DedupeHash === hash && a.Status !== 'Failed'; })) return { block: 'duplicate' };

  var target = parseInt(cand.TargetApplications || getConfig('DEFAULT_TARGET_APPLICATIONS') || '50', 10);
  var totalForCand = allApps.filter(function (a) { return a.CandidateID === req.candidateId && a.Status !== 'Failed'; }).length;
  if (target > 0 && totalForCand >= target) return { block: 'targetMet', target: target };

  var limit = parseInt(getConfig('MAX_APPS_PER_CANDIDATE_PER_DAY') || '15', 10);
  var today = Utilities.formatDate(new Date(), 'GMT', 'yyyy-MM-dd');
  var todayCount = allApps.filter(function (a) {
    return a.CandidateID === req.candidateId &&
      Utilities.formatDate(new Date(a.CreatedAt), 'GMT', 'yyyy-MM-dd') === today;
  }).length;
  if (todayCount >= limit) return { block: 'throttled', limit: limit };

  return { block: null, target: target, doneSoFar: totalForCand };
}

function apiStartApplication_(req) {
  var cand = findRow('Candidates', 'CandidateID', req.candidateId);
  if (!cand) throw new Error('Candidate not found');

  if (String(cand.Active).toUpperCase() === 'FALSE') return { inactive: true };

  var basis = req.candidateId + '|' + normaliseJobKey_(req.jobUrl, req.company, req.jobTitle);
  var hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, basis)).slice(0, 24);

  var allApps = readRows('Applications');
  var dupe = allApps.some(function (a) { return a.DedupeHash === hash && a.Status !== 'Failed'; });
  if (dupe) return { duplicate: true };

  var target = parseInt(cand.TargetApplications || getConfig('DEFAULT_TARGET_APPLICATIONS') || '50', 10);
  var totalForCand = allApps.filter(function (a) {
    return a.CandidateID === req.candidateId && a.Status !== 'Failed';
  }).length;
  if (target > 0 && totalForCand >= target) return { targetMet: true, target: target };

  var limit = parseInt(getConfig('MAX_APPS_PER_CANDIDATE_PER_DAY') || '15', 10);
  var today = Utilities.formatDate(new Date(), 'GMT', 'yyyy-MM-dd');
  var todayCount = allApps.filter(function (a) {
    return a.CandidateID === req.candidateId &&
      Utilities.formatDate(new Date(a.CreatedAt), 'GMT', 'yyyy-MM-dd') === today;
  }).length;
  if (todayCount >= limit) return { throttled: true, limit: limit };

  var appId = newId('APP');
  appendObject('Applications', {
    ApplicationID: appId, CreatedAt: new Date(), CandidateID: req.candidateId,
    JobID: req.jobId || '', Company: req.company || '', JobTitle: req.jobTitle || '',
    JobURL: req.jobUrl || '', ATS: req.ats || '', Status: 'In Progress', DedupeHash: hash
  });
  logActivity('extension', 'application_started', 'application', appId, req.company + ' - ' + req.jobTitle);
  return { duplicate: false, applicationId: appId };
}

function apiAnswerQuestion_(req) {
  var a = answerScreeningQuestion(req.candidateId, req.jobId, req.question);
  return { answer: a, needsHuman: a === 'NEEDS_HUMAN' };
}

function apiRequestReview_(req) {
  var taskId = newId('REV');
  appendObject('ReviewQueue', {
    TaskID: taskId, CreatedAt: new Date(), Type: 'Submission',
    CandidateID: req.candidateId, JobID: req.jobId || '', RefID: req.applicationId,
    Summary: req.company + ' - ' + req.jobTitle,
    AIFindings: JSON.stringify(req.snapshot || {}).slice(0, 40000),
    Status: 'Awaiting Human'
  });
  var app = findRow('Applications', 'ApplicationID', req.applicationId);
  if (app) updateRow('Applications', app._row, { Status: 'Awaiting Review' });
  notifyReviewers_('Review needed: ' + req.company + ' - ' + req.jobTitle,
    'A completed application is paused for approval. Open the Jobverse Console review queue. Task ' + taskId);
  return { taskId: taskId };
}

function apiCheckApproval_(req) {
  var t = findRow('ReviewQueue', 'TaskID', req.taskId);
  if (!t) throw new Error('Task not found');
  return { status: t.Status, decision: t.Decision || '', notes: t.Notes || '' };
}

/**
 * A human must resolve something the extension can't push through itself.
 * `reason` defaults to 'CAPTCHA' so any existing caller that doesn't pass it
 * behaves exactly as before this was extended - new callers (e.g. the
 * account-creation flow hitting an email-verification wall) pass their own
 * reason instead.
 */
function apiCaptchaPause_(req) {
  var app = findRow('Applications', 'ApplicationID', req.applicationId);
  var reason = req.reason || 'CAPTCHA';
  if (app) updateRow('Applications', app._row, { Status: reason + ' - Human Needed' });
  logActivity('extension', 'automation_pause', 'application', req.applicationId, reason + ': ' + (req.jobUrl || ''));
  notifyReviewers_(reason + ' needs a human: ' + (req.company || ''),
    'Application ' + req.applicationId + ' hit "' + reason + '" at ' + (req.jobUrl || '') +
    '. Open the tab and resolve it' + (reason === 'CAPTCHA' ? ', then the extension resumes automatically.' : '.'));
  return { paused: true };
}

function apiConfirmSubmission_(req) {
  var app = findRow('Applications', 'ApplicationID', req.applicationId);
  if (!app) throw new Error('Application not found');

  var shotUrl = '';
  if (req.screenshotBase64) {
    var blob = Utilities.newBlob(Utilities.base64Decode(req.screenshotBase64), 'image/png',
      req.applicationId + '-confirmation.png');
    var f = DriveApp.getFolderById(getConfig('ROOT_FOLDER_ID'))
      .getFoldersByName('Screenshots').next().createFile(blob);
    shotUrl = f.getUrl();
  }
  updateRow('Applications', app._row, {
    Status: 'Submitted', SubmittedAt: new Date(), ConfirmationScreenshotURL: shotUrl
  });
  logActivity('extension', 'application_submitted', 'application', req.applicationId, app.Company);
  return { recorded: true, screenshotUrl: shotUrl };
}

function apiReportError_(req) {
  var app = req.applicationId ? findRow('Applications', 'ApplicationID', req.applicationId) : null;
  if (app) updateRow('Applications', app._row, {
    Status: 'Failed', ErrorLog: (String(app.ErrorLog || '') + '\n' + req.message).slice(0, 5000)
  });
  logActivity('extension', 'error', 'application', req.applicationId || '-', req.message);
  return { logged: true };
}

function apiListProspects_(req) {
  return readRows('Prospects')
    .filter(function (p) { return p.CandidateID === req.candidateId && (!req.status || p.Status === req.status); })
    .map(function (p) { return { id: p.ProspectID, url: p.JobURL, company: p.Company, title: p.JobTitle }; });
}

function apiUpdateProspectStatus_(req) {
  var p = findRow('Prospects', 'ProspectID', req.prospectId);
  if (!p) throw new Error('Prospect not found');
  updateRow('Prospects', p._row, { Status: req.status, Notes: req.notes || p.Notes });
  logActivity('extension', 'prospect_status', 'prospect', req.prospectId, req.status);
  return { updated: true };
}

function apiGetCandidateCVText_(req) {
  var c = findRow('Candidates', 'CandidateID', req.candidateId);
  if (!c) throw new Error('Candidate not found');
  if (!c.CVFileID) return { text: '' };
  return { text: extractFileText(c.CVFileID).slice(0, 40000) };
}

function apiGenerateNHSStatement_(req) {
  var jobId = runJobAnalyst(req.candidateId, req.jobUrl, req.jdText, 'NHS Jobs');
  var result = runNHSSupportingStatement(req.candidateId, jobId, req.tone || 'NHS');
  return { jobId: jobId, statementText: result.text, docUrl: result.docUrl };
}

function apiCreateNHSFollowUp_(req) {
  var id = createNHSTracFollowUp(req.candidateId, req.applicationId, req.company, req.jobTitle, req.closingDate);
  return { followUpId: id };
}

/**
 * NEW: checks whether an account already exists for this candidate on this
 * ATS tenant (by domain). The worker calls this before attempting to sign
 * up or sign in on a wall it detects.
 */
function apiCheckPlatformAccount_(req) {
  var domain = normaliseDomain_(req.atsDomain || req.jobUrl);
  var matches = readRows('PlatformAccounts').filter(function (a) {
    return a.CandidateID === req.candidateId && a.ATSDomain === domain;
  });
  if (!matches.length) return { found: false };
  matches.sort(function (a, b) { return new Date(b.CreatedAt) - new Date(a.CreatedAt); });
  var latest = matches[0];
  return { found: true, status: latest.Status, notes: latest.Notes || '' };
}

/**
 * NEW: records the outcome of an account creation/sign-in attempt for a
 * candidate + ATS tenant, so future runs know whether to sign in, retry, or
 * leave a known block alone until a human resolves it.
 */
function apiRecordPlatformAccount_(req) {
  var domain = normaliseDomain_(req.atsDomain || req.jobUrl);
  var id = newId('ACC');
  appendObject('PlatformAccounts', {
    AccountID: id, CreatedAt: new Date(), CandidateID: req.candidateId,
    ATSDomain: domain, Status: req.status, Notes: req.notes || '', UpdatedAt: new Date()
  });
  logActivity('extension', 'platform_account_' + req.status, 'candidate', req.candidateId, domain);
  return { recorded: true, accountId: id };
}

/* ------------------------- dashboard RPC (google.script.run) ------------------------- */

function dashData() {
  var allApps = readRows('Applications');
  var countByCand = {};
  allApps.forEach(function (a) {
    if (a.Status !== 'Failed') countByCand[a.CandidateID] = (countByCand[a.CandidateID] || 0) + 1;
  });
  return {
    candidates: readRows('Candidates').map(function (c) {
      return { id: c.CandidateID, name: c.FullName, email: c.Email, status: c.Status,
               active: String(c.Active).toUpperCase() !== 'FALSE',
               target: parseInt(c.TargetApplications || '0', 10) || 0,
               applied: countByCand[c.CandidateID] || 0,
               roles: c.PreferredRoles, location: c.Location, created: String(c.CreatedAt) };
    }),
    applications: readRows('Applications').map(function (a) {
      return { id: a.ApplicationID, cand: a.CandidateID, company: a.Company, title: a.JobTitle,
               ats: a.ATS, status: a.Status, url: a.JobURL, submitted: String(a.SubmittedAt || ''),
               shot: a.ConfirmationScreenshotURL, outcome: a.Outcome };
    }),
    reviews: readRows('ReviewQueue').filter(function (t) { return t.Status === 'Awaiting Human'; })
      .map(function (t) {
        return { id: t.TaskID, type: t.Type, cand: t.CandidateID, summary: t.Summary,
                 score: t.AIScore, findings: t.AIFindings, created: String(t.CreatedAt) };
      }),
    prospects: readRows('Prospects').map(function (p) {
      return { id: p.ProspectID, cand: p.CandidateID, company: p.Company, title: p.JobTitle,
               url: p.JobURL, status: p.Status };
    }),
    log: readRows('ActivityLog').slice(-60).reverse().map(function (l) {
      return { t: String(l.Timestamp), actor: l.Actor, action: l.Action, detail: l.Detail };
    }),
    followUps: readRows('FollowUps').map(function (f) {
      return { id: f.FollowUpID, cand: f.CandidateID, type: f.Type, company: f.Company,
               title: f.JobTitle, due: String(f.DueDate), status: f.Status, notes: f.Notes };
    }),
    report: latestReport_()
  };
}

function dashDecide(taskId, decision, notes) {
  var t = findRow('ReviewQueue', 'TaskID', taskId);
  if (!t) throw new Error('Task not found');
  updateRow('ReviewQueue', t._row, {
    Status: 'Decided', Decision: decision, Notes: notes || '',
    Reviewer: Session.getActiveUser().getEmail(), DecidedAt: new Date()
  });
  if (t.Type === 'Submission') {
    var app = findRow('Applications', 'ApplicationID', t.RefID);
    if (app) updateRow('Applications', app._row, {
      Status: decision === 'approve' ? 'Approved - Submitting' : 'Rejected'
    });
  }
  if (t.Type === 'CV') {
    var v = findRow('CVVersions', 'VersionID', t.RefID);
    if (v) updateRow('CVVersions', v._row, { ReviewStatus: decision });
  }
  if (t.Type === 'CoverLetter') {
    var l = findRow('CoverLetters', 'LetterID', t.RefID);
    if (l) updateRow('CoverLetters', l._row, { ReviewStatus: decision });
  }
  if (t.Type === 'NHSStatement') {
    var n = findRow('NHSStatements', 'StatementID', t.RefID);
    if (n) updateRow('NHSStatements', n._row, { ReviewStatus: decision });
  }
  logActivity(Session.getActiveUser().getEmail() || 'reviewer', 'review_' + decision, t.Type, t.RefID, notes || '');
  return true;
}

function dashGenerate(candidateId, jdText, jobUrl, tone) {
  var jobId = runJobAnalyst(candidateId, jobUrl || '', jdText, '');
  var cvId = runResumeBuilder(candidateId, jobId, tone);
  var clId = runCoverLetterBuilder(candidateId, jobId, tone);
  var cv = findRow('CVVersions', 'VersionID', cvId);
  var cl = findRow('CoverLetters', 'LetterID', clId);
  return { jobId: jobId, cvUrl: cv.DocURL, letterUrl: cl.DocURL };
}

function dashFindProspects(candidateId) {
  return findProspectsForCandidate(candidateId);
}

function dashSetProspectStatus(prospectId, status) {
  var p = findRow('Prospects', 'ProspectID', prospectId);
  if (!p) throw new Error('Prospect not found');
  updateRow('Prospects', p._row, { Status: status });
  logActivity(Session.getActiveUser().getEmail() || 'reviewer', 'prospect_' + status, 'prospect', prospectId, '');
  return true;
}

function dashSetCandidateActive(candidateId, active) {
  var c = findRow('Candidates', 'CandidateID', candidateId);
  if (!c) throw new Error('Candidate not found');
  updateRow('Candidates', c._row, { Active: active ? 'TRUE' : 'FALSE' });
  logActivity(Session.getActiveUser().getEmail() || 'reviewer', active ? 'candidate_activated' : 'candidate_deactivated', 'candidate', candidateId, '');
  return true;
}

function dashSetCandidateTarget(candidateId, target) {
  var c = findRow('Candidates', 'CandidateID', candidateId);
  if (!c) throw new Error('Candidate not found');
  var n = parseInt(target, 10);
  if (isNaN(n) || n < 0) throw new Error('Target must be a non-negative number');
  updateRow('Candidates', c._row, { TargetApplications: n });
  logActivity(Session.getActiveUser().getEmail() || 'reviewer', 'candidate_target_set', 'candidate', candidateId, String(n));
  return true;
}

function dashMarkFollowUpDone(followUpId) {
  var f = findRow('FollowUps', 'FollowUpID', followUpId);
  if (!f) throw new Error('Follow-up not found');
  updateRow('FollowUps', f._row, { Status: 'Done' });
  logActivity(Session.getActiveUser().getEmail() || 'reviewer', 'followup_done', 'followup', followUpId, '');
  return true;
}

function dashDeleteCandidate(candidateId) {
  var cand = findRow('Candidates', 'CandidateID', candidateId);
  if (!cand) throw new Error('Candidate not found');

  var removed = {};
  ['Applications', 'Jobs', 'CVVersions', 'CoverLetters', 'NHSStatements',
   'ReviewQueue', 'Prospects', 'FollowUps', 'AIOutputs'].forEach(function (tab) {
    removed[tab] = deleteRowsWhere(tab, 'CandidateID', candidateId);
  });

  if (cand.DriveFolderID) {
    try { DriveApp.getFolderById(cand.DriveFolderID).setTrashed(true); } catch (ignored) {}
  }

  deleteRowsWhere('Candidates', 'CandidateID', candidateId);

  logActivity(Session.getActiveUser().getEmail() || 'reviewer', 'candidate_deleted', 'candidate', candidateId,
    cand.FullName + ' | removed: ' + JSON.stringify(removed));
  return { deleted: true, related: removed };
}

function dashClearActivityLog() {
  var sh = sheet_('ActivityLog');
  var last = sh.getLastRow();
  if (last > 1) sh.deleteRows(2, last - 1);
  logActivity(Session.getActiveUser().getEmail() || 'reviewer', 'activity_log_cleared', 'system', '-', 'Log cleared');
  return true;
}

function dashQueueAllFound(candidateId) {
  var count = 0;
  readRows('Prospects').forEach(function (p) {
    if (p.CandidateID === candidateId && p.Status === 'Found') {
      updateRow('Prospects', p._row, { Status: 'Queued' });
      count++;
    }
  });
  logActivity(Session.getActiveUser().getEmail() || 'reviewer', 'prospects_bulk_queued', 'candidate', candidateId, count + ' queued');
  return { queued: count };
}

function dashRetryApplication(applicationId) {
  var app = findRow('Applications', 'ApplicationID', applicationId);
  if (!app) throw new Error('Application not found');

  appendObject('Prospects', {
    ProspectID: newId('PROS'), FoundAt: new Date(), CandidateID: app.CandidateID,
    Company: app.Company, JobTitle: app.JobTitle, JobURL: app.JobURL,
    Source: 'Retry', Status: 'Queued', Notes: 'Re-queued from failed application ' + applicationId
  });
  updateRow('Applications', app._row, { Status: 'Retried' });
  logActivity(Session.getActiveUser().getEmail() || 'reviewer', 'application_retried', 'application', applicationId, app.Company);
  return { requeued: true };
}

/* ------------------------------- helpers -------------------------------- */

function normaliseJobKey_(url, company, title) {
  if (url) {
    return String(url).toLowerCase().replace(/^https?:\/\//, '').replace(/[?#].*$/, '').replace(/\/$/, '');
  }
  return (String(company) + '::' + String(title)).toLowerCase().trim();
}

/** Extracts just the hostname from a URL, or passes a bare domain through unchanged. */
function normaliseDomain_(urlOrDomain) {
  var s = String(urlOrDomain || '');
  var m = s.match(/^https?:\/\/([^\/]+)/i);
  return (m ? m[1] : s).toLowerCase();
}

function notifyReviewers_(subject, body) {
  var emails = getConfig('REPORT_EMAILS');
  if (!emails) return;
  emails.split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (to) {
    try { MailApp.sendEmail(to, '[Jobverse] ' + subject, body); } catch (ignored) {}
  });
}

function latestReport_() {
  var rows = readRows('Reports');
  if (!rows.length) return null;
  var last = rows[rows.length - 1];
  try { return { period: last.Period, metrics: JSON.parse(last.MetricsJSON), summary: last.Summary }; }
  catch (e) { return null; }
}
APIJS_EOF

mkdir -p worker/ats
echo "Writing worker/ats/workday.js..."
cat > worker/ats/workday.js << 'WORKDAYJS_EOF'
/**
 * Workday submission module - handles the sign-in/sign-up wall Workday
 * tenants commonly put in front of the actual application form.
 *
 * Flow: detect a wall -> check PlatformAccounts (via the API) for an
 * existing account on THIS tenant for THIS candidate -> sign in if one
 * exists, sign up if not, using the candidate's existing
 * ApplicationEmail/ApplicationPassword (never generates new credentials) ->
 * record the outcome. If signup hits a CAPTCHA or requires email
 * verification, that's a real wall nothing here can push through - it
 * records the specific block and pauses via the same human-notify path
 * apiCaptchaPause_ already uses for CAPTCHAs, then throws so the worker
 * doesn't attempt the rest of the application this run.
 *
 * NOTE: Workday's actual form structure varies meaningfully between
 * tenant versions. The selectors below (role/label based, not raw CSS)
 * are a reasonable starting point but should be checked against a couple
 * of real Workday postings and adjusted - same caveat as the Greenhouse
 * module.
 */

async function submit(page, application, files, candidate, api) {
  var wall = await page.locator('text=/sign in|log in|create account|create an account/i').first().count().catch(function () { return 0; });

  if (wall) {
    var domain = new URL(page.url()).hostname;
    var existing = await api('checkPlatformAccount', { candidateId: candidate.CandidateID, atsDomain: domain });

    if (existing.found && existing.status === 'Created') {
      await signIn_(page, candidate);
    } else if (existing.found && String(existing.status).indexOf('Blocked') === 0) {
      throw new Error('Known blocked platform account (' + existing.status + ') for ' + domain + ' - needs human resolution, not retrying automatically.');
    } else {
      var result = await signUp_(page, candidate);
      if (result.blocked) {
        await api('recordPlatformAccount', { candidateId: candidate.CandidateID, atsDomain: domain, status: result.blockedReason, notes: result.notes });
        await api('captchaPause', {
          applicationId: application.ApplicationID,
          reason: result.blockedReason === 'Blocked-EmailVerification' ? 'EmailVerification' : 'CAPTCHA',
          jobUrl: page.url(), company: application.Company
        });
        throw new Error('Account creation blocked for ' + domain + ': ' + result.blockedReason);
      }
      await api('recordPlatformAccount', { candidateId: candidate.CandidateID, atsDomain: domain, status: 'Created', notes: 'Auto-created during application' });
    }
  }

  // Actual Workday application-form filling (name/CV upload/screening
  // questions/submit) still needs to be built once the sign-in/sign-up
  // step above has been checked against real postings - deliberately not
  // guessed at here, since Workday's form structure varies a lot more
  // than Greenhouse's between tenants.
  throw new Error('Workday sign-in/signup handled - application form filling not yet implemented.');
}

async function signIn_(page, candidate) {
  await page.getByLabel(/email/i).first().fill(candidate.ApplicationEmail);
  await page.getByLabel(/password/i).first().fill(candidate.ApplicationPassword);
  await page.getByRole('button', { name: /sign in|log in/i }).first().click();
}

async function signUp_(page, candidate) {
  await page.getByRole('link', { name: /create account/i }).first().click().catch(function () {});
  await page.getByLabel(/email/i).first().fill(candidate.ApplicationEmail);
  await page.getByLabel(/^password/i).first().fill(candidate.ApplicationPassword);
  var confirmField = page.getByLabel(/confirm password/i).first();
  if (await confirmField.count()) await confirmField.fill(candidate.ApplicationPassword);
  await page.getByRole('checkbox', { name: /agree|terms/i }).first().check().catch(function () {});
  await page.getByRole('button', { name: /create account|sign up|submit/i }).first().click();

  var captcha = await page.locator('iframe[src*="captcha"], text=/verify you are human/i').first().count().catch(function () { return 0; });
  if (captcha) return { blocked: true, blockedReason: 'Blocked-CAPTCHA', notes: 'CAPTCHA on account creation' };

  var emailVerify = await page.locator('text=/verify your email|check your email|confirmation email/i').first().count().catch(function () { return 0; });
  if (emailVerify) return { blocked: true, blockedReason: 'Blocked-EmailVerification', notes: 'Requires clicking a verification link sent to ' + candidate.ApplicationEmail };

  return { blocked: false };
}

module.exports = { submit };
WORKDAYJS_EOF

echo "Committing..."
git add -A
git commit -m "Add platform-account handling for sign-in/sign-up walls (Workday etc)

- Setup.js: new PlatformAccounts tab (additive, safe migration)
- Api.js: checkPlatformAccount/recordPlatformAccount endpoints, apiCaptchaPause_
  extended with an optional reason (defaults to CAPTCHA, fully backward compatible)
- worker/ats/workday.js: check -> sign-in-or-signup -> record -> pause-if-blocked,
  always reusing the candidate's existing ApplicationEmail/ApplicationPassword.
  Actual Workday application-form filling still needs building once this
  account step is verified against real postings.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"

echo "Pushing..."
git push

echo ""
echo "Done. Now: clasp push to deploy Setup.js/Api.js, then run setupJobverse()"
echo "once (safe to re-run - it only adds the new PlatformAccounts tab, touches"
echo "nothing existing) so the tab actually gets created in the Sheet."
