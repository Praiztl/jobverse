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

function runResumeAnalyst_(candidateId) {
  var cand = findRow_('Candidates', 'CandidateID', candidateId);
  if (!cand) throw new Error('Candidate not found: ' + candidateId);
  if (!cand.CVFileID) throw new Error('No CV on file for ' + candidateId);

  var cvText = extractFileText_(cand.CVFileID).slice(0, 40000);

  var profile = callClaudeJSON_(
    'You are a CV analyst for a UK recruitment agency. Extract a structured profile. ' +
    'Use only information present in the CV. Never invent employers, dates, or qualifications. ' +
    'If something is absent, use an empty string or empty array.',
    'CV TEXT:\n' + cvText + '\n\nReturn JSON with keys: summary, employment_history ' +
    '(array of {employer, title, start, end, achievements[]}), education (array of ' +
    '{institution, qualification, year}), skills (array), certifications (array), ' +
    'strengths (array), weaknesses (array), timeline_gaps (array of {from, to, note}).',
    4000
  );

  updateRow_('Candidates', cand._row, {
    Status: 'Profiled',
    AIProfileJSON: JSON.stringify(profile).slice(0, 45000),
    Strengths: (profile.strengths || []).join('; '),
    Weaknesses: (profile.weaknesses || []).join('; ')
  });
  saveAIOutput_('ResumeAnalyst', candidateId, '', profile);
  logActivity_('ai', 'profile_built', 'candidate', candidateId, 'Resume Analyst complete');
  return profile;
}

/* ----------------------------- Job Analyst ------------------------------ */

