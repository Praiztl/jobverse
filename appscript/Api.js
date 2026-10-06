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
      answerField: apiAnswerField_,
      decideClick: apiDecideClick_,
      chooseNextStep: apiChooseNextStep_,
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
      platformAccount: apiPlatformAccount_,
      updatePlatformAccount: apiUpdatePlatformAccount_,
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

/**
 * NEW: AI-powered field answering for individual form fields. The ATS module
 * extracts field info (label, type, options) and asks the AI what to fill in.
 * This replaces hardcoded field mapping with dynamic AI decision-making.
 * ENHANCED: Now accepts semantic field representation with context and returns structured actions.
 */
function apiAnswerField_(req) {
  var cand = findRow('Candidates', 'CandidateID', req.candidateId);
  if (!cand) throw new Error('Candidate not found');
  var job = req.jobId ? findRow('Jobs', 'JobID', req.jobId) : null;

  var fieldInfo = req.fieldInfo || {};
  var formContext = req.formContext || {};
  
  var prompt = 'You are an intelligent form-filling assistant. Decide what action to take for a single form field. ' +
    'Return a structured JSON response with your decision.';

  // Handle semantic field information
  if (fieldInfo.semanticType && fieldInfo.semanticType !== 'custom_question') {
    prompt += ' This field has been semantically classified as "' + fieldInfo.semanticType + '" with ' +
      Math.round(fieldInfo.confidence * 100) + '% confidence.';
  }

  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  if (fieldInfo.options && fieldInfo.options.length > 0) {
    prompt += ' This is a dropdown/radio/checkbox field with specific options.';
  } else if (fieldInfo.dateKind) {
    prompt += ' This is a DATE field. Today is ' + today + '. Return the value strictly as YYYY-MM-DD ' +
      '(the extension converts it to the format the form expects). For start/availability dates, ' +
      'add the candidate\'s notice period to today. For dates of birth or other personal dates not ' +
      'present in the candidate data, return action "human". Respect min/max if given.';
  } else {
    prompt += ' This is a text input field.';
  }

  // Add form context if available
  var contextInfo = '';
  if (formContext.ats) {
    contextInfo += '\nFORM CONTEXT:\n' +
      'ATS Platform: ' + formContext.ats +
      '\nMulti-step form: ' + (formContext.isMultiStep ? 'Yes (step ' + formContext.currentStep + ' of ' + formContext.totalSteps + ')' : 'No') +
      '\nForm URL: ' + (formContext.url || 'unknown');
  }

  var decision = callClaudeJSON(
    prompt + ' Return JSON with this exact structure: {"action": "fill|select|check|uncheck|skip|human", "value": "string", "reason": "string", "confidence": 0.0-1.0}. ' +
    'Action types: "fill" for text fields, "select" for dropdowns (use option value), "check"/"uncheck" for checkboxes, "skip" to ignore, "human" if you need help.',
    'SEMANTIC FIELD INFO:\n' + JSON.stringify({
      id: fieldInfo.id,
      label: fieldInfo.label,
      semanticType: fieldInfo.semanticType,
      confidence: fieldInfo.confidence,
      type: fieldInfo.type,
      elementType: fieldInfo.elementType,
      required: fieldInfo.required,
      fieldset: fieldInfo.fieldset,
      formGroup: fieldInfo.formGroup,
      placeholder: fieldInfo.placeholder,
      pattern: fieldInfo.pattern,
      min: fieldInfo.min,
      max: fieldInfo.max,
      maxLength: fieldInfo.maxLength,
      description: fieldInfo.ariaDescribedBy,
      dateKind: fieldInfo.dateKind,
      options: fieldInfo.options
    }) +
    '\nTODAY: ' + today +
    contextInfo +
    '\n\nCANDIDATE STRUCTURED FIELDS:\n' + JSON.stringify({
      fullName: cand.FullName, email: cand.Email, phone: cand.Phone, location: cand.Location,
      rightToWork: cand.RightToWork, visa: cand.VisaStatus, licence: cand.DrivingLicence,
      minSalary: cand.MinSalary, noticePeriod: cand.NoticePeriod, linkedin: cand.LinkedIn,
      github: cand.GitHub, portfolio: cand.Portfolio, relocate: cand.WillingToRelocate,
      workModel: cand.WorkModel, employmentType: cand.EmploymentType,
      registrations: cand.Registrations, nationality: cand.Nationality,
      NHSUnspentConvictions: cand.NHSUnspentConvictions, NHSFitnessToPractice: cand.NHSFitnessToPractice,
      NHSDisabilityGIS: cand.NHSDisabilityGIS, NHSEthnicity: cand.NHSEthnicity,
      NHSReligion: cand.NHSReligion, NHSSexualOrientation: cand.NHSSexualOrientation,
      NHSSocioEconomicBackground: cand.NHSSocioEconomicBackground,
      applicationEmail: cand.ApplicationEmail // passwords are never sent to the AI
    }) +
    '\n\nCANDIDATE PROFILE:\n' + cand.AIProfileJSON +
    (job ? '\n\nJOB CONTEXT:\n' + job.AnalysisJSON : '') +
    '\n\nReturn JSON: {"action": "fill|select|check|uncheck|skip|human", "value": "string", "reason": "string", "confidence": 0.0-1.0}',
    800
  );

  saveAIOutput('FieldAnswerer', req.candidateId, req.jobId, { 
    fieldInfo: fieldInfo, 
    formContext: formContext,
    decision: decision 
  });

  // Convert structured decision to legacy format for compatibility
  var needsHuman = decision.action === 'human';
  var answer = (decision.action === 'fill' || decision.action === 'select') ? decision.value : null;

  return { 
    answer: answer, 
    needsHuman: needsHuman,
    // Also return the full structured decision for new clients
    structuredDecision: decision
  };
}

