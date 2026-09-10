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
      createNHSFollowUp: apiCreateNHSFollowUp_
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
  // Extension scrapes visible JD text from the page and sends it here.
  var jobId = runJobAnalyst(req.candidateId, req.jobUrl, req.jdText, req.ats);
  var job = findRow('Jobs', 'JobID', jobId);

  // Generate the tailored CV and cover letter for this specific job right
  // away, so the reviewer has the actual documents to attach during file
  // upload, rather than needing a separate trip to the dashboard's Generate
  // tab first. Both go into the Review queue automatically (see Agents.gs).
  var cvId = runResumeBuilder(req.candidateId, jobId, req.tone);
  var letterId = runCoverLetterBuilder(req.candidateId, jobId, req.tone);
  var cv = findRow('CVVersions', 'VersionID', cvId);
  var letter = findRow('CoverLetters', 'LetterID', letterId);

  return {
    jobId: jobId, company: job.Company, title: job.JobTitle, suitability: job.SuitabilityScore,
    cvUrl: cv.DocURL, letterUrl: letter.DocURL
  };
}

/**
 * Read-only gate check used before the expensive analyse+generate step, so we
 * don't spend API credits on a candidate who is inactive, over target, capped,
 * or already applied. Returns the same stop flags as startApplication.
 */
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

  // Inactive clients: stop before doing any work.
  if (String(cand.Active).toUpperCase() === 'FALSE') return { inactive: true };

  // Duplicate guard: hash of candidate + normalised job URL (or company+title).
  var basis = req.candidateId + '|' + normaliseJobKey_(req.jobUrl, req.company, req.jobTitle);
  var hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, basis)).slice(0, 24);

  var allApps = readRows('Applications');
  var dupe = allApps.some(function (a) { return a.DedupeHash === hash && a.Status !== 'Failed'; });
  if (dupe) return { duplicate: true };

  // Per-candidate total target: count everything not failed toward the goal.
  var target = parseInt(cand.TargetApplications || getConfig('DEFAULT_TARGET_APPLICATIONS') || '50', 10);
  var totalForCand = allApps.filter(function (a) {
    return a.CandidateID === req.candidateId && a.Status !== 'Failed';
  }).length;
  if (target > 0 && totalForCand >= target) return { targetMet: true, target: target };

  // Daily throttle per candidate.
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
  // Extension pauses before submission and files a review task with a snapshot
  // of every field and answer it intends to submit.
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

function apiCaptchaPause_(req) {
  // A human must solve the CAPTCHA. We only record the pause and page a reviewer.
  var app = findRow('Applications', 'ApplicationID', req.applicationId);
  if (app) updateRow('Applications', app._row, { Status: 'CAPTCHA - Human Needed' });
  logActivity('extension', 'captcha_pause', 'application', req.applicationId, req.jobUrl || '');
  notifyReviewers_('CAPTCHA needs a human: ' + (req.company || ''),
    'Application ' + req.applicationId + ' hit a CAPTCHA at ' + (req.jobUrl || '') +
    '. Open the tab and solve it, then the extension resumes automatically.');
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
  // req.status optional filter, e.g. 'Queued'. Returns the fields the
  // extension's queue runner needs: id, url, company, title.
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

/**
 * Runs job analysis (same as the other ATS) then generates the NHS
 * supporting statement. Returns the plain text so the extension can paste it
 * directly into the "further information" field, plus a Doc link for the
 * reviewer's record.
 */
function apiGenerateNHSStatement_(req) {
  var jobId = runJobAnalyst(req.candidateId, req.jobUrl, req.jdText, 'NHS Jobs');
  var result = runNHSSupportingStatement(req.candidateId, jobId, req.tone || 'NHS');
  return { jobId: jobId, statementText: result.text, docUrl: result.docUrl };
}

function apiCreateNHSFollowUp_(req) {
  var id = createNHSTracFollowUp(req.candidateId, req.applicationId, req.company, req.jobTitle, req.closingDate);
  return { followUpId: id };
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

/**
 * Full cascade delete of a candidate: removes their row and every related row
 * across all tabs, plus their Drive folder (CV, certificates, generated docs).
 * This is irreversible - the dashboard confirms before calling it.
 */
function dashDeleteCandidate(candidateId) {
  var cand = findRow('Candidates', 'CandidateID', candidateId);
  if (!cand) throw new Error('Candidate not found');

  // Related rows keyed by CandidateID.
  var removed = {};
  ['Applications', 'Jobs', 'CVVersions', 'CoverLetters', 'NHSStatements',
   'ReviewQueue', 'Prospects', 'FollowUps', 'AIOutputs'].forEach(function (tab) {
    removed[tab] = deleteRowsWhere(tab, 'CandidateID', candidateId);
  });

  // Drive folder.
  if (cand.DriveFolderID) {
    try { DriveApp.getFolderById(cand.DriveFolderID).setTrashed(true); } catch (ignored) {}
  }

  // Finally the candidate row itself.
  deleteRowsWhere('Candidates', 'CandidateID', candidateId);

  logActivity(Session.getActiveUser().getEmail() || 'reviewer', 'candidate_deleted', 'candidate', candidateId,
    cand.FullName + ' | removed: ' + JSON.stringify(removed));
  return { deleted: true, related: removed };
}

/** Clears the Activity Log (keeps the header row). Confirmed in the dashboard first. */
function dashClearActivityLog() {
  var sh = sheet_('ActivityLog');
  var last = sh.getLastRow();
  if (last > 1) sh.deleteRows(2, last - 1);
  logActivity(Session.getActiveUser().getEmail() || 'reviewer', 'activity_log_cleared', 'system', '-', 'Log cleared');
  return true;
}

/** Queue every 'Found' prospect for a candidate in one action. */
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

/** Retry a failed application by turning it back into a queued prospect. */
function dashRetryApplication(applicationId) {
  var app = findRow('Applications', 'ApplicationID', applicationId);
  if (!app) throw new Error('Application not found');

  // Re-create a prospect so the extension queue can pick it up again.
  appendObject('Prospects', {
    ProspectID: newId('PROS'), FoundAt: new Date(), CandidateID: app.CandidateID,
    Company: app.Company, JobTitle: app.JobTitle, JobURL: app.JobURL,
    Source: 'Retry', Status: 'Queued', Notes: 'Re-queued from failed application ' + applicationId
  });
  // Mark the old application so it's clear it was retried, not left dangling.
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