/** jdText can be a pasted JD or text scraped by the extension. */
function runJobAnalyst_(candidateId, jobUrl, jdText, atsName) {
  var analysis = callClaudeJSON_(
    'You are a job description analyst for a UK recruitment agency.',
    'JOB DESCRIPTION:\n' + String(jdText).slice(0, 30000) + '\n\nReturn JSON with keys: ' +
    'company, job_title, location, salary, experience_level, responsibilities (array), ' +
    'required_skills (array), preferred_skills (array), ats_keywords (array of the exact ' +
    'phrases an ATS would scan for), likely_screening_questions (array).',
    3000
  );

  var jobId = newId_('JOB');
  var suitability = '';
  var cand = findRow_('Candidates', 'CandidateID', candidateId);
  if (cand && cand.AIProfileJSON) {
    var score = callClaudeJSON_(
      'Score candidate suitability for a job from 0 to 100 with a one line reason. ' +
      'Base it only on the profile provided.',
      'PROFILE:\n' + cand.AIProfileJSON + '\n\nJOB ANALYSIS:\n' + JSON.stringify(analysis) +
      '\n\nReturn JSON: {"score": number, "reason": string}',
      500
    );
    suitability = score.score + ' (' + score.reason + ')';
  }

  appendObject_('Jobs', {
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
  saveAIOutput_('JobAnalyst', candidateId, jobId, analysis);
  logActivity_('ai', 'job_analysed', 'job', jobId, (analysis.company || '') + ' - ' + (analysis.job_title || ''));
  return jobId;
}

/* ---------------------------- Resume Builder ---------------------------- */

/** `revision` (optional): {notes, findings} from a sent-back review - see Revisions.gs. */
function runResumeBuilder_(candidateId, jobId, toneName, revision) {
  var cand = findRow_('Candidates', 'CandidateID', candidateId);
  var job = findRow_('Jobs', 'JobID', jobId);
  if (!cand || !job) throw new Error('Candidate or job not found.');
  cand = ensureProfile_(cand);

  // The original CV carries what the profile summarises away (languages, CPD, exact
  // dates, course content) - the template has a place for each of them
  var cvText = '';
  try { if (cand.CVFileID) cvText = extractFileText_(cand.CVFileID).slice(0, 20000); }
  catch (e) { logActivity_('system', 'cv_text_unavailable', 'candidate', candidateId, e.message); }

  var tone = getTone_(toneName);
  var cv = callClaudeJSON_(
    'You are an expert UK CV writer. Build a tailored CV strictly from the candidate ' +
    'profile and original CV. Never invent employers, dates, qualifications, languages or ' +
    'achievements. Weave in the ATS keywords only where the candidate genuinely supports them. Style: ' + tone,
    'CANDIDATE PROFILE:\n' + cand.AIProfileJSON +
    (cvText ? '\n\nCANDIDATE\'S ORIGINAL CV (source of facts only - not a style guide):\n' + cvText : '') +
    '\n\nCONTACT: ' + [cvText_(cand.FullName)].concat(cvContact_(cand).map(function (c) { return c.text; })).join(', ') +
    '\n\nTARGET JOB ANALYSIS:\n' + job.AnalysisJSON +
    '\n\nWriting rules (the agency\'s CV format):\n' +
    '- headline: the target role title only, e.g. "Physiotherapist" - no specialism, under 6 words.\n' +
    '- profile_summary: one paragraph of 5-7 sentences: registration/qualification and core experience ' +
    'first, then the hands-on skills, then how they work with patients/clients and colleagues, ending on ' +
    'professional standards and development. Mostly without pronouns; "I" is allowed once or twice.\n' +
    '- skills: 12-16 skill phrases (2-6 words each, e.g. "Manual Therapy Techniques"), Title Case, most ' +
    'relevant to the job first.\n' +
    '- experience: reverse chronological. Each role has 4-8 bullets (the most recent and relevant roles ' +
    'the most), each one full sentence of 1-2 lines written in the first person: "I" plus a past-tense ' +
    'verb (present tense for a current role), saying what was done, with whom and to what end. Keep any ' +
    'numbers. location is "City, Country" or "Country" when known.\n' +
    '- dates everywhere: "MM/YYYY - MM/YYYY" or "MM/YYYY - Present"; copy them as given if the month is unknown.\n' +
    '- education: institution, the full qualification name (e.g. "Master of Science (MSc) Sports Medicine"), ' +
    'dates, location, and relevant_study: a comma-separated list of the most job-relevant modules or topics ' +
    '(empty if unknown).\n' +
    '- cpd: continuing professional development - courses, shadowing, training, conferences - as first-person ' +
    'sentences ("I learned...", "I observed..."); empty if there is none.\n' +
    '- certifications: registrations, licences and certificates with the date awarded (DD/MM/YYYY or MM/YYYY), ' +
    'e.g. {"name": "HCPC: Registered Physiotherapist", "date": "01/05/2026"}.\n' +
    '- languages: every language the candidate states, with level as given (Native, Fluent, C1, B2...).\n' +
    'Any field you have no real value for must be an empty string (or empty array) - never write ' +
    'null, N/A, Any, Unknown, Not specified or similar placeholders.' +
    revisionBrief_(revision) +
    '\n\nReturn JSON: {"headline": string, "profile_summary": string, ' +
    '"skills": [string], "experience": [{"employer": string, "title": string, ' +
    '"location": string, "dates": string, "bullets": [string]}], ' +
    '"education": [{"institution": string, "qualification": string, "dates": string, ' +
    '"location": string, "relevant_study": string}], "cpd": [string], ' +
    '"certifications": [{"name": string, "date": string}], ' +
    '"languages": [{"language": string, "level": string}]}',
    5000
  );
  cv = cvCleanResult_(cv);

  var versionId = newId_('CV');
  var doc = renderCVDoc_(cand, job, cv, versionId);

  appendObject_('CVVersions', {
    VersionID: versionId,
    CreatedAt: new Date(),
    CandidateID: candidateId,
    JobID: jobId,
    DocURL: doc.getUrl(),
    DocID: doc.getId(),
    ReviewStatus: 'Pending',
    ToneProfile: toneName || getConfig_('DEFAULT_TONE')
  });
  saveAIOutput_('ResumeBuilder', candidateId, jobId, cv);
  runReviewerAgent_('CV', versionId, candidateId, jobId, JSON.stringify(cv));
  logActivity_('ai', 'cv_generated', 'cv', versionId, job.Company + ' - ' + job.JobTitle);
  return versionId;
}

/**
 * Renders a tailored CV into a new Google Doc using the template named in
 * Config CV_TEMPLATE:
 *   'Classic' (default, also used for any other value) - the agency's CV
 *     format: black serif type on A4, centred name / role / contact header,
 *     ruled uppercase section headings, skills joined by "||", employer and
 *     dates on one line, dash bullets, then education, CPD, certifications,
 *     languages and references. Borderless tables right-align the dates;
 *     they export to PDF/DOCX as plain left-to-right text, which mainstream
 *     ATS parsers read correctly.
 *   'ATS Simple' - pure single-column paragraphs with no tables, for portals
 *     known to choke on anything but flat text. Uses CV_FONT and CV_ACCENT_COLOR.
 */
function renderCVDoc_(cand, job, cv, versionId) {
  var doc = DocumentApp.create(cand.FullName + ' CV - ' + job.Company + ' - ' + versionId);
  var body = doc.getBody();
  var t = cvTheme_();

  if (t.template === 'ats simple') cvRenderSimple_(body, cand, cv, t);
  else cvRenderClassic_(body, cand, cv, cvClassicTheme_());
  cvTidy_(body);

  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(
    DriveApp.getFolderById(getConfig_('ROOT_FOLDER_ID')).getFoldersByName('Generated CVs').next()
  );
  return doc;
}

/* --------------------------- Classic template --------------------------- */

/** The agency format is black serif on white, whatever CV_FONT / CV_ACCENT_COLOR say (those style ATS Simple). */
function cvClassicTheme_() {
  return { font: 'Source Serif Pro', accent: '#000000', ink: '#000000', body: '#000000', muted: '#000000' };
}

function cvRenderClassic_(body, cand, cv, t) {
  var H = DocumentApp.ParagraphHeading;
  var CENTER = DocumentApp.HorizontalAlignment.CENTER;
  body.setPageWidth(595.28).setPageHeight(841.89); // A4
  body.setMarginTop(46).setMarginBottom(46).setMarginLeft(51).setMarginRight(51);
  var W = 595.28 - 102;

  // Header: name, the role title in italics, then contact details on one centred line
  cvLine_(body, t, [{ text: cvText_(cand.FullName) }], { heading: H.TITLE, size: 21.5, bold: true, align: CENTER, line: 1 });
  if (cv.headline) cvLine_(body, t, [{ text: cv.headline }], { size: 15.5, italic: true, align: CENTER, before: 2, line: 1 });
  var contact = cvContact_(cand, t.ink);
  if (contact.length) cvLine_(body, t, cvJoin_(contact, t.ink, '      '), { size: 10.5, align: CENTER, before: 8, line: 1 });

  if (cv.profile_summary) {
    cvSectionClassic_(body, t, 'Professional Summary');
    cvLine_(body, t, [{ text: cv.profile_summary }], { line: 1.15 });
  }

  if ((cv.skills || []).length) {
    cvSectionClassic_(body, t, 'Skills');
    cvLine_(body, t, [{ text: cv.skills.join(' || ') }], { line: 1.6 });
  }

  var roles = cv.experience || [];
  if (roles.length) {
    cvSectionClassic_(body, t, 'Professional Experience');
    roles.forEach(function (e, i) {
      var when = cvDateRange_(e.dates);
      var right = [when, e.location].filter(Boolean).join('  |  ');
      if (e.location) {
        // Employer and "dates | location" on one line, the job title under it
        cvRowClassic_(body, t, W, [{ text: e.employer || e.title, bold: true }], right, i ? 10 : 0);
        if (e.employer && e.title) cvLine_(body, t, [{ text: e.title, italic: true }], { line: 1.1 });
      } else {
        cvRowClassic_(body, t, W, e.employer && e.title
          ? [{ text: e.employer + ', ', bold: true }, { text: e.title, italic: true }]
          : [{ text: e.employer || e.title, bold: true }], right, i ? 10 : 0);
      }
      (e.bullets || []).forEach(function (b) { cvDash_(body, t, b); });
    });
  }

  var edu = cv.education || [];
  if (edu.length) {
    cvSectionClassic_(body, t, 'Education');
    edu.forEach(function (e, i) {
      var left = e.institution && e.qualification
        ? [{ text: e.institution + ', ', bold: true }, { text: e.qualification, italic: true }]
        : [{ text: e.institution || e.qualification || e.line, bold: !!(e.institution || e.qualification) }];
      var right = [cvDateRange_(e.dates), e.location].filter(Boolean).join('  |  ');
      cvRowClassic_(body, t, W, left, right, i ? 10 : 0);
      if (e.relevant_study) cvLine_(body, t, [{ text: 'Relevant study: ' + e.relevant_study.replace(/\.?$/, '.') }], { line: 1.1 });
    });
  }

  if ((cv.cpd || []).length) {
    cvSectionClassic_(body, t, 'Continuing Professional Development');
    cvLine_(body, t, [{ text: cv.cpd.join('  •  ') }], { line: 1.6 });
  }

  if ((cv.certifications || []).length) {
    cvSectionClassic_(body, t, 'Certifications');
    cv.certifications.forEach(function (c, i) {
      cvRowClassic_(body, t, W, [{ text: c.name, bold: true }], c.date, i ? 4 : 0);
    });
  }

  if ((cv.languages || []).length) {
    cvSectionClassic_(body, t, 'Languages');
    cv.languages.forEach(function (l) {
      cvLine_(body, t, [{ text: l.language + (l.level ? ': ' + l.level : '') }], { line: 1.1 });
    });
  }

  cvSectionClassic_(body, t, 'References');
  cvLine_(body, t, [{ text: 'Available upon request', bold: true }], {});
}

/** Bold uppercase heading with a thin full-width rule under it. */
function cvSectionClassic_(body, t, title) {
  cvLine_(body, t, [{ text: title.toUpperCase() }],
    { heading: DocumentApp.ParagraphHeading.HEADING2, size: 11.5, bold: true, before: 16, line: 1 });
  cvRule_(body, 6);
}

/** One line with `leftRuns` on the left and `rightText` flush right (a borderless two-column table). */
function cvRowClassic_(body, t, W, leftRuns, rightText, before) {
  if (!rightText) return cvLine_(body, t, leftRuns, { before: before, line: 1.1 });
  // Wide enough for the dates/location to stay on one line (~5.3pt per character at 10.5pt)
  var rightW = Math.min(W * 0.6, Math.max(W * 0.25, rightText.length * 5.3 + 12));
  var row = cvTable_(body, 1, [W - rightW, rightW]);
  var left = row.getCell(0, 0), right = row.getCell(0, 1);
  left.setPaddingTop(before || 0);
  right.setPaddingTop(before || 0);
  cvLine_(left, t, leftRuns, { line: 1.1 });
  cvLine_(right, t, [{ text: rightText }], { align: DocumentApp.HorizontalAlignment.RIGHT, line: 1.1 });
}

/** "- " bullet with the wrapped lines hanging under the text, as in the template. */
function cvDash_(body, t, text) {
  var p = cvLine_(body, t, [{ text: '-  ' + text }], { line: 1.1, after: 1 });
  p.setIndentFirstLine(6).setIndentStart(15);
  return p;
}

/** "09/2025 - 04/2026" -> "09/2025 – 04/2026": the template's en dash between dates. */
function cvDateRange_(dates) {
  return String(dates || '').replace(/\s+(-|–|—|to)\s+/i, ' – ');
}

/* ------------------------- ATS Simple template -------------------------- */

function cvRenderSimple_(body, cand, cv, t) {
  var H = DocumentApp.ParagraphHeading;
  body.setPageWidth(595.28).setPageHeight(841.89);
  body.setMarginTop(40).setMarginBottom(40).setMarginLeft(54).setMarginRight(54);

  cvLine_(body, t, [{ text: cvText_(cand.FullName) }], { heading: H.TITLE, size: 26, bold: true, color: t.accent, line: 1 });
  if (cv.headline) cvLine_(body, t, [{ text: cv.headline }], { size: 12.5, color: t.ink, after: 4, line: 1.1 });
  var contact = cvContact_(cand, t.muted);
  if (contact.length) cvLine_(body, t, cvJoin_(contact, t.accent), { size: 9.5, color: t.muted, after: 2 });
  cvRule_(body, 4);

  if (cv.profile_summary) {
    cvSectionSimple_(body, t, 'Profile');
    cvLine_(body, t, [{ text: cv.profile_summary }], { line: 1.2, after: 2 });
  }
  if ((cv.skills || []).length) {
    cvSectionSimple_(body, t, 'Key Skills');
    cvLine_(body, t, cvJoin_(cv.skills.map(function (s) { return { text: s, color: t.ink }; }), t.accent), { line: 1.4, after: 2 });
  }
  if ((cv.experience || []).length) {
    cvSectionSimple_(body, t, 'Experience');
    cv.experience.forEach(function (e, i) {
      cvLine_(body, t, [{ text: e.title || '' }], { heading: H.HEADING3, size: 11.5, bold: true, color: t.ink, before: i ? 10 : 2 });
      var meta = [];
      if (e.employer) meta.push({ text: e.employer, color: t.accent, bold: true });
      if (e.location) meta.push({ text: e.location });
      if (e.dates) meta.push({ text: e.dates, italic: true });
      if (meta.length) cvLine_(body, t, cvJoin_(meta, t.accent, '  |  '), { size: 10, color: t.muted, after: 3 });
      (e.bullets || []).forEach(function (b) { cvBullet_(body, t, b, 0); });
    });
  }
  if ((cv.education || []).length) {
    cvSectionSimple_(body, t, 'Education');
    cv.education.forEach(function (e, i) {
      if (e.qualification || e.institution) {
        cvLine_(body, t, [{ text: e.qualification || e.institution }], { size: 11, bold: true, color: t.ink, before: i ? 6 : 2 });
        var meta = [];
        if (e.qualification && e.institution) meta.push({ text: e.institution, color: t.accent, bold: true });
        if (e.dates) meta.push({ text: cvDateRange_(e.dates), italic: true });
        if (meta.length) cvLine_(body, t, cvJoin_(meta, t.accent, '  |  '), { size: 10, color: t.muted });
        if (e.relevant_study) cvLine_(body, t, [{ text: 'Relevant study: ' + e.relevant_study }], { size: 10 });
      } else if (e.line) {
        cvLine_(body, t, [{ text: e.line }], { before: i ? 4 : 2 });
      }
    });
  }
  if ((cv.cpd || []).length) {
    cvSectionSimple_(body, t, 'Continuing Professional Development');
    cv.cpd.forEach(function (c) { cvBullet_(body, t, c, 0); });
  }
  if ((cv.certifications || []).length) {
    cvSectionSimple_(body, t, 'Certifications');
    cv.certifications.forEach(function (c) { cvBullet_(body, t, c.name + (c.date ? ' (' + c.date + ')' : ''), 0); });
  }
  if ((cv.languages || []).length) {
    cvSectionSimple_(body, t, 'Languages');
    cvLine_(body, t, [{ text: cv.languages.map(function (l) { return l.language + (l.level ? ': ' + l.level : ''); }).join(', ') }], {});
  }
}

function cvSectionSimple_(body, t, title) {
  cvLine_(body, t, [{ text: title.toUpperCase() }],
    { heading: DocumentApp.ParagraphHeading.HEADING2, size: 11, bold: true, color: t.accent, before: 14, line: 1 });
  cvRule_(body, 4);
}

function cvRule_(body, after) {
  var p = body.appendHorizontalRule().getParent().asParagraph();
  var a = {};
  a[DocumentApp.Attribute.FONT_SIZE] = 2;
  p.setAttributes(a);
  p.setSpacingBefore(0).setSpacingAfter(after || 0).setLineSpacing(1);
}

/* --------------------------- shared helpers ----------------------------- */

/** Whole-field values that mean "nothing here" - from the AI, or intake answers like "Any". */
var CV_PLACEHOLDER_ = /^(null|undefined|none|nil|n\/?a|not applicable|not specified|not provided|unknown|any|anywhere|any location|tbc|tbd|-+|\[\]|\{\})$/i;

/**
 * A field as clean display text: '' for blanks and placeholders, with stray
 * "null"/"undefined" fragments removed ("Jan 2020 - null" -> "Jan 2020",
 * "London, null" -> "London"). Pass prose=true for sentences and list items,
 * where only a whole-field placeholder is dropped (a bullet may genuinely say
 * "null pointer").
 */
function cvText_(v, prose) {
  if (v === null || v === undefined) return '';
  var s = String(v).trim();
  if (CV_PLACEHOLDER_.test(s)) return '';
  if (prose) return s;
  s = s.replace(/\b(null|undefined)\b/gi, '')
    .replace(/([,;|•])\s*(?=[,;|•])/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;|\-–•]+|[\s,;|\-–•]+$/g, '')
    .trim();
  return CV_PLACEHOLDER_.test(s) ? '' : s;
}

/** The Resume Builder's JSON with placeholders and empty entries stripped, ready to render. */
function cvCleanResult_(cv) {
  cv = cv || {};
  var list = function (a) {
    return (Array.isArray(a) ? a : []).map(function (x) { return cvText_(x, true); }).filter(Boolean);
  };
  return {
    headline: cvText_(cv.headline),
    profile_summary: cvText_(cv.profile_summary, true),
    skills: list(cv.skills),
    experience: (cv.experience || []).map(function (e) {
      return { employer: cvText_(e.employer), title: cvText_(e.title), location: cvText_(e.location),
               dates: cvText_(e.dates), bullets: list(e.bullets) };
    }).filter(function (e) { return e.title || e.employer; }),
    education: (cv.education || []).map(function (e) {
      return { qualification: cvText_(e.qualification), institution: cvText_(e.institution),
               dates: cvText_(e.dates || e.year), location: cvText_(e.location),
               relevant_study: cvText_(e.relevant_study, true), line: cvText_(e.line) };
    }).filter(function (e) { return e.qualification || e.institution || e.line; }),
    cpd: list(cv.cpd),
    // Plain strings (older prompt, revisions) are names without a date
    certifications: (Array.isArray(cv.certifications) ? cv.certifications : []).map(function (c) {
      return c && typeof c === 'object' ? { name: cvText_(c.name, true), date: cvText_(c.date) } : { name: cvText_(c, true), date: '' };
    }).filter(function (c) { return c.name; }),
    languages: (Array.isArray(cv.languages) ? cv.languages : []).map(function (l) {
      return l && typeof l === 'object' ? { language: cvText_(l.language), level: cvText_(l.level) } : { language: cvText_(l), level: '' };
    }).filter(function (l) { return l.language; })
  };
}

function cvTheme_() {
  var accent = getConfig_('CV_ACCENT_COLOR');
  accent = /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#1F4E79';
  var n = parseInt(accent.slice(1), 16);
  var light = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.6;
  return {
    template: (getConfig_('CV_TEMPLATE') || 'Classic').trim().toLowerCase(),
    font: getConfig_('CV_FONT') || 'Lato',
    accent: accent,
    onAccent: light ? '#1A1A1A' : '#FFFFFF',          // text on the header band
    onAccentSoft: light ? '#404040' : cvMix_(accent, 0.72),
    ink: '#1A1A1A',
    body: '#3A3A3A',
    muted: '#6B6B6B'
  };
}

/** Blends a hex colour towards white by fraction f (0-1). */
function cvMix_(hex, f) {
  var n = parseInt(hex.slice(1), 16);
  return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(function (c) {
    return ('0' + Math.round(c + (255 - c) * f).toString(16)).slice(-2);
  }).join('');
}

/** Header contact runs: email, phone, location, LinkedIn. Blanks and placeholders ("null", "Any", "N/A"...) are left out. */
function cvContact_(cand, color) {
  var out = [];
  var email = cvText_(cand.Email);
  if (email.indexOf('@') > 0) out.push({ text: email, link: 'mailto:' + email, color: color });
  // Location comes from the intake's preferred-locations answer, which can be a list like "London; Any"
  var location = cvText_(cand.Location).split(/\s*[;,\/]\s*/).filter(function (x) {
    return x && !CV_PLACEHOLDER_.test(x);
  }).join(', ');
  [cvText_(cand.Phone), location].forEach(function (v) { if (v) out.push({ text: v, color: color }); });
  var li = cvText_(cand.LinkedIn);
  if (li.indexOf('.') > 0) {
    out.push({
      text: li.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''),
      link: /^https?:/i.test(li) ? li : 'https://' + li,
      color: color
    });
  }
  return out;
}

