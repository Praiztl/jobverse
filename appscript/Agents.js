/**
 * JOBVERSE MVP - Agents.gs
 * Resume Analyst, Job Analyst, Resume Builder, Cover Letter Builder,
 * Reviewer Agent, and ATS Question Answerer.
 *
 * Grounding rule used everywhere: agents may only use facts present in the
 * candidate profile or CV text. This is the primary hallucination control,
 * enforced again by the Reviewer Agent.
 */

/* ---------------------------- Resume Analyst ---------------------------- */

function runResumeAnalyst(candidateId) {
  var cand = findRow('Candidates', 'CandidateID', candidateId);
  if (!cand) throw new Error('Candidate not found: ' + candidateId);
  if (!cand.CVFileID) throw new Error('No CV on file for ' + candidateId);

  var cvText = extractFileText(cand.CVFileID).slice(0, 40000);

  var profile = callClaudeJSON(
    'You are a CV analyst for a UK recruitment agency. Extract a structured profile. ' +
    'Use only information present in the CV. Never invent employers, dates, or qualifications. ' +
    'If something is absent, use an empty string or empty array.',
    'CV TEXT:\n' + cvText + '\n\nReturn JSON with keys: summary, employment_history ' +
    '(array of {employer, title, start, end, achievements[]}), education (array of ' +
    '{institution, qualification, year}), skills (array), certifications (array), ' +
    'strengths (array), weaknesses (array), timeline_gaps (array of {from, to, note}).',
    4000
  );

  updateRow('Candidates', cand._row, {
    Status: 'Profiled',
    AIProfileJSON: JSON.stringify(profile).slice(0, 45000),
    Strengths: (profile.strengths || []).join('; '),
    Weaknesses: (profile.weaknesses || []).join('; ')
  });
  saveAIOutput('ResumeAnalyst', candidateId, '', profile);
  logActivity('ai', 'profile_built', 'candidate', candidateId, 'Resume Analyst complete');
  return profile;
}

/* ----------------------------- Job Analyst ------------------------------ */

/** jdText can be a pasted JD or text scraped by the extension. */
function runJobAnalyst(candidateId, jobUrl, jdText, atsName) {
  var analysis = callClaudeJSON(
    'You are a job description analyst for a UK recruitment agency.',
    'JOB DESCRIPTION:\n' + String(jdText).slice(0, 30000) + '\n\nReturn JSON with keys: ' +
    'company, job_title, location, salary, experience_level, responsibilities (array), ' +
    'required_skills (array), preferred_skills (array), ats_keywords (array of the exact ' +
    'phrases an ATS would scan for), likely_screening_questions (array).',
    3000
  );

  var jobId = newId('JOB');
  var suitability = '';
  var cand = findRow('Candidates', 'CandidateID', candidateId);
  if (cand && cand.AIProfileJSON) {
    var score = callClaudeJSON(
      'Score candidate suitability for a job from 0 to 100 with a one line reason. ' +
      'Base it only on the profile provided.',
      'PROFILE:\n' + cand.AIProfileJSON + '\n\nJOB ANALYSIS:\n' + JSON.stringify(analysis) +
      '\n\nReturn JSON: {"score": number, "reason": string}',
      500
    );
    suitability = score.score + ' (' + score.reason + ')';
  }

  appendObject('Jobs', {
    JobID: jobId,
    CreatedAt: new Date(),
    CandidateID: candidateId,
    Company: analysis.company || '',
    JobTitle: analysis.job_title || '',
    JobURL: jobUrl || '',
    ATS: atsName || '',
    Location: analysis.location || '',
    Salary: analysis.salary || '',
    ExperienceLevel: analysis.experience_level || '',
    RequiredSkills: (analysis.required_skills || []).join(', '),
    PreferredSkills: (analysis.preferred_skills || []).join(', '),
    ATSKeywords: (analysis.ats_keywords || []).join(', '),
    Responsibilities: (analysis.responsibilities || []).join(' | ').slice(0, 5000),
    LikelyQuestions: (analysis.likely_screening_questions || []).join(' | ').slice(0, 5000),
    SuitabilityScore: suitability,
    AnalysisJSON: JSON.stringify(analysis).slice(0, 45000),
    Status: 'Analysed'
  });
  saveAIOutput('JobAnalyst', candidateId, jobId, analysis);
  logActivity('ai', 'job_analysed', 'job', jobId, (analysis.company || '') + ' - ' + (analysis.job_title || ''));
  return jobId;
}

/* ---------------------------- Resume Builder ---------------------------- */

