#!/usr/bin/env bash
# Jobverse: wire the worker to the REAL Api.gs endpoints and gate every real
# Submit click behind human review (dashDecide), plus unblock CV/cover-letter
# downloads for the worker.
#
# Adds/changes:
#   - appscript/Api.js: two new endpoints -
#       exportDocumentPdf        - exports a generated CV/cover-letter Google
#                                   Doc as PDF, base64-encoded, so the worker
#                                   can download real files over the same API
#                                   token it already uses (no separate Google
#                                   auth needed in the worker).
#       listApplicationsByStatus - lets the worker find applications a human
#                                   has already approved ("Approved -
#                                   Submitting"), with the CV/cover-letter doc
#                                   URLs for that job, so it knows what to
#                                   actually click Submit on.
#     Also exposes ApplicationEmail/ApplicationPassword via
#     getCandidatePayload (needed for the Workday sign-in/signup module from
#     the previous batch - these were already stored in the Sheet, just never
#     read by the API before).
#
#   - worker/worker.js: full rewrite against the real flow. Two passes, both
#     non-blocking (worker never sits waiting on a human mid-application):
#       1. FILL  - queued prospects -> precheck -> analyse (generates CV/
#          cover letter) -> start -> download real PDFs -> fill the ATS form
#          -> requestReview. Never clicks Submit in this pass.
#       2. SUBMIT - applications a human has approved -> re-fill (fresh page,
#          same data) -> click Submit for real -> confirmSubmission.
#
#   - worker/ats/greenhouse.js: rewritten to the fillForm/clickSubmit split
#     (it used to click Submit itself with zero human gate - fixed to match
#     every other part of Jobverse, which always waits for a human decision
#     before a real submission).
#
#   - worker/ats/workday.js: same fillForm/clickSubmit split; still stops
#     after handling the sign-in/signup wall (real Workday form-filling isn't
#     built yet - needs a real posting to verify selectors against, same
#     caution as Greenhouse got before it was tested).
#
# Usage: run from inside your jobverse-repo clone:
#   bash apply-batch-3.sh

set -euo pipefail

if [ ! -d ".git" ]; then
  echo "Run this from inside your jobverse-repo clone (the folder with .git in it)." >&2
  exit 1
fi

echo "Pulling latest..."
git pull origin main

echo "Rewriting appscript/Api.js (adds exportDocumentPdf, listApplicationsByStatus, exposes application creds)..."
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
      recordPlatformAccount: apiRecordPlatformAccount_,
      exportDocumentPdf: apiExportDocumentPdf_,
      listApplicationsByStatus: apiListApplicationsByStatus_
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
      NHSSocioEconomicBackground: c.NHSSocioEconomicBackground,
      applicationEmail: c.ApplicationEmail, applicationPassword: c.ApplicationPassword
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

/**
 * NEW: exports a generated CV/cover letter Google Doc as a PDF and returns it
 * base64-encoded, so the Playwright worker can attach the real file to an
 * application form without needing its own separate Google auth - it reuses
 * the same API_TOKEN it already authenticates with. Fine for CV/cover-letter
 * sized documents; not meant for large files (Apps Script response limits).
 */
function apiExportDocumentPdf_(req) {
  var id = extractDocId_(req.docUrl);
  if (!id) throw new Error('Could not parse a Google Doc ID from docUrl: ' + req.docUrl);
  var blob = DriveApp.getFileById(id).getAs(MimeType.PDF);
  return { base64: Utilities.base64Encode(blob.getBytes()), filename: blob.getName() };
}

function extractDocId_(url) {
  var m = String(url || '').match(/\/d\/([-\w]{25,})/);
  return m ? m[1] : null;
}

/**
 * NEW: lets the worker find applications waiting on it rather than the sheet
 * - e.g. Status 'Approved - Submitting' after dashDecide records a human's
 * approval on the Submission review, so the worker knows what to actually
 * click Submit on. Also returns the latest CV/cover-letter doc URLs for the
 * application's JobID so the worker can re-fill the form before submitting.
 */