/** Applies heading, font, size, colour, alignment and spacing to a paragraph. */
function cvStyle_(el, t, o) {
  o = o || {};
  if (o.heading) el.setHeading(o.heading);
  var a = {};
  a[DocumentApp.Attribute.FONT_FAMILY] = t.font;
  a[DocumentApp.Attribute.FONT_SIZE] = o.size || 10.5;
  a[DocumentApp.Attribute.FOREGROUND_COLOR] = o.color || t.body;
  a[DocumentApp.Attribute.BOLD] = !!o.bold;
  a[DocumentApp.Attribute.ITALIC] = !!o.italic;
  a[DocumentApp.Attribute.UNDERLINE] = false;
  el.setAttributes(a);
  if (o.align) el.setAlignment(o.align);
  el.setLineSpacing(o.line || 1.15);
  el.setSpacingBefore(o.before || 0);
  el.setSpacingAfter(o.after || 0);
  return el;
}

/**
 * Appends a paragraph to a body or table cell, built from styled runs
 * ({text, color, bold, italic, size, link}) over base paragraph style.
 */
function cvLine_(container, t, runs, base) {
  var p = container.appendParagraph(runs.map(function (r) { return r.text; }).join(''));
  cvStyle_(p, t, base);
  var text = p.editAsText();
  var pos = 0;
  runs.forEach(function (r) {
    if (!r.text) return;
    var end = pos + r.text.length - 1;
    if (r.link) text.setLinkUrl(pos, end, r.link).setUnderline(pos, end, false);
    if (r.color) text.setForegroundColor(pos, end, r.color);
    if (r.size) text.setFontSize(pos, end, r.size);
    if (r.bold) text.setBold(pos, end, true);
    if (r.italic) text.setItalic(pos, end, true);
    pos = end + 1;
  });
  return p;
}