function runResumeBuilder(candidateId, jobId, toneName) {
  var cand = findRow('Candidates', 'CandidateID', candidateId);
  var job = findRow('Jobs', 'JobID', jobId);
  if (!cand || !job) throw new Error('Candidate or job not found.');
  if (!cand.AIProfileJSON) runResumeAnalyst(candidateId);

  var tone = getTone_(toneName);
  var cv = callClaudeJSON(
    'You are an expert UK CV writer. Build a tailored CV strictly from the candidate ' +
    'profile. Never invent employers, dates, qualifications, or achievements. Weave in ' +
    'the ATS keywords only where the profile genuinely supports them. Style: ' + tone,
    'CANDIDATE PROFILE:\n' + cand.AIProfileJSON +
    '\n\nCONTACT: ' + cand.FullName + ', ' + cand.Email + ', ' + cand.Phone + ', ' + cand.Location +
    (cand.LinkedIn ? ', ' + cand.LinkedIn : '') +
    '\n\nTARGET JOB ANALYSIS:\n' + job.AnalysisJSON +
    '\n\nReturn JSON: {"headline": string, "profile_summary": string, ' +
    '"skills": [string], "experience": [{"employer": string, "title": string, ' +
    '"dates": string, "bullets": [string]}], "education": [{"line": string}], ' +
    '"certifications": [string]}',
    4000
  );

  var versionId = newId('CV');
  var doc = renderCVDoc_(cand, job, cv, versionId);

  appendObject('CVVersions', {
    VersionID: versionId,
    CreatedAt: new Date(),
    CandidateID: candidateId,
    JobID: jobId,
    DocURL: doc.getUrl(),
    DocID: doc.getId(),
    ReviewStatus: 'Pending',
    ToneProfile: toneName || getConfig('DEFAULT_TONE')
  });
  saveAIOutput('ResumeBuilder', candidateId, jobId, cv);
  runReviewerAgent('CV', versionId, candidateId, jobId, JSON.stringify(cv));
  logActivity('ai', 'cv_generated', 'cv', versionId, job.Company + ' - ' + job.JobTitle);
  return versionId;
}

function renderCVDoc_(cand, job, cv, versionId) {
  var doc = DocumentApp.create(cand.FullName + ' CV - ' + job.Company + ' - ' + versionId);
  var body = doc.getBody();
  body.setAttributes(styleAttrs_(11));

  addPara_(body, cand.FullName, DocumentApp.ParagraphHeading.TITLE);
  addPara_(body, [cand.Location, cand.Phone, cand.Email, cand.LinkedIn].filter(Boolean).join(' | '));
  addPara_(body, cv.headline || '', DocumentApp.ParagraphHeading.SUBTITLE);

  addPara_(body, 'Profile', DocumentApp.ParagraphHeading.HEADING1);
  addPara_(body, cv.profile_summary || '');

  addPara_(body, 'Key Skills', DocumentApp.ParagraphHeading.HEADING1);
  addPara_(body, (cv.skills || []).join('  |  '));

  addPara_(body, 'Experience', DocumentApp.ParagraphHeading.HEADING1);
  (cv.experience || []).forEach(function (e) {
    addPara_(body, e.title + ', ' + e.employer + '  (' + e.dates + ')', DocumentApp.ParagraphHeading.HEADING2);
    (e.bullets || []).forEach(function (b) { body.appendListItem(b).setGlyphType(DocumentApp.GlyphType.BULLET); });
  });

  addPara_(body, 'Education', DocumentApp.ParagraphHeading.HEADING1);
  (cv.education || []).forEach(function (e) { addPara_(body, e.line); });

  if ((cv.certifications || []).length) {
    addPara_(body, 'Certifications', DocumentApp.ParagraphHeading.HEADING1);
    cv.certifications.forEach(function (c) { addPara_(body, c); });
  }

  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(
    DriveApp.getFolderById(getConfig('ROOT_FOLDER_ID')).getFoldersByName('Generated CVs').next()
  );
  return doc;
}

/* -------------------------- Cover Letter Builder ------------------------- */

