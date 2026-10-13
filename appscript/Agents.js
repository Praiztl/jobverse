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
    '\n\nWriting rules: headline is the target role title plus one specialism, under 10 words. ' +
    'profile_summary is 3-4 sentences, no first person pronouns. skills is 8-14 short ' +
    'items (1-3 words each), most relevant to the job first. Experience is reverse ' +
    'chronological; each role has 3-6 bullets that start with a strong past-tense verb ' +
    '(present tense for a current role), lead with impact, and keep any numbers from the ' +
    'profile. Format dates as "Mon YYYY - Mon YYYY" or "Mon YYYY - Present" where the ' +
    'profile allows, otherwise copy them as given. Leave location empty if unknown.' +
    '\n\nReturn JSON: {"headline": string, "profile_summary": string, ' +
    '"skills": [string], "experience": [{"employer": string, "title": string, ' +
    '"location": string, "dates": string, "bullets": [string]}], ' +
    '"education": [{"qualification": string, "institution": string, "year": string, ' +
    '"line": string}], "certifications": [string]}',
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

/**
 * Renders the CV as a modern, single-column Google Doc: accent-coloured name,
 * linked contact line, ruled section headings, role title + employer meta
 * lines, and tight bullets. Deliberately avoids tables, columns, text boxes
 * and images so ATS parsers read the exported PDF/DOCX in the right order.
 * Font and accent colour come from Config (CV_FONT, CV_ACCENT_COLOR).
 */
function renderCVDoc_(cand, job, cv, versionId) {
  var doc = DocumentApp.create(cand.FullName + ' CV - ' + job.Company + ' - ' + versionId);
  var body = doc.getBody();
  var t = cvTheme_();
  body.setMarginTop(40).setMarginBottom(40).setMarginLeft(54).setMarginRight(54);

  // Header: name, headline, contact line
  var name = body.getParagraphs()[0];
  name.setText(cand.FullName || '');
  name.setHeading(DocumentApp.ParagraphHeading.TITLE);
  cvStyle_(name, t, { size: 26, bold: true, color: t.accent, after: 0, line: 1 });

  if (cv.headline) {
    cvStyle_(body.appendParagraph(cv.headline), t, { size: 12.5, color: t.ink, after: 4, line: 1.1 });
  }

  var contact = [];
  [cand.Location, cand.Phone].forEach(function (v) { if (v) contact.push({ text: String(v) }); });
  if (cand.Email) contact.push({ text: String(cand.Email), link: 'mailto:' + cand.Email });
  if (cand.LinkedIn) {
    var li = String(cand.LinkedIn).trim();
    contact.push({ text: li.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''), link: /^https?:/i.test(li) ? li : 'https://' + li });
  }
  if (contact.length) {
    cvLine_(body, t, cvJoin_(contact, t), { size: 9.5, color: t.muted, after: 2 });
  }
  cvRule_(body, 4);

  // Profile
  if (cv.profile_summary) {
    cvSection_(body, t, 'Profile');
    cvStyle_(body.appendParagraph(cv.profile_summary), t, { line: 1.2, after: 2 });
  }

  // Skills as a dotted strip
  if ((cv.skills || []).length) {
    cvSection_(body, t, 'Key Skills');
    cvLine_(body, t, cvJoin_(cv.skills.map(function (s) { return { text: s, color: t.ink }; }), t), { line: 1.4, after: 2 });
  }

  // Experience
  if ((cv.experience || []).length) {
    cvSection_(body, t, 'Experience');
    cv.experience.forEach(function (e, i) {
      var title = body.appendParagraph(e.title || '');
      title.setHeading(DocumentApp.ParagraphHeading.HEADING3);
      cvStyle_(title, t, { size: 11.5, bold: true, color: t.ink, before: i ? 10 : 2, after: 0 });

      var meta = [];
      if (e.employer) meta.push({ text: e.employer, color: t.accent, bold: true });
      if (e.location) meta.push({ text: e.location });
      if (e.dates) meta.push({ text: e.dates, italic: true });
      if (meta.length) cvLine_(body, t, cvJoin_(meta, t, '  |  '), { size: 10, color: t.muted, after: 3 });

      (e.bullets || []).forEach(function (b) { cvBullet_(body, t, b); });
    });
  }

  // Education
  if ((cv.education || []).length) {
    cvSection_(body, t, 'Education');
    cv.education.forEach(function (e, i) {
      if (e.qualification || e.institution) {
        var q = body.appendParagraph(e.qualification || e.institution);
        cvStyle_(q, t, { size: 11, bold: true, color: t.ink, before: i ? 6 : 2 });
        var meta = [];
        if (e.qualification && e.institution) meta.push({ text: e.institution, color: t.accent, bold: true });
        if (e.year) meta.push({ text: String(e.year), italic: true });
        if (meta.length) cvLine_(body, t, cvJoin_(meta, t, '  |  '), { size: 10, color: t.muted });
      } else if (e.line) {
        cvStyle_(body.appendParagraph(e.line), t, { before: i ? 4 : 2 });
      }
    });
  }

  // Certifications
  if ((cv.certifications || []).length) {
    cvSection_(body, t, 'Certifications');
    cv.certifications.forEach(function (c) { cvBullet_(body, t, c); });
  }

  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(
    DriveApp.getFolderById(getConfig('ROOT_FOLDER_ID')).getFoldersByName('Generated CVs').next()
  );
  return doc;
}