/**
 * NEW: AI-powered click decision for buttons/links. The unified form filler
 * extracts element info and asks the AI whether to click it, handling complex
 * navigation decisions that can't be determined mechanically.
 */
function apiDecideClick_(req) {
  var cand = findRow('Candidates', 'CandidateID', req.candidateId);
  if (!cand) throw new Error('Candidate not found');
  var job = req.jobId ? findRow('Jobs', 'JobID', req.jobId) : null;

  var elementInfo = req.elementInfo || {};
  var prompt = 'Decide whether to click a button/link during job application form filling. ' +
    'Consider the context and whether clicking would help complete the application. ' +
    'Return JSON with { "shouldClick": boolean, "reason": string }. ' +
    'If uncertain, set shouldClick to false and explain why in reason.';

  var decision = callClaudeJSON(
    prompt,
    'ELEMENT INFO: ' + JSON.stringify(elementInfo) +
    '\n\nCANDIDATE CONTEXT:\n' + JSON.stringify({
      fullName: cand.FullName, email: cand.Email, currentStatus: cand.Status
    }) +
    (job ? '\n\nJOB CONTEXT:\n' + job.AnalysisJSON : '') +
    '\n\nCURRENT URL: ' + (req.currentUrl || 'unknown') +
    '\n\nReturn JSON: { "shouldClick": boolean, "reason": string }',
    300
  );

  saveAIOutput('ClickDecider', req.candidateId, req.jobId, { elementInfo: elementInfo, decision: decision });

  return {
    shouldClick: decision.shouldClick || false,
    reason: decision.reason || '',
    needsHuman: !decision.shouldClick && decision.reason.toLowerCase().includes('human')
  };
}

/**
 * Navigation step for the extension's application driver: given a page that
 * is not yet the application form, pick which clickable element most likely
 * leads towards it (job board -> company site -> ATS form can take several
 * hops). The extension sends the candidates it found; we return one index.
 */