/** Interleaves runs with a separator in the given colour (default: a bullet). */
function cvJoin_(runs, color, sep) {
  var out = [];
  runs.forEach(function (r, i) {
    if (i) out.push({ text: sep || '   •   ', color: color });
    out.push(r);
  });
  return out;
}

/** Borderless, zero-padding table with fixed column widths in points. */
function cvTable_(body, rows, widths) {
  var cells = [];
  for (var r = 0; r < rows; r++) cells.push(widths.map(function () { return ''; }));
  var tbl = body.appendTable(cells);
  tbl.setBorderWidth(0).setBorderColor('#FFFFFF');
  widths.forEach(function (w, i) { tbl.setColumnWidth(i, w); });
  for (r = 0; r < rows; r++) {
    for (var c = 0; c < widths.length; c++) {
      tbl.getCell(r, c).setPaddingTop(0).setPaddingBottom(0).setPaddingLeft(0).setPaddingRight(0)
        .setVerticalAlignment(DocumentApp.VerticalAlignment.TOP);
    }
  }
  return tbl;
}

function cvBullet_(body, t, text, before) {
  var li = body.appendListItem(text || '');
  li.setGlyphType(DocumentApp.GlyphType.BULLET);
  cvStyle_(li, t, { line: 1.2, before: before || 0, after: 2.5 });
  li.setIndentFirstLine(6).setIndentStart(20);
  return li;
}