/* ----------------------------- CV template ------------------------------ */

function cvTheme_() {
  var accent = getConfig('CV_ACCENT_COLOR');
  return {
    font: getConfig('CV_FONT') || 'Lato',
    accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#1F4E79',
    ink: '#1A1A1A',
    body: '#333333',
    muted: '#666666'
  };
}

/** Applies font, size, colour and spacing to a whole paragraph or list item. */
function cvStyle_(el, t, o) {
  o = o || {};
  var a = {};
  a[DocumentApp.Attribute.FONT_FAMILY] = t.font;
  a[DocumentApp.Attribute.FONT_SIZE] = o.size || 10.5;
  a[DocumentApp.Attribute.FOREGROUND_COLOR] = o.color || t.body;
  a[DocumentApp.Attribute.BOLD] = !!o.bold;
  a[DocumentApp.Attribute.ITALIC] = !!o.italic;
  el.setAttributes(a);
  el.setLineSpacing(o.line || 1.15);
  el.setSpacingBefore(o.before || 0);
  el.setSpacingAfter(o.after || 0);
  return el;
}

/** Appends a paragraph built from styled runs ({text, color, bold, italic, link}). */
function cvLine_(body, t, runs, base) {
  var p = body.appendParagraph(runs.map(function (r) { return r.text; }).join(''));
  cvStyle_(p, t, base);
  var text = p.editAsText();
  var pos = 0;
  runs.forEach(function (r) {
    if (!r.text) return;
    var end = pos + r.text.length - 1;
    if (r.color) text.setForegroundColor(pos, end, r.color);
    if (r.bold) text.setBold(pos, end, true);
    if (r.italic) text.setItalic(pos, end, true);
    if (r.link) text.setLinkUrl(pos, end, r.link).setUnderline(pos, end, false);
    pos = end + 1;
  });
  return p;
}

/** Interleaves runs with an accent-coloured separator (default: a bullet). */
function cvJoin_(runs, t, sep) {
  var out = [];
  runs.forEach(function (r, i) {
    if (i) out.push({ text: sep || '  •  ', color: t.accent });
    out.push(r);
  });
  return out;
}

/** Uppercase accent heading with a hairline rule underneath. */
function cvSection_(body, t, title) {
  var h = body.appendParagraph(title.toUpperCase());
  h.setHeading(DocumentApp.ParagraphHeading.HEADING2);
  cvStyle_(h, t, { size: 11, bold: true, color: t.accent, before: 14, after: 0, line: 1 });
  cvRule_(body, 4);
}

function cvRule_(body, after) {
  var p = body.appendHorizontalRule().getParent().asParagraph();
  var a = {};
  a[DocumentApp.Attribute.FONT_SIZE] = 2;
  p.setAttributes(a);
  p.setSpacingBefore(0).setSpacingAfter(after || 0).setLineSpacing(1);
}

function cvBullet_(body, t, text) {
  var li = body.appendListItem(text || '');
  li.setGlyphType(DocumentApp.GlyphType.BULLET);
  cvStyle_(li, t, { line: 1.15, after: 2 });
  li.setIndentFirstLine(10).setIndentStart(24);
  return li;
}