function apiListApplicationsByStatus_(req) {
  var cvByJob = {}, clByJob = {};
  readRows('CVVersions').forEach(function (v) { cvByJob[v.JobID] = v.DocURL; });
  readRows('CoverLetters').forEach(function (l) { clByJob[l.JobID] = l.DocURL; });

  return readRows('Applications')
    .filter(function (a) { return a.Status === req.status && (!req.candidateId || a.CandidateID === req.candidateId); })
    .map(function (a) {
      return {
        id: a.ApplicationID, candidateId: a.CandidateID, jobId: a.JobID, company: a.Company,
        title: a.JobTitle, url: a.JobURL, ats: a.ATS, status: a.Status,
        cvUrl: cvByJob[a.JobID] || '', letterUrl: clByJob[a.JobID] || ''
      };
    });
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

echo "Rewriting worker/worker.js (real Api.gs flow, two-pass, never auto-submits)..."
cat > worker/worker.js << 'WORKERJS_EOF'
/**
 * Jobverse application worker (Playwright), wired to the real Api.gs
 * endpoints (not the earlier invented claim/report model).
 *
 * Two passes each cycle, deliberately non-blocking:
 *
 *  1. FILL: for each active candidate's Queued prospects - precheck, analyse
 *     (generates CV/cover letter via the AI agents), start the application,
 *     download the generated documents as real PDFs, fill the ATS form via
 *     an ats/*.js module, then request human review of a snapshot of what
 *     would be submitted. The worker never clicks the real Submit button in
 *     this pass - Applications sits at "Awaiting Review" until a human
 *     decides in the Jobverse Console (dashDecide).
 *
 *  2. SUBMIT: for each candidate's applications now "Approved - Submitting"
 *     (a human said yes), re-open a fresh page, re-fill the form the same
 *     way, then actually click Submit and confirm it.
 *
 * Re-filling on submit instead of holding one long-lived browser session
 * open while waiting on a human avoids blocking the whole worker on review
 * turnaround time. The cost is filling twice for anything that gets
 * approved - acceptable for an MVP, and worth revisiting if ATS forms turn
 * out to have side effects on repeat fills (rare, but module authors should
 * keep fillForm idempotent).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { chromium } = require('playwright');

const ats = {
  greenhouse: require('./ats/greenhouse'),
  workday: require('./ats/workday'),
};

const {
  JOBVERSE_API_URL,
  JOBVERSE_API_TOKEN,
  WORKER_ID = 'jobverse-worker-1',
  POLL_INTERVAL_MS = 30000,
  DOWNLOAD_DIR = './downloads',
  HEADED = 'false',
  MIN_SUITABILITY = '0',
} = process.env;

if (!JOBVERSE_API_URL || !JOBVERSE_API_TOKEN) {
  console.error('Set JOBVERSE_API_URL and JOBVERSE_API_TOKEN in .env (see .env.example).');
  process.exit(1);
}

async function callApi(action, body) {
  const res = await fetch(JOBVERSE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, token: JOBVERSE_API_TOKEN, ...body }),
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  if (!res.ok || !json || json.ok === false) {
    const msg = json && json.error ? json.error : `HTTP ${res.status}`;
    throw new Error(`Jobverse API "${action}" failed: ${msg}`);
  }
  return json.data;
}

async function downloadDocPdf(docUrl, destPath) {
  if (!docUrl) throw new Error('No document URL to download (cvUrl/letterUrl was empty).');
  const { base64 } = await callApi('exportDocumentPdf', { docUrl });
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.from(base64, 'base64'));
  return destPath;
}

function moduleFor(atsName) {
  return ats[String(atsName || '').toLowerCase().trim()];
}

/** Pass 1: discover queued prospects, generate + fill, hand off to review. */
async function fillQueuedProspects(candidate, browser) {
  const prospects = await callApi('listProspects', { candidateId: candidate.id, status: 'Queued' });

  for (const prospect of prospects) {
    try {
      const pre = await callApi('precheckApplication', {
        candidateId: candidate.id, jobUrl: prospect.url, company: prospect.company, jobTitle: prospect.title,
      });
      if (pre.block) {
        console.log(`[${prospect.id}] Skipping (${pre.block}).`);
        await callApi('updateProspectStatus', { prospectId: prospect.id, status: 'Skipped', notes: 'precheck: ' + pre.block });
        continue;
      }

      const analysis = await callApi('analyseJob', {
        candidateId: candidate.id, jobUrl: prospect.url, jdText: prospect.jdText || '', ats: prospect.ats || '',
      });

      if (Number(MIN_SUITABILITY) && Number(analysis.suitability || 0) < Number(MIN_SUITABILITY)) {
        console.log(`[${prospect.id}] Suitability ${analysis.suitability} below MIN_SUITABILITY (${MIN_SUITABILITY}), skipping.`);
        await callApi('updateProspectStatus', { prospectId: prospect.id, status: 'Skipped', notes: 'low suitability: ' + analysis.suitability });
        continue;
      }

      const start = await callApi('startApplication', {
        candidateId: candidate.id, jobId: analysis.jobId, company: analysis.company,
        jobTitle: analysis.title, jobUrl: prospect.url, ats: prospect.ats || '',
      });
      if (start.duplicate || start.targetMet || start.throttled || start.inactive) {
        const why = start.duplicate ? 'duplicate' : start.targetMet ? 'targetMet' : start.throttled ? 'throttled' : 'inactive';
        console.log(`[${prospect.id}] Not starting (${why}).`);
        await callApi('updateProspectStatus', { prospectId: prospect.id, status: 'Skipped', notes: why });
        continue;
      }

      await fillAndRequestReview(candidate, {
        applicationId: start.applicationId, jobId: analysis.jobId, company: analysis.company,
        title: analysis.title, url: prospect.url, ats: prospect.ats || '',
        cvUrl: analysis.cvUrl, letterUrl: analysis.letterUrl,
      }, browser);
    } catch (err) {
      console.error(`[${prospect.id}] Unhandled error in fill pass:`, err.message);
    }
  }
}

/** Shared by both passes: download docs, run the ATS module's fillForm. */
async function fillAndRequestReview(candidate, app, browser) {
  const files = {};
  files.cv = await downloadDocPdf(app.cvUrl, path.join(DOWNLOAD_DIR, `${app.applicationId}-cv.pdf`));
  files.coverLetter = await downloadDocPdf(app.letterUrl, path.join(DOWNLOAD_DIR, `${app.applicationId}-cover-letter.pdf`));

  const module = moduleFor(app.ats);
  if (!module) {
    console.log(`[${app.applicationId}] No automation module for ATS "${app.ats}" yet - leaving for manual handling.`);
    await callApi('reportError', { applicationId: app.applicationId, message: `No automation module for ATS "${app.ats}"` });
    return;
  }

  const candidatePayload = await callApi('getCandidatePayload', { candidateId: candidate.id });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    console.log(`[${app.applicationId}] Filling application -> ${app.url}`);
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });

    const snapshot = await module.fillForm(
      page,
      { candidateId: candidate.id, applicationId: app.applicationId, jobId: app.jobId, company: app.company, title: app.title, url: app.url },
      files,
      candidatePayload.fields,
      callApi
    );

    const { taskId } = await callApi('requestReview', {
      candidateId: candidate.id, jobId: app.jobId, applicationId: app.applicationId,
      company: app.company, jobTitle: app.title, snapshot,
    });
    console.log(`[${app.applicationId}] Filled, awaiting human approval (task ${taskId}).`);
  } catch (err) {
    console.error(`[${app.applicationId}] Failed:`, err.message);
    const shotPath = path.join(DOWNLOAD_DIR, `${app.applicationId}-failure.png`);
    try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (_) {}
    await callApi('reportError', { applicationId: app.applicationId, message: `${err.message} (screenshot: ${shotPath})` });
  } finally {
    await context.close();
  }
}