function runCoverLetterBuilder(candidateId, jobId, toneName) {
  var cand = findRow('Candidates', 'CandidateID', candidateId);
  var job = findRow('Jobs', 'JobID', jobId);
  if (!cand || !job) throw new Error('Candidate or job not found.');

  var tone = getTone_(toneName);
  var letter = callClaude(
    'You write one page UK cover letters. Evidence based: every claim must trace to the ' +
    'candidate profile. Company specific and role specific. Human sounding, no template ' +
    'phrases, no "I am writing to apply". Maximum 320 words. Style: ' + tone,
    'CANDIDATE PROFILE:\n' + cand.AIProfileJSON +
    '\n\nCANDIDATE NAME: ' + cand.FullName +
    '\n\nJOB ANALYSIS:\n' + job.AnalysisJSON +
    '\n\nWrite the letter body only, starting "Dear Hiring Manager," (or the named ' +
    'manager if present in the analysis) and ending "Yours sincerely,\n' + cand.FullName + '".',
    1500
  );

  var letterId = newId('CL');
  var doc = DocumentApp.create(cand.FullName + ' Cover Letter - ' + job.Company + ' - ' + letterId);
  var body = doc.getBody();
  body.setAttributes(styleAttrs_(11));
  letter.split('\n').forEach(function (line) { addPara_(body, line); });
  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(
    DriveApp.getFolderById(getConfig('ROOT_FOLDER_ID')).getFoldersByName('Cover Letters').next()
  );

  appendObject('CoverLetters', {
    LetterID: letterId,
    CreatedAt: new Date(),
    CandidateID: candidateId,
    JobID: jobId,
    DocURL: doc.getUrl(),
    DocID: doc.getId(),
    ReviewStatus: 'Pending',
    ToneProfile: toneName || getConfig('DEFAULT_TONE')
  });
  saveAIOutput('CoverLetterBuilder', candidateId, jobId, { letter: letter });
  runReviewerAgent('CoverLetter', letterId, candidateId, jobId, letter);
  logActivity('ai', 'letter_generated', 'letter', letterId, job.Company);
  return letterId;
}

/* -------------------------- NHS Supporting Statement --------------------- */

/**
 * Generates the long-form supporting statement NHS applications require,
 * addressing the person specification point by point. Grounded strictly in
 * the candidate's profile - same hallucination controls as the CV/cover
 * letter agents. Stored as a reviewable Doc, and the plain text is returned
 * directly so the extension can paste it into the NHS Jobs form field.
 *
 * NOTE: this covers only the "further information" section. It does NOT
 * touch the legal/protected-characteristic declaration sections (unspent
 * convictions, fitness to practice, GIS, equality/diversity, socio-economic
 * background) - those are filled elsewhere directly from the candidate's own
 * stored answers (NHSUnspentConvictions etc. on the Candidates row), never
 * generated or guessed by AI. See README Part 2 for why.
 */
function runNHSSupportingStatement(candidateId, jobId, toneName) {
  var cand = findRow('Candidates', 'CandidateID', candidateId);
  var job = findRow('Jobs', 'JobID', jobId);
  if (!cand || !job) throw new Error('Candidate or job not found.');
  if (!cand.AIProfileJSON) runResumeAnalyst(candidateId);

  var tone = getTone_(toneName || 'NHS');
  var statement = callClaude(
    'You write NHS job application supporting statements. Structure the response to address ' +
    'each point in the job\'s person specification / required and preferred skills directly, ' +
    'using specific evidence from the candidate profile only - never invent employers, dates, ' +
    'or achievements. Reference NHS values (care, compassion, respect, dignity, teamwork) only ' +
    'where genuinely evidenced by the candidate\'s actual experience. Style: ' + tone,
    'CANDIDATE PROFILE:\n' + cand.AIProfileJSON +
    '\n\nJOB ANALYSIS (person specification / requirements):\n' + job.AnalysisJSON +
    '\n\nWrite the supporting statement body only, no salutation or sign-off, 500-1200 words, ' +
    'organised under clear subheadings matching the person specification categories.',
    3000
  );

  var statementId = newId('NHS');
  var doc = DocumentApp.create(cand.FullName + ' NHS Supporting Statement - ' + job.Company + ' - ' + statementId);
  var body = doc.getBody();
  body.setAttributes(styleAttrs_(11));
  statement.split('\n').forEach(function (line) { addPara_(body, line); });
  doc.saveAndClose();
  var folder = DriveApp.getFolderById(getConfig('ROOT_FOLDER_ID'));
  var target = folderOrCreate_(folder, 'NHS Supporting Statements');
  DriveApp.getFileById(doc.getId()).moveTo(target);

  appendObject('NHSStatements', {
    StatementID: statementId, CreatedAt: new Date(), CandidateID: candidateId, JobID: jobId,
    DocURL: doc.getUrl(), DocID: doc.getId(), ReviewStatus: 'Pending', ToneProfile: toneName || 'NHS'
  });
  saveAIOutput('NHSSupportingStatement', candidateId, jobId, { statement: statement });
  runReviewerAgent('NHSStatement', statementId, candidateId, jobId, statement);
  logActivity('ai', 'nhs_statement_generated', 'nhsstatement', statementId, job.Company);
  return { statementId: statementId, docUrl: doc.getUrl(), text: statement };
}