/**
 * Removes the placeholder paragraph Docs puts in every new table cell (and
 * the doc's own leading blank line), and shrinks any blank spacer paragraphs
 * Docs inserts between adjacent tables so they don't open visible gaps.
 */
function cvTidy_(body) {
  body.getTables().forEach(function (tbl) {
    for (var r = 0; r < tbl.getNumRows(); r++) {
      for (var c = 0; c < tbl.getRow(r).getNumCells(); c++) {
        var cell = tbl.getCell(r, c);
        if (cell.getNumChildren() > 1 && cvIsBlank_(cell.getChild(0))) cell.getChild(0).removeFromParent();
      }
    }
  });
  if (body.getNumChildren() > 1 && cvIsBlank_(body.getChild(0))) {
    try { body.getChild(0).removeFromParent(); } catch (e) { /* Docs may insist on a leading paragraph */ }
  }
  var a = {};
  a[DocumentApp.Attribute.FONT_SIZE] = 2;
  for (var i = 0; i < body.getNumChildren(); i++) {
    var el = body.getChild(i);
    if (cvIsBlank_(el)) el.asParagraph().setAttributes(a).setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);
  }
}

/** True for a paragraph with no text and no inline content (e.g. not a rule). */
function cvIsBlank_(el) {
  if (el.getType() !== DocumentApp.ElementType.PARAGRAPH) return false;
  var p = el.asParagraph();
  if (p.getText() !== '') return false;
  for (var i = 0; i < p.getNumChildren(); i++) {
    if (p.getChild(i).getType() !== DocumentApp.ElementType.TEXT) return false;
  }
  return true;
}
/**
 * Manual check for the CV template: run from the Apps Script editor to render
 * a sample CV (no AI call) into Generated CVs, then open the logged URL.
 */