function apiChooseNextStep_(req) {
  var candidates = (req.candidates || []).slice(0, 40);
  var decision = callClaudeJSON(
    'You are navigating a web browser towards the online application FORM for a specific job. ' +
    'The current page is not the form yet. Choose the ONE clickable element most likely to lead to ' +
    'the application form for this job (e.g. "Apply", "Apply now", "Apply on company website", ' +
    '"Start application", "I\'m interested", "Continue"). ' +
    'The browser CAN sign in and create accounts for the candidate (it has saved credentials and fills ' +
    'sign-up forms itself), so when the site requires an account, choose the element that leads to ' +
    'registration or sign-in ("Register", "Create account", "Sign up", "Sign in to apply") - but prefer ' +
    '"Apply as guest"/"Apply without an account" when offered, and prefer a real Apply button over a ' +
    'generic header "Sign in". Never choose share/save/job-alert/similar-job/cookie elements, never ' +
    '"Sign in with Google/LinkedIn/Facebook/Apple" (social login), and never an element listed under ' +
    'ALREADY TRIED. Pages may be in any language (e.g. German "Jetzt bewerben", "Weiter", "Registrieren"). ' +
    'If the page says the job is closed or expired, answer "closed". Answer "human" only ' +
    'for things the browser cannot do (payment, identity documents, an assessment to sit) or when no ' +
    'element plausibly leads towards the application. ' +
    'Return JSON: {"action": "click|closed|human", "index": number|null, "reason": "short string"}',
    'TARGET JOB: ' + (req.jobTitle || 'unknown') + ' at ' + (req.company || 'unknown') +
    '\nCURRENT URL: ' + (req.url || '') +
    '\nPAGE TITLE: ' + (req.title || '') +
    '\n\nPAGE TEXT (start):\n' + String(req.pageText || '').slice(0, 3000) +
    '\n\nCLICKABLE CANDIDATES:\n' + JSON.stringify(candidates) +
    '\n\nALREADY TRIED: ' + JSON.stringify(req.tried || []),
    300
  );
  saveAIOutput('NextStepChooser', req.candidateId || '', '', { url: req.url, candidates: candidates, decision: decision });

  var action = ['click', 'closed', 'human'].indexOf(decision.action) > -1 ? decision.action : 'human';
  var index = action === 'click' ? Number(decision.index) : null;
  if (action === 'click' && !candidates.some(function (c) { return c.index === index; })) action = 'human';
  return { action: action, index: action === 'click' ? index : null, reason: decision.reason || '' };
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
 
/**
 * FIXED: now includes an `ats` field the worker needs to pick the right
 * automation module - Prospects.gs only ever stored ATS support as a Status
 * flag ('Found' vs 'Found - Manual Review'), never the ATS name itself, so
 * this had nothing to give the worker until now.
 */
function apiListProspects_(req) {
  return readRows('Prospects')
    .filter(function (p) { return p.CandidateID === req.candidateId && (!req.status || p.Status === req.status); })
    .map(function (p) {
      return { id: p.ProspectID, url: p.JobURL, company: p.Company, title: p.JobTitle, ats: detectATSName_(p.JobURL) };
    });
}
 
/** Same domains Prospects.gs's detectATSFromUrl_ checks, but returns the name instead of a boolean. */
function detectATSName_(url) {
  var u = String(url || '').toLowerCase();
  if (u.indexOf('greenhouse.io') > -1) return 'greenhouse';
  if (u.indexOf('myworkdayjobs') > -1 || u.indexOf('workday.com') > -1) return 'workday';
  if (u.indexOf('lever.co') > -1) return 'lever';
  if (u.indexOf('ashbyhq.com') > -1) return 'ashby';
  if (u.indexOf('jobs.nhs.uk') > -1) return 'nhs';
  return '';
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
 
/* ------------------------- candidate site accounts ------------------------- */

/**
 * Accounts created for candidates on job sites that require one (Workday
 * tenants, iCIMS, company career portals...): one per candidate per site
 * host, reused on every later application to that host.
 *
 * Each account gets its own random password, kept in Script Properties
 * (PLATFORM_PW_<AccountID>) - never in the sheet, which only shows site,
 * email and status. Reviewers who need to log in by hand reveal a password
 * from the dashboard (allowlisted Google accounts only).
 *
 * Status: Pending (sign-up submitted, not confirmed yet), Created (usable),
 * Blocked-EmailVerification, Blocked-CAPTCHA, LoginFailed, Failed.
 */
var ACCOUNT_PW_PREFIX_ = 'PLATFORM_PW_';

/** Saved account for this candidate + site; with req.create, makes one (password generated here) if none exists. */
function apiPlatformAccount_(req) {
  ensureColumns_('PlatformAccounts', ['Email', 'LoginURL']);
  var cand = findRow('Candidates', 'CandidateID', req.candidateId);
  if (!cand) throw new Error('Candidate not found');
  var domain = normaliseDomain_(req.atsDomain || req.jobUrl);
  var email = String(cand.ApplicationEmail || cand.Email || '').trim();

  var existing = latestAccount_(req.candidateId, domain);
  if (existing) {
    var saved = PropertiesService.getScriptProperties().getProperty(ACCOUNT_PW_PREFIX_ + existing.AccountID);
    return {
      found: true, created: false, accountId: existing.AccountID, status: existing.Status,
      email: existing.Email || email,
      // Accounts the Workday worker made before per-site passwords used the intake password
      password: saved || String(cand.ApplicationPassword || '') || null
    };
  }
  if (!req.create) return { found: false };
  if (!email) throw new Error('Candidate has no application email on file - add ApplicationEmail before creating site accounts.');

  var id = newId('ACC');
  var password = generateSitePassword_();
  // Saved before the sign-up form is even submitted, so the password is never lost
  PropertiesService.getScriptProperties().setProperty(ACCOUNT_PW_PREFIX_ + id, password);
  appendObject('PlatformAccounts', {
    AccountID: id, CreatedAt: new Date(), CandidateID: req.candidateId, ATSDomain: domain, Email: email,
    LoginURL: req.jobUrl || '', Status: 'Pending', Notes: 'Sign-up started by the extension', UpdatedAt: new Date()
  });
  logActivity('extension', 'platform_account_signup', 'candidate', req.candidateId, domain);
  return { found: true, created: true, accountId: id, status: 'Pending', email: email, password: password };
}

function apiUpdatePlatformAccount_(req) {
  var acct = findRow('PlatformAccounts', 'AccountID', req.accountId);
  if (!acct) throw new Error('Platform account not found: ' + req.accountId);
  updateRow('PlatformAccounts', acct._row, { Status: req.status, Notes: req.notes || acct.Notes, UpdatedAt: new Date() });
  logActivity('extension', 'platform_account_' + req.status, 'candidate', acct.CandidateID, acct.ATSDomain);
  return { updated: true };
}

/** Latest account for candidate + site, ignoring sign-ups that failed outright. */
function latestAccount_(candidateId, domain) {
  var rows = readRows('PlatformAccounts').filter(function (a) {
    return a.CandidateID === candidateId && a.ATSDomain === domain && a.Status !== 'Failed';
  });
  rows.sort(function (a, b) { return new Date(b.CreatedAt) - new Date(a.CreatedAt); });
  return rows[0] || null;
}

/** 14 characters with upper, lower, digit and symbol - satisfies typical ATS password rules. */
function generateSitePassword_() {
  var sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!@#$%*'];
  var all = sets.join('');
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + Utilities.getUuid() + Date.now());
  var chars = sets.map(function (s, i) { return s.charAt((bytes[i] & 0xff) % s.length); });
  for (var i = 4; i < 14; i++) chars.push(all.charAt((bytes[i] & 0xff) % all.length));
  for (var j = chars.length - 1; j > 0; j--) {
    var k = (bytes[14 + j] & 0xff) % (j + 1);
    var t = chars[j]; chars[j] = chars[k]; chars[k] = t;
  }
  return chars.join('');
}

/** Adds any missing header columns to an existing sheet (sheets created before a column existed). */
function ensureColumns_(name, cols) {
  var sh = sheet_(name);
  var map = getHeaderMap_(sh);
  var next = sh.getLastColumn() + 1;
  cols.forEach(function (c) { if (!map[c]) sh.getRange(1, next++).setValue(c); });
}

/**
 * NEW: exports a generated CV/cover letter Google Doc as a PDF and returns it
 * base64-encoded, so the Playwright worker can attach the real file to an
 * application form without needing its own separate Google auth - it reuses
 * the same API_TOKEN it already authenticates with. Fine for CV/cover-letter
 * sized documents; not meant for large files (Apps Script response limits).
 */
/**
 * Exports a generated Google Doc (CV / cover letter) for upload by the
 * extension or worker. req.format: 'pdf' (default), 'docx' for ATS upload
 * fields that reject PDFs, or 'txt' to paste a cover letter into a textarea.
 */
function apiExportDocumentPdf_(req) {
  var id = extractDocId_(req.docUrl);
  if (!id) throw new Error('Could not parse a Google Doc ID from docUrl: ' + req.docUrl);
  var format = req.format || 'pdf';

  if (format === 'txt') {
    return { text: DocumentApp.openById(id).getBody().getText() };
  }

  if (format === 'docx') {
    var res = UrlFetchApp.fetch('https://docs.google.com/document/d/' + id + '/export?format=docx', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) throw new Error('DOCX export failed: HTTP ' + res.getResponseCode());
    return {
      base64: Utilities.base64Encode(res.getBlob().getBytes()),
      filename: DriveApp.getFileById(id).getName() + '.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    };
  }

  var blob = DriveApp.getFileById(id).getAs(MimeType.PDF);
  return { base64: Utilities.base64Encode(blob.getBytes()), filename: blob.getName(), mimeType: 'application/pdf' };
}
 
function extractDocId_(url) {
  // Accepts both .../d/<id>/edit and Drive's .../open?id=<id> forms
  var m = String(url || '').match(/\/d\/([-\w]{25,})/) || String(url || '').match(/[?&]id=([-\w]{25,})/);
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
               url: p.JobURL, status: p.Status, source: p.Source };
    }),
    log: readRows('ActivityLog').slice(-60).reverse().map(function (l) {
      return { t: String(l.Timestamp), actor: l.Actor, action: l.Action, detail: l.Detail };
    }),
    followUps: readRows('FollowUps').map(function (f) {
      return { id: f.FollowUpID, cand: f.CandidateID, type: f.Type, company: f.Company,
               title: f.JobTitle, due: String(f.DueDate), status: f.Status, notes: f.Notes };
    }),
    // Passwords are deliberately not included - see dashRevealAccountPassword
    accounts: (sheet_('PlatformAccounts') ? readRows('PlatformAccounts') : []).map(function (a) {
      return { id: a.AccountID, cand: a.CandidateID, site: a.ATSDomain, email: a.Email || '',
               status: a.Status, notes: a.Notes, updated: String(a.UpdatedAt || a.CreatedAt) };
    }),
    report: latestReport_()
  };
}
 