/** Pass 2: applications a human has already approved - re-fill for real and submit. */
async function submitApproved(candidate, browser) {
  const approved = await callApi('listApplicationsByStatus', {
    candidateId: candidate.id, status: 'Approved - Submitting',
  });

  for (const app of approved) {
    const module = moduleFor(app.ats);
    if (!module) {
      console.log(`[${app.id}] No automation module for ATS "${app.ats}" - can't complete the real submit.`);
      await callApi('reportError', { applicationId: app.id, message: `No automation module for ATS "${app.ats}" at submit time` });
      continue;
    }

    const files = {};
    const candidatePayload = await callApi('getCandidatePayload', { candidateId: candidate.id });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      files.cv = await downloadDocPdf(app.cvUrl, path.join(DOWNLOAD_DIR, `${app.id}-cv.pdf`));
      files.coverLetter = await downloadDocPdf(app.letterUrl, path.join(DOWNLOAD_DIR, `${app.id}-cover-letter.pdf`));

      console.log(`[${app.id}] Re-filling approved application -> ${app.url}`);
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await module.fillForm(
        page,
        { candidateId: candidate.id, applicationId: app.id, jobId: app.jobId, company: app.company, title: app.title, url: app.url },
        files,
        candidatePayload.fields,
        callApi
      );

      await module.clickSubmit(page);
      const shot = (await page.screenshot({ fullPage: true })).toString('base64');
      await callApi('confirmSubmission', { applicationId: app.id, screenshotBase64: shot });
      console.log(`[${app.id}] Submitted.`);
    } catch (err) {
      console.error(`[${app.id}] Submit failed:`, err.message);
      const shotPath = path.join(DOWNLOAD_DIR, `${app.id}-submit-failure.png`);
      try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (_) {}
      await callApi('reportError', { applicationId: app.id, message: `${err.message} (screenshot: ${shotPath})` });
    } finally {
      await context.close();
    }
  }
}