function previewCVTemplate() {
  var cand = {
    FullName: 'Amara Okafor', Email: 'amara.okafor@example.com', Phone: '07700 900123',
    Location: 'Manchester, UK', LinkedIn: 'linkedin.com/in/amara-okafor'
  };
  var cv = cvCleanResult_({
    headline: 'Staff Nurse',
    profile_summary: 'NMC registered Band 6 staff nurse with eight years of acute medical experience across busy NHS wards. ' +
      'Experienced in shift leadership, sepsis management, IV therapy and discharge planning. ' +
      'Coordinates care with doctors, therapists and families to keep patients safe and well informed. ' +
      'I keep accurate records, follow infection prevention procedures and mentor student nurses.',
    skills: ['Acute Patient Care', 'Shift Leadership', 'Clinical Audit', 'IV Therapy', 'Mentoring Student Nurses',
      'Discharge Planning', 'Sepsis Management', 'EPR Systems', 'Safeguarding Adults'],
    experience: [
      { title: 'Senior Staff Nurse (Band 6)', employer: 'Manchester University NHS Foundation Trust',
        location: 'Manchester, United Kingdom', dates: '03/2021 - Present', bullets: [
          'I lead the nursing shift on a 28-bed acute medical unit, coordinating 10-12 staff to keep care safe and on time.',
          'I introduced a falls-risk huddle that cut inpatient falls by 22% over 12 months.',
          'I mentor more than 15 student nurses a year, all of whom have passed their placements.'] },
      { title: 'Staff Nurse (Band 5)', employer: 'Salford Royal Hospital', location: '',
        dates: '09/2017 - 02/2021', bullets: [
          'I delivered holistic care to up to 8 patients per shift on a respiratory ward.',
          'I completed IV and venepuncture competencies within my first six months.'] }
    ],
    education: [
      { institution: 'University of Manchester', qualification: 'Bachelor of Science (BSc) Adult Nursing', dates: '09/2014 - 07/2017',
        location: 'United Kingdom', relevant_study: 'Acute care, pharmacology, patient assessment and evidence-based practice' }
    ],
    cpd: ['I completed Immediate Life Support training and now act as a resuscitation link nurse.',
      'I attended a regional sepsis study day on early recognition and escalation.'],
    certifications: [{ name: 'NMC: Registered Nurse', date: '09/2017' }, { name: 'Immediate Life Support (ILS)', date: '03/2025' }],
    languages: [{ language: 'English', level: 'Native' }, { language: 'Yoruba', level: 'Fluent' }]
  });
  var doc = renderCVDoc_(cand, { Company: 'Template Preview' }, cv, 'PREVIEW');
  Logger.log(doc.getUrl());
  return doc.getUrl();
}