function folderOrCreate_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/* ---------------------------- Reviewer Agent ----------------------------- */

function runReviewerAgent(type, refId, candidateId, jobId, contentText) {
  var cand = findRow('Candidates', 'CandidateID', candidateId);
  var job = jobId ? findRow('Jobs', 'JobID', jobId) : null;

  var review = callClaudeJSON(
    'You are a strict quality reviewer for AI generated application documents. Check: ' +
    '1) generic wording, 2) claims not supported by the candidate profile (list each one), ' +
    '3) missing ATS keywords from the job analysis, 4) grammar, 5) chronology consistency. ' +
    'Give an ATS score 0-100 and a confidence 0-100.',
    'DOCUMENT (' + type + '):\n' + String(contentText).slice(0, 20000) +
    '\n\nCANDIDATE PROFILE:\n' + (cand ? cand.AIProfileJSON : '{}') +
    '\n\nJOB ANALYSIS:\n' + (job ? job.AnalysisJSON : '{}') +
    '\n\nReturn JSON: {"ats_score": number, "confidence": number, ' +
    '"unsupported_claims": [string], "missing_keywords": [string], ' +
    '"issues": [string], "verdict": "approve" | "revise"}',
    2000
  );

  var taskId = newId('REV');
  appendObject('ReviewQueue', {
    TaskID: taskId,
    CreatedAt: new Date(),
    Type: type,
    CandidateID: candidateId,
    JobID: jobId || '',
    RefID: refId,
    Summary: (job ? job.Company + ' - ' + job.JobTitle : type),
    AIScore: review.ats_score,
    AIFindings: JSON.stringify(review).slice(0, 20000),
    Status: 'Awaiting Human'
  });

  var target = type === 'CV' ? 'CVVersions' : (type === 'CoverLetter' ? 'CoverLetters' : (type === 'NHSStatement' ? 'NHSStatements' : null));
  if (target) {
    var row = findRow(target, type === 'CV' ? 'VersionID' : 'LetterID', refId);
    if (row) updateRow(target, row._row, { ReviewScore: review.ats_score, ReviewerNotes: (review.issues || []).join('; ') });
  }
  saveAIOutput('ReviewerAgent', candidateId, jobId, review);
  return taskId;
}

/* ------------------------ ATS Question Answering ------------------------- */

/** Called by the Chrome extension for screening questions it cannot map. */
function answerScreeningQuestion(candidateId, jobId, questionText) {
  var cand = findRow('Candidates', 'CandidateID', candidateId);
  var job = jobId ? findRow('Jobs', 'JobID', jobId) : null;
  var answer = callClaude(
    'Answer an ATS screening question on behalf of a candidate. Use only facts from ' +
    'their profile and structured fields. If the profile does not contain the answer, ' +
    'reply exactly NEEDS_HUMAN. Be concise and truthful. British English. Style: ' + getTone_(),
    'CANDIDATE STRUCTURED FIELDS:\n' + JSON.stringify({
      name: cand.FullName, email: cand.Email, phone: cand.Phone, location: cand.Location,
      rightToWork: cand.RightToWork, visa: cand.VisaStatus, licence: cand.DrivingLicence,
      salary: cand.MinSalary, notice: cand.NoticePeriod, registrations: cand.Registrations,
      relocate: cand.WillingToRelocate, workModel: cand.WorkModel
    }) +
    '\n\nCANDIDATE PROFILE:\n' + cand.AIProfileJSON +
    (job ? '\n\nJOB CONTEXT:\n' + job.AnalysisJSON : '') +
    '\n\nQUESTION: ' + questionText,
    800
  );
  saveAIOutput('QuestionAnswerer', candidateId, jobId, { q: questionText, a: answer });
  return answer.trim();
}

/* ------------------------------- helpers -------------------------------- */

function styleAttrs_(size) {
  var a = {};
  a[DocumentApp.Attribute.FONT_FAMILY] = 'Times New Roman';
  a[DocumentApp.Attribute.FONT_SIZE] = size;
  a[DocumentApp.Attribute.FOREGROUND_COLOR] = '#000000';
  return a;
}

function addPara_(body, text, heading) {
  var p = body.appendParagraph(text || '');
  if (heading) p.setHeading(heading);
  return p;
}