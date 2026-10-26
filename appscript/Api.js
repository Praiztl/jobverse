/**
 * JOBVERSE MVP - Api.gs
 * One web app deployment serves both:
 *  - GET  (no params)      -> the dashboard (Dashboard.html)
 *  - POST (JSON + token)   -> the Chrome extension API
 *
 * Extension requests are authenticated with the shared API_TOKEN from Config.
 *
 * The deployment has to stay "Anyone, even anonymous" so the extension and
 * worker can POST without a Google login, which means anyone holding the
 * /exec URL can GET it too. The dashboard is therefore only served to a
 * signed-in account listed in DASHBOARD_EMAILS (default: the deploying
 * account) or with ?key=<DASHBOARD_KEY>, and every dash* RPC re-checks the
 * key. Everything else server-side is private (trailing underscore), so
 * google.script.run can't reach it.
 */

function doGet(e) {
  var key = (e && e.parameter && e.parameter.key) || '';
  if (!dashAccessAllowed_(key)) {
    // Plain text, not HtmlService: an HtmlService page would carry google.script.run
    return ContentService.createTextOutput('Access denied. Open the Jobverse Console with its ?key= link, ' +
      'or while signed in to an authorised Google account.');
  }
  var t = HtmlService.createTemplateFromFile('Dashboard');
  t.dashKey = key;
  return t.evaluate()
    .setTitle('Jobverse Console')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** True for the dashboard key, or a signed-in account in DASHBOARD_EMAILS (default: the deployer). */
function dashAccessAllowed_(key) {
  var expected = getConfig_('DASHBOARD_KEY');
  if (expected && key && key === expected) return true;
  var viewer = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!viewer) return false;
  var allowed = (getConfig_('DASHBOARD_EMAILS') || Session.getEffectiveUser().getEmail())
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  return allowed.indexOf(viewer) > -1;
}

/** First line of every dash* RPC: google.script.run calls are reachable by anyone who has the page. */
function requireDashAccess_(key) {
  if (!dashAccessAllowed_(key)) throw new Error('Access denied - reopen the Jobverse Console with its ?key= link.');
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    var token = getConfig_('API_TOKEN');
    if (!token || req.token !== token) throw new Error('Unauthorised');
    var handlers = {
      listCandidates: apiListCandidates_,
      getCandidatePayload: apiGetCandidatePayload_,
      analyseJob: apiAnalyseJob_,
      analyseJobPosting: apiAnalyseJobPosting_,
      buildTailoredCV: apiBuildTailoredCV_,
      buildCoverLetter: apiBuildCoverLetter_,
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
  return readRows_('Candidates', ['CandidateID', 'FullName', 'Email', 'Status', 'Active'])
    .filter(function (c) { return c.Status !== 'Archived' && String(c.Active).toUpperCase() !== 'FALSE'; })
    .map(function (c) {
      return { id: c.CandidateID, name: c.FullName, email: c.Email, status: c.Status };
    });
}
 
function apiGetCandidatePayload_(req) {
  var c = findRow_('Candidates', 'CandidateID', req.candidateId);
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
  var jobId = analysedJobId_(req.candidateId, req.jobUrl) || runJobAnalyst_(req.candidateId, req.jobUrl, req.jdText, req.ats);
  var job = findRow_('Jobs', 'JobID', jobId);
  var cv = latestDocForJob_('CVVersions', jobId) ||
    findRow_('CVVersions', 'VersionID', runResumeBuilder_(req.candidateId, jobId, req.tone));
  var letter = latestDocForJob_('CoverLetters', jobId) ||
    findRow_('CoverLetters', 'LetterID', runCoverLetterBuilder_(req.candidateId, jobId, req.tone));

  return {
    jobId: jobId, company: job.Company, title: job.JobTitle, suitability: job.SuitabilityScore,
    cvUrl: cv.DocURL, letterUrl: letter.DocURL
  };
}

/**
 * The job this candidate already has analysed for this URL, if any. A job run
 * again - its tab reloaded mid-way, a retry, the worker and the extension on
 * the same prospect - reuses its analysis and documents instead of writing
 * (and queueing for review) another CV and cover letter every time.
 */
function analysedJobId_(candidateId, jobUrl) {
  if (!jobUrl) return '';
  var key = normaliseJobKey_(jobUrl);
  var jobs = readRows_('Jobs', ['JobID', 'CandidateID', 'JobURL']);
  for (var i = jobs.length - 1; i >= 0; i--) {
    if (jobs[i].CandidateID === candidateId && jobs[i].JobURL && normaliseJobKey_(jobs[i].JobURL) === key) return jobs[i].JobID;
  }
  return '';
}

/** Newest CV version / cover letter written for a job, or null. Revisions are newer rows, so they win. */
function latestDocForJob_(sheetName, jobId) {
  var rows = readRows_(sheetName, ['JobID', 'DocURL']).filter(function (r) { return r.JobID === jobId && r.DocURL; });
  return rows.length ? rows[rows.length - 1] : null;
}

/*
 * analyseJob split into three calls so the extension can show each stage and
 * build the CV and cover letter in parallel (two concurrent executions).
 * analyseJob stays for the worker and older extension builds.
 */
function apiAnalyseJobPosting_(req) {
  var jobId = analysedJobId_(req.candidateId, req.jobUrl) || runJobAnalyst_(req.candidateId, req.jobUrl, req.jdText, req.ats);
  var job = findRow_('Jobs', 'JobID', jobId);
  // Build the candidate profile now, so the parallel CV and letter calls
  // don't both try to create it.
  var cand = findRow_('Candidates', 'CandidateID', req.candidateId);
  if (cand && !cand.AIProfileJSON) runResumeAnalyst_(req.candidateId);
  return { jobId: jobId, company: job.Company, title: job.JobTitle, suitability: job.SuitabilityScore };
}

function apiBuildTailoredCV_(req) {
  var existing = latestDocForJob_('CVVersions', req.jobId);
  if (existing) return { cvUrl: existing.DocURL };
  var cvId = runResumeBuilder_(req.candidateId, req.jobId, req.tone);
  return { cvUrl: findRow_('CVVersions', 'VersionID', cvId).DocURL };
}

function apiBuildCoverLetter_(req) {
  var existing = latestDocForJob_('CoverLetters', req.jobId);
  if (existing) return { letterUrl: existing.DocURL };
  var letterId = runCoverLetterBuilder_(req.candidateId, req.jobId, req.tone);
  return { letterUrl: findRow_('CoverLetters', 'LetterID', letterId).DocURL };
}

function apiPrecheckApplication_(req) {
  var cand = findRow_('Candidates', 'CandidateID', req.candidateId);
  if (!cand) throw new Error('Candidate not found');
  if (String(cand.Active).toUpperCase() === 'FALSE') return { block: 'inactive' };
 
  var allApps = readRows_('Applications', ['CandidateID', 'Status', 'DedupeHash', 'CreatedAt']);
 
  var basis = req.candidateId + '|' + normaliseJobKey_(req.jobUrl, req.company, req.jobTitle);
  var hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, basis)).slice(0, 24);
  if (allApps.some(function (a) { return a.DedupeHash === hash && countsAsApplication_(a.Status); })) return { block: 'duplicate' };
 
  var target = parseInt(cand.TargetApplications || getConfig_('DEFAULT_TARGET_APPLICATIONS') || '50', 10);
  var totalForCand = allApps.filter(function (a) { return a.CandidateID === req.candidateId && countsAsApplication_(a.Status); }).length;
  if (target > 0 && totalForCand >= target) return { block: 'targetMet', target: target };
 
  var limit = parseInt(getConfig_('MAX_APPS_PER_CANDIDATE_PER_DAY') || '15', 10);
  var today = Utilities.formatDate(new Date(), 'GMT', 'yyyy-MM-dd');
  var todayCount = allApps.filter(function (a) {
    return a.CandidateID === req.candidateId &&
      Utilities.formatDate(new Date(a.CreatedAt), 'GMT', 'yyyy-MM-dd') === today;
  }).length;
  if (todayCount >= limit) return { block: 'throttled', limit: limit };
 
  return { block: null, target: target, doneSoFar: totalForCand };
}
 