/**
 * Shows a saved site password so a reviewer can log in by hand (e.g. to click
 * an email-verification link and finish an account). The web app is reachable
 * anonymously, so this only answers signed-in Google accounts listed in Config
 * ACCOUNT_REVEAL_EMAILS - by default just the account that deployed the script.
 * Every reveal is logged.
 */
function dashRevealAccountPassword(accountId) {
  var viewer = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  var allowed = (getConfig('ACCOUNT_REVEAL_EMAILS') || Session.getEffectiveUser().getEmail())
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  if (!viewer || allowed.indexOf(viewer) === -1) {
    throw new Error('Only authorised reviewers can reveal passwords. Open the dashboard while signed in to an ' +
      'authorised Google account (Config: ACCOUNT_REVEAL_EMAILS).');
  }
  var acct = findRow('PlatformAccounts', 'AccountID', accountId);
  if (!acct) throw new Error('Account not found');
  var pw = PropertiesService.getScriptProperties().getProperty(ACCOUNT_PW_PREFIX_ + accountId);
  if (!pw) {
    var cand = findRow('Candidates', 'CandidateID', acct.CandidateID);
    pw = cand && cand.ApplicationPassword ? String(cand.ApplicationPassword) : '';
  }
  logActivity(viewer, 'account_password_revealed', 'account', accountId, acct.ATSDomain);
  return { site: acct.ATSDomain, email: acct.Email || '', password: pw || '(no password saved)' };
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
 
/** Queue every 'Found' prospect for a candidate in one action. Reports how many were left for manual review too. */
function dashQueueAllFound(candidateId) {
  var queued = 0, manualReview = 0;
  readRows('Prospects').forEach(function (p) {
    if (p.CandidateID !== candidateId) return;
    if (p.Status === 'Found') {
      updateRow('Prospects', p._row, { Status: 'Queued' });
      queued++;
    } else if (p.Status === 'Found - Manual Review') {
      manualReview++;
    }
  });
  logActivity(Session.getActiveUser().getEmail() || 'reviewer', 'prospects_bulk_queued', 'candidate', candidateId, queued + ' queued, ' + manualReview + ' left for manual review');
  return { queued: queued, manualReview: manualReview };
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
  // www.lemon.io and lemon.io are the same account
  return (m ? m[1] : s).toLowerCase().replace(/^www\./, '');
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
 



