/* -------------------------- Cover Letter Builder ------------------------- */

function runCoverLetterBuilder_(candidateId, jobId, toneName, revision) {
  var cand = findRow_('Candidates', 'CandidateID', candidateId);
  var job = findRow_('Jobs', 'JobID', jobId);
  if (!cand || !job) throw new Error('Candidate or job not found.');
  cand = ensureProfile_(cand);

  var tone = getTone_(toneName);
  var letter = callClaude_(
    'You write one page UK cover letters. Evidence based: every claim must trace to the ' +
    'candidate profile. Company specific and role specific. Human sounding, no template ' +
    'phrases, no "I am writing to apply". Maximum 320 words. Style: ' + tone,
    'CANDIDATE PROFILE:\n' + cand.AIProfileJSON +
    '\n\nCANDIDATE NAME: ' + cand.FullName +
    '\n\nJOB ANALYSIS:\n' + job.AnalysisJSON +
    '\n\nWrite the letter body only, starting "Dear Hiring Manager," (or the named ' +
    'manager if present in the analysis) and ending "Yours sincerely,\n' + cand.FullName + '".' +
    revisionBrief_(revision),
    1500
  );

  var letterId = newId_('CL');
  var doc = DocumentApp.create(cand.FullName + ' Cover Letter - ' + job.Company + ' - ' + letterId);
  var body = doc.getBody();
  body.setAttributes(styleAttrs_(11));
  letter.split('\n').forEach(function (line) { addPara_(body, line); });
  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(
    DriveApp.getFolderById(getConfig_('ROOT_FOLDER_ID')).getFoldersByName('Cover Letters').next()
  );

  appendObject_('CoverLetters', {
    LetterID: letterId,
    CreatedAt: new Date(),
    CandidateID: candidateId,
    JobID: jobId,
    DocURL: doc.getUrl(),
    DocID: doc.getId(),
    ReviewStatus: 'Pending',
    ToneProfile: toneName || getConfig_('DEFAULT_TONE')
  });
  saveAIOutput_('CoverLetterBuilder', candidateId, jobId, { letter: letter });
  runReviewerAgent_('CoverLetter', letterId, candidateId, jobId, letter);
  logActivity_('ai', 'letter_generated', 'letter', letterId, job.Company);
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
function runNHSSupportingStatement_(candidateId, jobId, toneName, revision) {
  var cand = findRow_('Candidates', 'CandidateID', candidateId);
  var job = findRow_('Jobs', 'JobID', jobId);
  if (!cand || !job) throw new Error('Candidate or job not found.');
  cand = ensureProfile_(cand);

  var tone = getTone_(toneName || 'NHS');
  var statement = callClaude_(
    'You write NHS job application supporting statements. Structure the response to address ' +
    'each point in the job\'s person specification / required and preferred skills directly, ' +
    'using specific evidence from the candidate profile only - never invent employers, dates, ' +
    'or achievements. Reference NHS values (care, compassion, respect, dignity, teamwork) only ' +
    'where genuinely evidenced by the candidate\'s actual experience. Style: ' + tone,
    'CANDIDATE PROFILE:\n' + cand.AIProfileJSON +
    '\n\nJOB ANALYSIS (person specification / requirements):\n' + job.AnalysisJSON +
    '\n\nWrite the supporting statement body only, no salutation or sign-off, 500-1200 words, ' +
    'organised under clear subheadings matching the person specification categories.' +
    revisionBrief_(revision),
    3000
  );

  var statementId = newId_('NHS');
  var doc = DocumentApp.create(cand.FullName + ' NHS Supporting Statement - ' + job.Company + ' - ' + statementId);
  var body = doc.getBody();
  body.setAttributes(styleAttrs_(11));
  statement.split('\n').forEach(function (line) { addPara_(body, line); });
  doc.saveAndClose();
  var folder = DriveApp.getFolderById(getConfig_('ROOT_FOLDER_ID'));
  var target = folderOrCreate_(folder, 'NHS Supporting Statements');
  DriveApp.getFileById(doc.getId()).moveTo(target);

  appendObject_('NHSStatements', {
    StatementID: statementId, CreatedAt: new Date(), CandidateID: candidateId, JobID: jobId,
    DocURL: doc.getUrl(), DocID: doc.getId(), ReviewStatus: 'Pending', ToneProfile: toneName || 'NHS'
  });
  saveAIOutput_('NHSSupportingStatement', candidateId, jobId, { statement: statement });
  runReviewerAgent_('NHSStatement', statementId, candidateId, jobId, statement);
  logActivity_('ai', 'nhs_statement_generated', 'nhsstatement', statementId, job.Company);
  return { statementId: statementId, docUrl: doc.getUrl(), text: statement };
}

/**
 * The candidate row with an AI profile, building it first if it's missing.
 * Returns a fresh row - the one passed in still has the empty profile, and a
 * document written from it would have nothing true to say about the candidate.
 */
function ensureProfile_(cand) {
  if (cand.AIProfileJSON) return cand;
  runResumeAnalyst_(cand.CandidateID);
  cand = findRow_('Candidates', 'CandidateID', cand.CandidateID);
  if (!cand || !cand.AIProfileJSON) throw new Error('Could not build a profile for this candidate - check their CV upload.');
  return cand;
}

function folderOrCreate_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/* ---------------------------- Reviewer Agent ----------------------------- */

function runReviewerAgent_(type, refId, candidateId, jobId, contentText) {
  var cand = findRow_('Candidates', 'CandidateID', candidateId);
  var job = jobId ? findRow_('Jobs', 'JobID', jobId) : null;

  var review = callClaudeJSON_(
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

  var taskId = newId_('REV');
  appendObject_('ReviewQueue', {
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
    var row = findRow_(target, type === 'CV' ? 'VersionID' : (type === 'CoverLetter' ? 'LetterID' : 'StatementID'), refId);
    if (row) updateRow_(target, row._row, { ReviewScore: review.ats_score, ReviewerNotes: (review.issues || []).join('; ') });
  }
  saveAIOutput_('ReviewerAgent', candidateId, jobId, review);
  return taskId;
}

/* ------------------------ ATS Question Answering ------------------------- */

/** Called by the Chrome extension for screening questions it cannot map. */
function answerScreeningQuestion_(candidateId, jobId, questionText) {
  var cand = findRow_('Candidates', 'CandidateID', candidateId);
  var job = jobId ? findRow_('Jobs', 'JobID', jobId) : null;
  var answer = callClaude_(
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
  saveAIOutput_('QuestionAnswerer', candidateId, jobId, { q: questionText, a: answer });
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