function apiStartApplication_(req) {
  // The worker and the extension can start the same job at once: check-then-append under one lock
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return startApplicationLocked_(req); } finally { lock.releaseLock(); }
}

function startApplicationLocked_(req) {
  var cand = findRow_('Candidates', 'CandidateID', req.candidateId);
  if (!cand) throw new Error('Candidate not found');
 
  if (String(cand.Active).toUpperCase() === 'FALSE') return { inactive: true };
 
  var basis = req.candidateId + '|' + normaliseJobKey_(req.jobUrl, req.company, req.jobTitle);
  var hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, basis)).slice(0, 24);
 
  var allApps = readRows_('Applications', ['CandidateID', 'Status', 'DedupeHash', 'CreatedAt']);
  var dupe = allApps.some(function (a) { return a.DedupeHash === hash && countsAsApplication_(a.Status); });
  if (dupe) return { duplicate: true };
 
  var target = parseInt(cand.TargetApplications || getConfig_('DEFAULT_TARGET_APPLICATIONS') || '50', 10);
  var totalForCand = allApps.filter(function (a) {
    return a.CandidateID === req.candidateId && countsAsApplication_(a.Status);
  }).length;
  if (target > 0 && totalForCand >= target) return { targetMet: true, target: target };
 
  var limit = parseInt(getConfig_('MAX_APPS_PER_CANDIDATE_PER_DAY') || '15', 10);
  var today = Utilities.formatDate(new Date(), 'GMT', 'yyyy-MM-dd');
  var todayCount = allApps.filter(function (a) {
    return a.CandidateID === req.candidateId &&
      Utilities.formatDate(new Date(a.CreatedAt), 'GMT', 'yyyy-MM-dd') === today;
  }).length;
  if (todayCount >= limit) return { throttled: true, limit: limit };
 
  var appId = newId_('APP');
  appendObject_('Applications', {
    ApplicationID: appId, CreatedAt: new Date(), CandidateID: req.candidateId,
    JobID: req.jobId || '', Company: req.company || '', JobTitle: req.jobTitle || '',
    JobURL: req.jobUrl || '', ATS: req.ats || '', Status: 'In Progress', DedupeHash: hash
  });
  logActivity_('extension', 'application_started', 'application', appId, req.company + ' - ' + req.jobTitle);
  return { duplicate: false, applicationId: appId };
}
 