async function pollLoop() {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: HEADED !== 'true' });
  console.log(`Jobverse worker "${WORKER_ID}" started. Polling every ${POLL_INTERVAL_MS}ms.`);

  while (true) {
    try {
      const candidates = await callApi('listCandidates', {});
      for (const candidate of candidates) {
        await fillQueuedProspects(candidate, browser);
        await submitApproved(candidate, browser);
      }
    } catch (err) {
      console.error('Poll loop error:', err.message);
    }
    await new Promise((r) => setTimeout(r, Number(POLL_INTERVAL_MS)));
  }
}

pollLoop();
WORKERJS_EOF

echo "Rewriting worker/ats/greenhouse.js (adds fillForm/clickSubmit split)..."
mkdir -p worker/ats
cat > worker/ats/greenhouse.js << 'GREENHOUSEJS_EOF'
/**
 * Greenhouse module, rewritten against the real candidate payload shape
 * (fullName, not separate first/last) and the fillForm/clickSubmit split so
 * the real Submit click always waits for requestReview/dashDecide - this
 * module used to click Submit itself with no human gate at all, which
 * doesn't match how every other part of Jobverse treats a real submission.
 *
 * Test against a couple of real Greenhouse postings and adjust selectors
 * for custom employer questions as needed.
 */

function splitName_(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

async function formLocator_(page) {
  const iframe = page.frameLocator('iframe[src*="greenhouse.io"]').first();
  const hasIframe = await iframe.locator('body').count().catch(() => 0);
  return hasIframe ? iframe : page;
}

/** Fills the form and returns a snapshot for human review. Never submits. */
async function fillForm(page, application, files, candidate) {
  const form = await formLocator_(page);
  const { first, last } = splitName_(candidate.fullName);

  await form.locator('input#first_name, input[name="job_application[first_name]"]').fill(first);
  await form.locator('input#last_name, input[name="job_application[last_name]"]').fill(last);
  await form.locator('input#email, input[name="job_application[email]"]').fill(candidate.email || '');
  if (candidate.phone) {
    await form.locator('input#phone, input[name="job_application[phone]"]').fill(candidate.phone).catch(() => {});
  }

  if (files.cv) {
    await form.locator('input[type="file"]#resume, input[name="job_application[resume]"]').setInputFiles(files.cv);
  }
  if (files.coverLetter) {
    const clInput = form.locator('input[type="file"]#cover_letter, input[name="job_application[cover_letter]"]');
    if (await clInput.count()) await clInput.setInputFiles(files.coverLetter);
  }

  const unhandledRequired = await form.locator('[required]').evaluateAll((els) =>
    els.filter((el) => el.tagName === 'INPUT' && el.type === 'text' && !el.value)
       .map((el) => el.name || el.id || el.outerHTML.slice(0, 80))
  );
  if (unhandledRequired.length) {
    throw new Error(`Unhandled required field(s): ${unhandledRequired.join(', ')}`);
  }

  return {
    ats: 'greenhouse', firstName: first, lastName: last, email: candidate.email || '',
    phone: candidate.phone || '', cvAttached: !!files.cv, coverLetterAttached: !!files.coverLetter,
  };
}

/** Only called after a human has approved the snapshot from fillForm. */
async function clickSubmit(page) {
  const form = await formLocator_(page);
  await form.locator('button#submit_app, button[type="submit"]').click();
  await page.waitForSelector('text=/application.*received|thank you|successfully submitted/i', { timeout: 15000 });
}

module.exports = { fillForm, clickSubmit };
GREENHOUSEJS_EOF

echo "Rewriting worker/ats/workday.js (adds fillForm/clickSubmit split)..."
cat > worker/ats/workday.js << 'WORKDAYJS_EOF'
/**
 * Workday module: handles the sign-in/sign-up wall Workday tenants put in
 * front of the actual application form, reusing the candidate's existing
 * ApplicationEmail/ApplicationPassword (from the intake form, exposed by
 * getCandidatePayload) rather than generating new credentials - every
 * candidate is assumed not to already have a Workday account for a given
 * employer's tenant unless PlatformAccounts says otherwise.
 *
 * Fills the same fillForm/clickSubmit interface as ats/greenhouse.js so
 * worker.js can treat every ATS module the same way. Actual Workday
 * application-form filling (after the account step) is NOT implemented yet -
 * Workday's form structure varies a lot by tenant and needs verification
 * against real postings before it's safe to guess at selectors, same
 * caution already applied to the Greenhouse module.
 */

async function hasAuthWall_(page) {
  return page.locator('text=/sign in|log in|create account|create an account/i').first().count().catch(() => 0);
}

async function signIn_(page, candidate) {
  await page.getByLabel(/email/i).first().fill(candidate.applicationEmail || '');
  await page.getByLabel(/password/i).first().fill(candidate.applicationPassword || '');
  await page.getByRole('button', { name: /sign in|log in/i }).first().click();
}

async function signUp_(page, candidate) {
  await page.getByRole('link', { name: /create account/i }).first().click().catch(() => {});
  await page.getByLabel(/email/i).first().fill(candidate.applicationEmail || '');
  await page.getByLabel(/^password/i).first().fill(candidate.applicationPassword || '');
  const confirmField = page.getByLabel(/confirm password/i).first();
  if (await confirmField.count()) await confirmField.fill(candidate.applicationPassword || '');
  await page.getByRole('checkbox', { name: /agree|terms/i }).first().check().catch(() => {});
  await page.getByRole('button', { name: /create account|sign up|submit/i }).first().click();

  const captcha = await page.locator('iframe[src*="captcha"], text=/verify you are human/i').first().count().catch(() => 0);
  if (captcha) return { blocked: true, blockedReason: 'Blocked-CAPTCHA', notes: 'CAPTCHA on account creation' };

  const emailVerify = await page.locator('text=/verify your email|check your email|confirmation email/i').first().count().catch(() => 0);
  if (emailVerify) {
    return {
      blocked: true, blockedReason: 'Blocked-EmailVerification',
      notes: 'Requires clicking a verification link sent to ' + (candidate.applicationEmail || '(no application email on file)'),
    };
  }

  return { blocked: false };
}

/**
 * Resolves any sign-in/signup wall, recording the outcome in PlatformAccounts
 * either way, and pausing for a human via captchaPause if account creation
 * hits something genuinely unautomatable (CAPTCHA / mandatory email
 * verification link). Throws past that point - the actual form fill isn't
 * built yet.
 */
async function fillForm(page, application, files, candidate, api) {
  if (!candidate.applicationEmail || !candidate.applicationPassword) {
    throw new Error('Candidate has no ApplicationEmail/ApplicationPassword on file - can\'t sign in or sign up on this Workday tenant.');
  }

  if (await hasAuthWall_(page)) {
    const domain = new URL(page.url()).hostname;
    const existing = await api('checkPlatformAccount', { candidateId: application.candidateId, atsDomain: domain });

    if (existing.found && existing.status === 'Created') {
      await signIn_(page, candidate);
    } else if (existing.found && String(existing.status).indexOf('Blocked') === 0) {
      throw new Error(`Known blocked platform account (${existing.status}) for ${domain} - needs human resolution, not retrying automatically.`);
    } else {
      const result = await signUp_(page, candidate);
      if (result.blocked) {
        await api('recordPlatformAccount', { candidateId: application.candidateId, atsDomain: domain, status: result.blockedReason, notes: result.notes });
        await api('captchaPause', {
          applicationId: application.applicationId,
          reason: result.blockedReason === 'Blocked-EmailVerification' ? 'EmailVerification' : 'CAPTCHA',
          jobUrl: page.url(), company: application.company,
        });
        throw new Error(`Account creation blocked for ${domain}: ${result.blockedReason}`);
      }
      await api('recordPlatformAccount', { candidateId: application.candidateId, atsDomain: domain, status: 'Created', notes: 'Auto-created during application' });
    }
  }

  throw new Error('Workday form filling not yet implemented past the sign-in/signup step - needs verification against a real Workday posting.');
}

async function clickSubmit() {
  throw new Error('Workday clickSubmit not implemented - form filling is not implemented yet either.');
}

module.exports = { fillForm, clickSubmit };
WORKDAYJS_EOF

echo "Updating worker/package.json description..."
cat > worker/package.json << 'PKGJSON_EOF'
{
  "name": "jobverse-auto-submit-worker",
  "version": "0.1.0",
  "private": true,
  "description": "Fills job applications via Playwright against the real Api.gs endpoints, requests human review of a snapshot before every real submit, and only clicks Submit once a human has approved it in the Jobverse Console.",
  "main": "worker.js",
  "scripts": { "start": "node worker.js" },
  "dependencies": {
    "playwright": "^1.47.0",
    "node-fetch": "^2.7.0",
    "dotenv": "^16.4.5"
  }
}
PKGJSON_EOF

echo "Updating worker/.env.example..."
cat > worker/.env.example << 'ENVEXAMPLE_EOF'
JOBVERSE_API_URL=https://script.google.com/macros/s/XXXXXXXXXXXX/exec
JOBVERSE_API_TOKEN=
WORKER_ID=jobverse-worker-1
POLL_INTERVAL_MS=30000
DOWNLOAD_DIR=./downloads
HEADED=false
# Optional: skip generating/filling anything below this suitability score
# (whatever scale runJobAnalyst uses). 0 = no filtering.
MIN_SUITABILITY=0
ENVEXAMPLE_EOF

echo "Committing..."
git add -A
git commit -m "Wire worker to real Api.gs endpoints, gate submit behind human review

- Api.js: exportDocumentPdf (worker downloads real CV/cover-letter PDFs over
  the same API token), listApplicationsByStatus (worker finds human-approved
  applications to actually submit), getCandidatePayload now exposes
  ApplicationEmail/ApplicationPassword for the Workday module.
- worker.js: full rewrite - fill+requestReview pass and a separate
  submit-after-approval pass, both non-blocking. Replaces the old invented
  claimNextCleared/reportSubmissionResult model that never matched the real
  Sheet/Api.js.
- ats/greenhouse.js: fillForm/clickSubmit split so the real submit always
  waits for a human decision (it used to click Submit itself unconditionally).
- ats/workday.js: same split; still stops after the sign-in/signup step until
  real Workday form-filling is built and verified.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"

echo "Pushing..."
git push

echo ""
echo "Done. Now: clasp push to deploy Api.js, then set JOBVERSE_API_URL/TOKEN in"
echo "worker/.env (copy from .env.example) and run 'npm install' then 'npm start'"
echo "inside worker/ once you actually want it touching real job pages."