function apiAnswerQuestion_(req) {
  var a = answerScreeningQuestion_(req.candidateId, req.jobId, req.question);
  return { answer: a, needsHuman: a === 'NEEDS_HUMAN' };
}

/**
 * NEW: AI-powered field answering for individual form fields. The ATS module
 * extracts field info (label, type, options) and asks the AI what to fill in.
 * This replaces hardcoded field mapping with dynamic AI decision-making.
 * ENHANCED: Now accepts semantic field representation with context and returns structured actions.
 */
function apiAnswerField_(req) {
  var cand = findRow_('Candidates', 'CandidateID', req.candidateId);
  if (!cand) throw new Error('Candidate not found');
  var job = req.jobId ? findRow_('Jobs', 'JobID', req.jobId) : null;

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

  var decision = callClaudeJSON_(
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

  saveAIOutput_('FieldAnswerer', req.candidateId, req.jobId, { 
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
  var cand = findRow_('Candidates', 'CandidateID', req.candidateId);
  if (!cand) throw new Error('Candidate not found');
  var job = req.jobId ? findRow_('Jobs', 'JobID', req.jobId) : null;

  var elementInfo = req.elementInfo || {};
  var prompt = 'Decide whether to click a button/link during job application form filling. ' +
    'Consider the context and whether clicking would help complete the application. ' +
    'Return JSON with { "shouldClick": boolean, "reason": string }. ' +
    'If uncertain, set shouldClick to false and explain why in reason.';

  var decision = callClaudeJSON_(
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

  saveAIOutput_('ClickDecider', req.candidateId, req.jobId, { elementInfo: elementInfo, decision: decision });

  return {
    shouldClick: decision.shouldClick || false,
    reason: decision.reason || '',
    needsHuman: !decision.shouldClick && /human/i.test(String(decision.reason || ''))
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
  var decision = callClaudeJSON_(
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
    'ALREADY TRIED. Job posts (Notion pages, blogs, careers pages) often end with "How to apply: please apply ' +
    'via this form -> <link>" where the link text is just a name (e.g. "The Acme Creative Network") - each ' +
    'candidate\'s "context" field is the text around it and HOW-TO-APPLY TEXT quotes those instructions, so a ' +
    'link the instructions point to IS the way to apply, whatever its own text says. Pages may be in any language (e.g. German "Jetzt bewerben", "Weiter", "Registrieren"). ' +
    'If the page says the job is closed or expired, answer "closed". If the page still looks like it is ' +
    'loading (spinner, "Loading...", skeleton placeholders, almost no text or elements) answer "wait". ' +
    'A site requiring an account or sign-in is NEVER a reason to answer "human". Answer "human" only ' +
    'for things the browser cannot do (payment, identity documents, an assessment to sit) or when no ' +
    'element plausibly leads towards the application. ' +
    'Return JSON: {"action": "click|closed|wait|human", "index": number|null, "reason": "short string"}',
    'TARGET JOB: ' + (req.jobTitle || 'unknown') + ' at ' + (req.company || 'unknown') +
    '\nCURRENT URL: ' + (req.url || '') +
    '\nPAGE TITLE: ' + (req.title || '') +
    (req.loading ? '\nNOTE: the browser thinks this page may still be loading.' : '') +
    '\n\nPAGE TEXT (start):\n' + String(req.pageText || '').slice(0, 3000) +
    (req.applySection ? '\n\nHOW-TO-APPLY TEXT (found further down the page):\n' + String(req.applySection).slice(0, 1500) : '') +
    '\n\nCLICKABLE CANDIDATES:\n' + JSON.stringify(candidates) +
    '\n\nALREADY TRIED: ' + JSON.stringify(req.tried || []),
    300
  );
  saveAIOutput_('NextStepChooser', req.candidateId || '', '', { url: req.url, candidates: candidates, decision: decision });

  var action = ['click', 'closed', 'wait', 'human'].indexOf(decision.action) > -1 ? decision.action : 'human';
  var index = action === 'click' ? Number(decision.index) : null;
  if (action === 'click' && !candidates.some(function (c) { return c.index === index; })) action = 'human';
  return { action: action, index: action === 'click' ? index : null, reason: decision.reason || '' };
}

function apiRequestReview_(req) {
  var taskId = newId_('REV');
  appendObject_('ReviewQueue', {
    TaskID: taskId, CreatedAt: new Date(), Type: 'Submission',
    CandidateID: req.candidateId, JobID: req.jobId || '', RefID: req.applicationId,
    Summary: req.company + ' - ' + req.jobTitle,
    AIFindings: JSON.stringify(req.snapshot || {}).slice(0, 40000),
    Status: 'Awaiting Human'
  });
  var app = findRow_('Applications', 'ApplicationID', req.applicationId);
  if (app) {
    // Who filled it decides who submits it after approval (see dashDecide) - never both
    ensureColumns_('Applications', ['FilledBy']);
    updateRow_('Applications', app._row, { Status: 'Awaiting Review', FilledBy: req.filledBy === 'worker' ? 'worker' : 'extension' });
  }
  notifyReviewers_('Review needed: ' + req.company + ' - ' + req.jobTitle,
    'A completed application is paused for approval. Open the Jobverse Console review queue. Task ' + taskId);
  return { taskId: taskId };
}
 
function apiCheckApproval_(req) {
  var t = findRow_('ReviewQueue', 'TaskID', req.taskId);
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
  var app = findRow_('Applications', 'ApplicationID', req.applicationId);
  var reason = req.reason || 'CAPTCHA';
  if (app) updateRow_('Applications', app._row, { Status: reason + ' - Human Needed' });
  logActivity_('extension', 'automation_pause', 'application', req.applicationId, reason + ': ' + (req.jobUrl || ''));
  notifyReviewers_(reason + ' needs a human: ' + (req.company || ''),
    'Application ' + req.applicationId + ' hit "' + reason + '" at ' + (req.jobUrl || '') +
    '. Open the tab and resolve it' + (reason === 'CAPTCHA' ? ', then the extension resumes automatically.' : '.'));
  return { paused: true };
}
 
function apiConfirmSubmission_(req) {
  var app = findRow_('Applications', 'ApplicationID', req.applicationId);
  if (!app) throw new Error('Application not found');
 
  var shotUrl = '';
  if (req.screenshotBase64) {
    var blob = Utilities.newBlob(Utilities.base64Decode(req.screenshotBase64), 'image/png',
      req.applicationId + '-confirmation.png');
    var f = DriveApp.getFolderById(getConfig_('ROOT_FOLDER_ID'))
      .getFoldersByName('Screenshots').next().createFile(blob);
    shotUrl = f.getUrl();
  }
  var submittedAt = new Date();
  updateRow_('Applications', app._row, {
    Status: 'Submitted', SubmittedAt: submittedAt, ConfirmationScreenshotURL: shotUrl
  });
  logActivity_('extension', 'application_submitted', 'application', req.applicationId, app.Company);
  app.SubmittedAt = submittedAt;
  // The submission is recorded either way - a follow-up hiccup mustn't make the caller think it wasn't
  try { createSubmissionFollowUp_(app); }
  catch (e) { logActivity_('system', 'followup_error', 'application', req.applicationId, e.message); }
  return { recorded: true, screenshotUrl: shotUrl };
}
 
function apiReportError_(req) {
  var app = req.applicationId ? findRow_('Applications', 'ApplicationID', req.applicationId) : null;
  if (app) updateRow_('Applications', app._row, {
    Status: 'Failed', ErrorLog: (String(app.ErrorLog || '') + '\n' + req.message).slice(0, 5000)
  });
  logActivity_('extension', 'error', 'application', req.applicationId || '-', req.message);
  return { logged: true };
}
 
/**
 * FIXED: now includes an `ats` field the worker needs to pick the right
 * automation module - Prospects.gs only ever stored ATS support as a Status
 * flag ('Found' vs 'Found - Manual Review'), never the ATS name itself, so
 * this had nothing to give the worker until now.
 */
function apiListProspects_(req) {
  return readRows_('Prospects', ['ProspectID', 'CandidateID', 'Status', 'JobURL', 'Company', 'JobTitle'])
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
  var p = findRow_('Prospects', 'ProspectID', req.prospectId);
  if (!p) throw new Error('Prospect not found');
  updateRow_('Prospects', p._row, { Status: req.status, Notes: req.notes || p.Notes });
  logActivity_('extension', 'prospect_status', 'prospect', req.prospectId, req.status);
  return { updated: true };
}
 
function apiGetCandidateCVText_(req) {
  var c = findRow_('Candidates', 'CandidateID', req.candidateId);
  if (!c) throw new Error('Candidate not found');
  if (!c.CVFileID) return { text: '' };
  return { text: extractFileText_(c.CVFileID).slice(0, 40000) };
}
 
function apiGenerateNHSStatement_(req) {
  var jobId = runJobAnalyst_(req.candidateId, req.jobUrl, req.jdText, 'NHS Jobs');
  var result = runNHSSupportingStatement_(req.candidateId, jobId, req.tone || 'NHS');
  return { jobId: jobId, statementText: result.text, docUrl: result.docUrl };
}
 
function apiCreateNHSFollowUp_(req) {
  var id = createNHSTracFollowUp_(req.candidateId, req.applicationId, req.company, req.jobTitle, req.closingDate);
  return { followUpId: id };
}
 
/**
 * NEW: checks whether an account already exists for this candidate on this
 * ATS tenant (by domain). The worker calls this before attempting to sign
 * up or sign in on a wall it detects.
 */
function apiCheckPlatformAccount_(req) {
  var domain = normaliseDomain_(req.atsDomain || req.jobUrl);
  var matches = readRows_('PlatformAccounts').filter(function (a) {
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
  var id = newId_('ACC');
  appendObject_('PlatformAccounts', {
    AccountID: id, CreatedAt: new Date(), CandidateID: req.candidateId,
    ATSDomain: domain, Status: req.status, Notes: req.notes || '', UpdatedAt: new Date()
  });
  logActivity_('extension', 'platform_account_' + req.status, 'candidate', req.candidateId, domain);
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
  var cand = findRow_('Candidates', 'CandidateID', req.candidateId);
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

  var id = newId_('ACC');
  var password = generateSitePassword_();
  // Saved before the sign-up form is even submitted, so the password is never lost
  PropertiesService.getScriptProperties().setProperty(ACCOUNT_PW_PREFIX_ + id, password);
  appendObject_('PlatformAccounts', {
    AccountID: id, CreatedAt: new Date(), CandidateID: req.candidateId, ATSDomain: domain, Email: email,
    LoginURL: req.jobUrl || '', Status: 'Pending', Notes: 'Sign-up started by the extension', UpdatedAt: new Date()
  });
  logActivity_('extension', 'platform_account_signup', 'candidate', req.candidateId, domain);
  return { found: true, created: true, accountId: id, status: 'Pending', email: email, password: password };
}

function apiUpdatePlatformAccount_(req) {
  var acct = findRow_('PlatformAccounts', 'AccountID', req.accountId);
  if (!acct) throw new Error('Platform account not found: ' + req.accountId);
  updateRow_('PlatformAccounts', acct._row, { Status: req.status, Notes: req.notes || acct.Notes, UpdatedAt: new Date() });
  logActivity_('extension', 'platform_account_' + req.status, 'candidate', acct.CandidateID, acct.ATSDomain);
  return { updated: true };
}

/** Latest account for candidate + site, ignoring sign-ups that failed outright. */
function latestAccount_(candidateId, domain) {
  var rows = readRows_('PlatformAccounts').filter(function (a) {
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
  var added = false;
  cols.forEach(function (c) { if (!map[c]) { sh.getRange(1, next++).setValue(c); added = true; } });
  if (added) clearHeaderCache_(sh);
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
  var cvByJob = {}, clByJob = {}, taskByApp = {};
  readRows_('CVVersions', ['JobID', 'DocURL']).forEach(function (v) { cvByJob[v.JobID] = v.DocURL; });
  readRows_('CoverLetters', ['JobID', 'DocURL']).forEach(function (l) { clByJob[l.JobID] = l.DocURL; });
  // The approved Submission review, so the extension can submit an approved application whose tab is gone
  readRows_('ReviewQueue', ['TaskID', 'Type', 'RefID']).forEach(function (t) {
    if (t.Type === 'Submission') taskByApp[t.RefID] = t.TaskID;
  });

  return readRows_('Applications', ['ApplicationID', 'CandidateID', 'JobID', 'Company', 'JobTitle', 'JobURL', 'ATS', 'Status'])
    .filter(function (a) { return a.Status === req.status && (!req.candidateId || a.CandidateID === req.candidateId); })
    .map(function (a) {
      return {
        id: a.ApplicationID, candidateId: a.CandidateID, jobId: a.JobID, company: a.Company,
        title: a.JobTitle, url: a.JobURL, ats: a.ATS, status: a.Status,
        cvUrl: cvByJob[a.JobID] || '', letterUrl: clByJob[a.JobID] || '', taskId: taskByApp[a.ApplicationID] || ''
      };
    });
}
 
/* ------------------------- dashboard RPC (google.script.run) ------------------------- */
 
function dashData(key) {
  requireDashAccess_(key);
  requireDashAccess_(key);
  // Only the columns the dashboard shows - Candidates.AIProfileJSON and
  // ReviewQueue.AIFindings alone can be tens of KB per row.
  var apps = readRows_('Applications', ['ApplicationID', 'CandidateID', 'Company', 'JobTitle', 'ATS', 'Status',
    'JobURL', 'SubmittedAt', 'ConfirmationScreenshotURL', 'Outcome']);
  var countByCand = {};
  apps.forEach(function (a) {
    if (countsAsApplication_(a.Status)) countByCand[a.CandidateID] = (countByCand[a.CandidateID] || 0) + 1;
  });
  return {
    candidates: readRows_('Candidates', ['CandidateID', 'FullName', 'Email', 'Status', 'Active',
      'TargetApplications', 'PreferredRoles', 'Location', 'CreatedAt']).map(function (c) {
      return { id: c.CandidateID, name: c.FullName, email: c.Email, status: c.Status,
               active: String(c.Active).toUpperCase() !== 'FALSE',
               target: parseInt(c.TargetApplications || '0', 10) || 0,
               applied: countByCand[c.CandidateID] || 0,
               roles: c.PreferredRoles, location: c.Location, created: String(c.CreatedAt) };
    }),
    applications: apps.map(function (a) {
      return { id: a.ApplicationID, cand: a.CandidateID, company: a.Company, title: a.JobTitle,
               ats: a.ATS, status: a.Status, url: a.JobURL, submitted: String(a.SubmittedAt || ''),
               shot: a.ConfirmationScreenshotURL, outcome: a.Outcome };
    }),
    reviews: awaitingReviews_(),
    prospects: readRows_('Prospects', ['ProspectID', 'CandidateID', 'Company', 'JobTitle', 'JobURL', 'Status',
      'Source', 'FoundAt']).map(function (p) {
      return { id: p.ProspectID, cand: p.CandidateID, company: p.Company, title: p.JobTitle,
               url: p.JobURL, status: p.Status, source: p.Source, found: toEpochMs_(p.FoundAt) };
    }),
    log: recentActivity_(60),
    followUps: readRows_('FollowUps').map(function (f) {
      return { id: f.FollowUpID, cand: f.CandidateID, type: f.Type, company: f.Company,
               title: f.JobTitle, due: sheetDateIso_(f.DueDate), status: f.Status, notes: f.Notes };
    }),
    // Passwords are deliberately not included - see dashRevealAccountPassword
    accounts: readRows_('PlatformAccounts').map(function (a) {
      return { id: a.AccountID, cand: a.CandidateID, site: a.ATSDomain, email: a.Email || '',
               status: a.Status, notes: a.Notes, updated: String(a.UpdatedAt || a.CreatedAt) };
    }),
    report: latestReport_()
  };
}

/**
 * ReviewQueue rows still waiting on a human, in one read and without
 * AIFindings (up to 40 KB each). The dashboard fetches findings per card
 * with dashReviewFindings when a reviewer opens it.
 */
function awaitingReviews_() {
  var waiting = readRows_('ReviewQueue', ['TaskID', 'Type', 'CandidateID', 'Summary', 'AIScore', 'Status', 'CreatedAt'])
    .filter(function (t) { return t.Status === 'Awaiting Human'; });

  // One card per document per job: when the same job's CV / cover letter / NHS
  // statement was written more than once (re-runs, retries, a duplicate prospect),
  // only the newest waits for a human and the older ones are marked Superseded.
  // Submissions are never merged - each is a separate application.
  var newest = {}, superseded = [];
  waiting.forEach(function (t) {
    if (!REVISABLE_DOCS_[t.Type]) return;
    var key = t.Type + '|' + t.CandidateID + '|' + String(t.Summary).toLowerCase().trim();
    var prev = newest[key];
    if (!prev) { newest[key] = t; return; }
    var tIsNewer = ((toEpochMs_(t.CreatedAt) - toEpochMs_(prev.CreatedAt)) || (t._row - prev._row)) > 0;
    superseded.push(tIsNewer ? prev : t);
    if (tIsNewer) newest[key] = t;
  });
  if (superseded.length) {
    setColumnForRows_('ReviewQueue', 'Status', superseded.map(function (t) { return t._row; }), 'Superseded');
    logActivity_('system', 'reviews_superseded', 'review', '-',
      superseded.length + ' older duplicate review(s) superseded: ' + superseded.map(function (t) { return t.TaskID; }).join(', ').slice(0, 400));
  }

  return waiting
    .filter(function (t) { return superseded.indexOf(t) === -1; })
    .map(function (t) {
      return { id: t.TaskID, type: t.Type, cand: t.CandidateID, summary: t.Summary,
               score: t.AIScore, created: String(t.CreatedAt), createdMs: toEpochMs_(t.CreatedAt) };
    });
}

/** Full AI findings for one review card, loaded when the reviewer opens it. */
function dashReviewFindings(key, taskId) {
  requireDashAccess_(key);
  var t = findRow_('ReviewQueue', 'TaskID', taskId);
  if (!t) throw new Error('Review item not found - it may have been decided already.');
  return { id: t.TaskID, findings: t.AIFindings || '' };
}

/** The newest `n` ActivityLog entries, newest first, without reading the whole log. */
function recentActivity_(n) {
  var sh = sheet_('ActivityLog');
  var last = sh ? sh.getLastRow() : 0;
  if (last < 2) return [];
  var from = Math.max(2, last - n + 1);
  return sh.getRange(from, 1, last - from + 1, 6).getValues().reverse().map(function (l) {
    return { t: String(l[0]), actor: l[1], action: l[2], detail: l[5] };
  });
}

/**
 * A sheet date cell (Date object or typed-in text) as milliseconds since 1970,
 * or 0 when it's blank or unreadable. google.script.run can't pass Date
 * objects to the page, but it can pass numbers, and numbers sort cleanly.
 */
function toEpochMs_(v) {
  if (!v) return 0;
  var t = (v instanceof Date) ? v.getTime() : new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

/**
 * Shows a saved site password so a reviewer can log in by hand (e.g. to click
 * an email-verification link and finish an account). The web app is reachable
 * anonymously, so this only answers signed-in Google accounts listed in Config
 * ACCOUNT_REVEAL_EMAILS - by default just the account that deployed the script.
 * Every reveal is logged.
 */
function dashRevealAccountPassword(key, accountId) {
  requireDashAccess_(key);
  var viewer = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  var allowed = (getConfig_('ACCOUNT_REVEAL_EMAILS') || Session.getEffectiveUser().getEmail())
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  if (!viewer || allowed.indexOf(viewer) === -1) {
    throw new Error('Only authorised reviewers can reveal passwords. Open the dashboard while signed in to an ' +
      'authorised Google account (Config: ACCOUNT_REVEAL_EMAILS).');
  }
  var acct = findRow_('PlatformAccounts', 'AccountID', accountId);
  if (!acct) throw new Error('Account not found');
  var pw = PropertiesService.getScriptProperties().getProperty(ACCOUNT_PW_PREFIX_ + accountId);
  if (!pw) {
    var cand = findRow_('Candidates', 'CandidateID', acct.CandidateID);
    pw = cand && cand.ApplicationPassword ? String(cand.ApplicationPassword) : '';
  }
  logActivity_(viewer, 'account_password_revealed', 'account', accountId, acct.ATSDomain);
  return { site: acct.ATSDomain, email: acct.Email || '', password: pw || '(no password saved)' };
}

/**
 * Records a reviewer's decision. What "Send back" (revise) does depends on
 * the item:
 *  - CV / CoverLetter / NHSStatement: a new version is generated in the
 *    background from the reviewer's notes and the AI findings, and lands back
 *    in the Review queue (see processRevisionQueue in Revisions.gs).
 *  - Submission: the application is not submitted. It's marked Rejected and
 *    can be re-queued from Applications with Retry.
 */
function dashDecide(key, taskId, decision, notes) {
  requireDashAccess_(key);
  var t = findRow_('ReviewQueue', 'TaskID', taskId);
  if (!t) throw new Error('Task not found');
  // A double click or a second reviewer: the first decision stands
  if (t.Status !== 'Awaiting Human') return { already: true, decision: t.Decision };
  var who = Session.getActiveUser().getEmail();
  updateRow_('ReviewQueue', t._row, {
    Status: 'Decided', Decision: decision, Notes: notes || '',
    Reviewer: who, DecidedAt: new Date()
  });
  if (t.Type === 'Submission') {
    var app = findRow_('Applications', 'ApplicationID', t.RefID);
    if (app) updateRow_('Applications', app._row, {
      Status: decision !== 'approve' ? 'Rejected' : (submittedByWorker_(app, t) ? 'Approved - Submitting' : 'Approved - Extension')
    });
  }
  var revising = false;
  var docTab = REVISABLE_DOCS_[t.Type];
  if (docTab) {
    var d = findRow_(docTab.sheet, docTab.idField, t.RefID);
    if (d) updateRow_(docTab.sheet, d._row, { ReviewStatus: decision });
    if (decision === 'revise') { scheduleRevisions_(); revising = true; }
  }
  logActivity_(who || 'reviewer', 'review_' + decision, t.Type, t.RefID, notes || '');
  return { decided: true, revising: revising };
}

function dashGenerate(key, candidateId, jdText, jobUrl, tone) {
  requireDashAccess_(key);
  var jobId = runJobAnalyst_(candidateId, jobUrl || '', jdText, '');
  var cvId = runResumeBuilder_(candidateId, jobId, tone);
  var clId = runCoverLetterBuilder_(candidateId, jobId, tone);
  var cv = findRow_('CVVersions', 'VersionID', cvId);
  var cl = findRow_('CoverLetters', 'LetterID', clId);
  return { jobId: jobId, cvUrl: cv.DocURL, letterUrl: cl.DocURL };
}
 
function dashFindProspects(key, candidateId) {
  requireDashAccess_(key);
  return findProspectsForCandidate_(candidateId);
}
 
function dashSetProspectStatus(key, prospectId, status) {
  requireDashAccess_(key);
  var p = findRow_('Prospects', 'ProspectID', prospectId);
  if (!p) throw new Error('Prospect not found');
  updateRow_('Prospects', p._row, { Status: status });
  logActivity_(Session.getActiveUser().getEmail() || 'reviewer', 'prospect_' + status, 'prospect', prospectId, '');
  return true;
}
 
function dashSetCandidateActive(key, candidateId, active) {
  requireDashAccess_(key);
  var c = findRow_('Candidates', 'CandidateID', candidateId);
  if (!c) throw new Error('Candidate not found');
  updateRow_('Candidates', c._row, { Active: active ? 'TRUE' : 'FALSE' });
  logActivity_(Session.getActiveUser().getEmail() || 'reviewer', active ? 'candidate_activated' : 'candidate_deactivated', 'candidate', candidateId, '');
  return true;
}
 
function dashSetCandidateTarget(key, candidateId, target) {
  requireDashAccess_(key);
  var c = findRow_('Candidates', 'CandidateID', candidateId);
  if (!c) throw new Error('Candidate not found');
  var n = parseInt(target, 10);
  if (isNaN(n) || n < 0) throw new Error('Target must be a non-negative number');
  updateRow_('Candidates', c._row, { TargetApplications: n });
  logActivity_(Session.getActiveUser().getEmail() || 'reviewer', 'candidate_target_set', 'candidate', candidateId, String(n));
  return true;
}
 
function dashMarkFollowUpDone(key, followUpId) {
  requireDashAccess_(key);
  var f = findRow_('FollowUps', 'FollowUpID', followUpId);
  if (!f) throw new Error('Follow-up not found');
  updateRow_('FollowUps', f._row, { Status: 'Done' });
  logActivity_(Session.getActiveUser().getEmail() || 'reviewer', 'followup_done', 'followup', followUpId, '');
  return true;
}
 
function dashDeleteCandidate(key, candidateId) {
  requireDashAccess_(key);
  var cand = findRow_('Candidates', 'CandidateID', candidateId);
  if (!cand) throw new Error('Candidate not found');
 
  var removed = {};
  ['Applications', 'Jobs', 'CVVersions', 'CoverLetters', 'NHSStatements',
   'ReviewQueue', 'Prospects', 'FollowUps', 'AIOutputs'].forEach(function (tab) {
    removed[tab] = deleteRowsWhere_(tab, 'CandidateID', candidateId);
  });
 
  if (cand.DriveFolderID) {
    try { DriveApp.getFolderById(cand.DriveFolderID).setTrashed(true); } catch (ignored) {}
  }
 
  deleteRowsWhere_('Candidates', 'CandidateID', candidateId);
 
  logActivity_(Session.getActiveUser().getEmail() || 'reviewer', 'candidate_deleted', 'candidate', candidateId,
    cand.FullName + ' | removed: ' + JSON.stringify(removed));
  return { deleted: true, related: removed };
}
 
function dashClearActivityLog(key) {
  requireDashAccess_(key);
  requireDashAccess_(key);
  var sh = sheet_('ActivityLog');
  var last = sh.getLastRow();
  if (last > 1) sh.deleteRows(2, last - 1);
  logActivity_(Session.getActiveUser().getEmail() || 'reviewer', 'activity_log_cleared', 'system', '-', 'Log cleared');
  return true;
}
 
/**
 * Queue a candidate's found prospects in one action: all of them, or only the
 * `limit` most recently found. 'Found - Manual Review' ones count too - the
 * extension's driver finds its own way from any job page to the form, so a
 * link that isn't a known ATS is no reason to leave a job out (the single-row
 * Queue button never did). Returns the queued IDs so the dashboard can update
 * exactly those rows, and how many found ones are left.
 */
function dashQueueAllFound(key, candidateId, limit) {
  requireDashAccess_(key);
  var lock = LockService.getScriptLock(); // a double click must not queue the next batch as well
  lock.waitLock(20000);
  try {
    var found = readRows_('Prospects', ['ProspectID', 'CandidateID', 'Status', 'FoundAt']).filter(function (p) {
      return p.CandidateID === candidateId && (p.Status === 'Found' || p.Status === 'Found - Manual Review');
    });
    found.sort(function (a, b) { return (toEpochMs_(b.FoundAt) - toEpochMs_(a.FoundAt)) || (b._row - a._row); });
    var n = parseInt(limit, 10);
    var pick = n > 0 ? found.slice(0, n) : found;

    setColumnForRows_('Prospects', 'Status', pick.map(function (p) { return p._row; }), 'Queued');
    SpreadsheetApp.flush();
    logActivity_(Session.getActiveUser().getEmail() || 'reviewer', 'prospects_bulk_queued', 'candidate', candidateId,
      pick.length + ' queued' + (n > 0 ? ' (newest ' + n + ')' : '') + ', ' + (found.length - pick.length) + ' still found');
    return {
      queued: pick.length, remaining: found.length - pick.length,
      ids: pick.map(function (p) { return String(p.ProspectID); })
    };
  } finally {
    lock.releaseLock();
  }
}

function dashRetryApplication(key, applicationId) {
  requireDashAccess_(key);
  var app = findRow_('Applications', 'ApplicationID', applicationId);
  if (!app) throw new Error('Application not found');
 
  appendObject_('Prospects', {
    ProspectID: newId_('PROS'), FoundAt: new Date(), CandidateID: app.CandidateID,
    Company: app.Company, JobTitle: app.JobTitle, JobURL: app.JobURL,
    Source: 'Retry', Status: 'Queued', Notes: 'Re-queued from failed application ' + applicationId
  });
  updateRow_('Applications', app._row, { Status: 'Retried' });
  logActivity_(Session.getActiveUser().getEmail() || 'reviewer', 'application_retried', 'application', applicationId, app.Company);
  return { requeued: true };
}
 
/* ------------------------------- helpers -------------------------------- */

/**
 * Whether an Applications row still stands for a real application, for the
 * duplicate check and the target count. Failed ones can be tried again, and
 * Retried ones have been re-queued as a fresh prospect (dashRetryApplication).
 */
function countsAsApplication_(status) {
  return status !== 'Failed' && status !== 'Retried';
}

/**
 * 'Approved - Submitting' is the worker's queue, so only applications the
 * worker filled go there. Extension-filled ones are submitted by the tab
 * that is polling checkApproval ('Approved - Extension'), which would
 * otherwise race the worker into a double submission. Rows from before
 * FilledBy existed are recognised by the worker's snapshot marker.
 */
function submittedByWorker_(app, task) {
  if (app.FilledBy) return app.FilledBy === 'worker';
  return String(task.AIFindings || '').indexOf('unified-form-filler') > -1;
}

/** A sheet date cell as yyyy-MM-dd in the script's time zone, or '' if blank/unreadable. */
function sheetDateIso_(v) {
  var ms = toEpochMs_(v);
  return ms ? Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'yyyy-MM-dd') : '';
}
 
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
  var emails = getConfig_('REPORT_EMAILS');
  if (!emails) return;
  emails.split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (to) {
    try { MailApp.sendEmail(to, '[Jobverse] ' + subject, body); } catch (ignored) {}
  });
}
 
function latestReport_() {
  var rows = readRows_('Reports');
  if (!rows.length) return null;
  var last = rows[rows.length - 1];
  try { return { period: last.Period, metrics: JSON.parse(last.MetricsJSON), summary: last.Summary }; }
  catch (e) { return null; }
}
 



































