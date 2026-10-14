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
 * Renders a tailored CV into a new Google Doc using the template named in
 * Config CV_TEMPLATE:
 *   'Modern' (default) - A4, accent header band, right-aligned dates, skills
 *     grid and accent section rules. Uses borderless tables for alignment;
 *     these export to PDF/DOCX as plain left-to-right text, which mainstream
 *     ATS parsers read correctly.
 *   'ATS Simple' - pure single-column paragraphs with no tables, for portals
 *     known to choke on anything but flat text.
 * Font and accent colour come from CV_FONT and CV_ACCENT_COLOR.
 */
function renderCVDoc_(cand, job, cv, versionId) {
  var doc = DocumentApp.create(cand.FullName + ' CV - ' + job.Company + ' - ' + versionId);
  var body = doc.getBody();
  var t = cvTheme_();

  if (t.template === 'ats simple') cvRenderSimple_(body, cand, cv, t);
  else cvRenderModern_(body, cand, cv, t);
  cvTidy_(body);

  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(
    DriveApp.getFolderById(getConfig('ROOT_FOLDER_ID')).getFoldersByName('Generated CVs').next()
  );
  return doc;
}

/* --------------------------- Modern template ---------------------------- */

function cvRenderModern_(body, cand, cv, t) {
  var H = DocumentApp.ParagraphHeading;
  var RIGHT = DocumentApp.HorizontalAlignment.RIGHT;
  body.setPageWidth(595.28).setPageHeight(841.89); // A4
  body.setMarginTop(34).setMarginBottom(34).setMarginLeft(40).setMarginRight(40);
  var W = 595.28 - 80;

  // Header band: name, headline and contact details on the accent colour
  var head = cvTable_(body, 1, [W]).getCell(0, 0);
  head.setBackgroundColor(t.accent).setPaddingTop(20).setPaddingBottom(18).setPaddingLeft(22).setPaddingRight(22);
  cvLine_(head, t, [{ text: cand.FullName || '' }], { heading: H.TITLE, size: 25, bold: true, color: t.onAccent, line: 1 });
  if (cv.headline) cvLine_(head, t, [{ text: cv.headline }], { size: 12, color: t.onAccentSoft, before: 3, line: 1.1 });
  var contact = cvContact_(cand, t.onAccent);
  if (contact.length) {
    cvLine_(head, t, cvJoin_(contact, t.onAccentSoft), { size: 9.5, color: t.onAccent, before: 10, line: 1.2 });
  }

  if (cv.profile_summary) {
    cvSectionModern_(body, t, 'Profile', W);
    cvLine_(body, t, [{ text: cv.profile_summary }], { line: 1.3, before: 6 });
  }

  // Skills as a three-column grid with accent markers
  var skills = (cv.skills || []).filter(Boolean);
  if (skills.length) {
    cvSectionModern_(body, t, 'Key Skills', W);
    var cols = 3, grid = cvTable_(body, Math.ceil(skills.length / cols), [W / cols, W / cols, W / cols]);
    skills.forEach(function (s, i) {
      var c = grid.getCell(Math.floor(i / cols), i % cols);
      c.setPaddingTop(i < cols ? 6 : 1).setPaddingBottom(1).setPaddingRight(6);
      cvLine_(c, t, [{ text: '■  ', color: t.accent, size: 7 }, { text: s, color: t.ink }], { size: 10 });
    });
  }

  // Experience: title/employer on the left, dates/location right-aligned
  var roles = cv.experience || [];
  if (roles.length) {
    cvSectionModern_(body, t, 'Experience', W);
    roles.forEach(function (e, i) {
      var row = cvTable_(body, 1, [W * 0.68, W * 0.32]);
      var left = row.getCell(0, 0), right = row.getCell(0, 1);
      left.setPaddingTop(i ? 12 : 7);
      right.setPaddingTop(i ? 12 : 7);
      cvLine_(left, t, [{ text: e.title || '' }], { heading: H.HEADING3, size: 11.5, bold: true, color: t.ink, line: 1.1 });
      if (e.employer) cvLine_(left, t, [{ text: e.employer }], { size: 10.5, bold: true, color: t.accent, before: 1 });
      if (e.dates) cvLine_(right, t, [{ text: e.dates }], { size: 9.5, bold: true, color: t.muted, align: RIGHT, before: 1.5 });
      if (e.location) cvLine_(right, t, [{ text: e.location }], { size: 9.5, italic: true, color: t.muted, align: RIGHT, before: 2 });

      (e.bullets || []).forEach(function (b, j) { cvBullet_(body, t, b, j ? 0 : 4); });
    });
  }

  // Education: one table, qualification + institution left, year right
  var edu = cv.education || [];
  if (edu.length) {
    cvSectionModern_(body, t, 'Education', W);
    var et = cvTable_(body, edu.length, [W * 0.78, W * 0.22]);
    edu.forEach(function (e, i) {
      var left = et.getCell(i, 0), right = et.getCell(i, 1);
      left.setPaddingTop(i ? 8 : 6);
      right.setPaddingTop(i ? 8 : 6);
      if (e.qualification || e.institution) {
        cvLine_(left, t, [{ text: e.qualification || e.institution }], { size: 11, bold: true, color: t.ink });
        if (e.qualification && e.institution) cvLine_(left, t, [{ text: e.institution }], { size: 10, color: t.accent, before: 1 });
      } else {
        cvLine_(left, t, [{ text: e.line || '' }], {});
      }
      if (e.year) cvLine_(right, t, [{ text: String(e.year) }], { size: 9.5, bold: true, color: t.muted, align: RIGHT, before: 1.5 });
    });
  }

  if ((cv.certifications || []).length) {
    cvSectionModern_(body, t, 'Certifications', W);
    cv.certifications.forEach(function (c, j) { cvBullet_(body, t, c, j ? 0 : 6); });
  }
}

/** Uppercase accent heading over a thin full-width accent bar. */
function cvSectionModern_(body, t, title, W) {
  cvLine_(body, t, [{ text: title.toUpperCase() }],
    { heading: DocumentApp.ParagraphHeading.HEADING2, size: 10.5, bold: true, color: t.accent, before: 16, after: 3, line: 1 });
  var bar = cvTable_(body, 1, [W]).getCell(0, 0);
  bar.setBackgroundColor(t.accent);
  var a = {};
  a[DocumentApp.Attribute.FONT_SIZE] = 1;
  bar.getChild(0).asParagraph().setAttributes(a).setLineSpacing(1).setSpacingBefore(0).setSpacingAfter(0);
}

/* ------------------------- ATS Simple template -------------------------- */

function cvRenderSimple_(body, cand, cv, t) {
  var H = DocumentApp.ParagraphHeading;
  body.setPageWidth(595.28).setPageHeight(841.89);
  body.setMarginTop(40).setMarginBottom(40).setMarginLeft(54).setMarginRight(54);

  cvLine_(body, t, [{ text: cand.FullName || '' }], { heading: H.TITLE, size: 26, bold: true, color: t.accent, line: 1 });
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
        if (e.year) meta.push({ text: String(e.year), italic: true });
        if (meta.length) cvLine_(body, t, cvJoin_(meta, t.accent, '  |  '), { size: 10, color: t.muted });
      } else if (e.line) {
        cvLine_(body, t, [{ text: e.line }], { before: i ? 4 : 2 });
      }
    });
  }
  if ((cv.certifications || []).length) {
    cvSectionSimple_(body, t, 'Certifications');
    cv.certifications.forEach(function (c) { cvBullet_(body, t, c, 0); });
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

function cvTheme_() {
  var accent = getConfig('CV_ACCENT_COLOR');
  accent = /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#1F4E79';
  var n = parseInt(accent.slice(1), 16);
  var light = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.6;
  return {
    template: (getConfig('CV_TEMPLATE') || 'Modern').trim().toLowerCase(),
    font: getConfig('CV_FONT') || 'Lato',
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

function cvContact_(cand, color) {
  var out = [];
  [cand.Location, cand.Phone].forEach(function (v) { if (v) out.push({ text: String(v), color: color }); });
  if (cand.Email) out.push({ text: String(cand.Email), link: 'mailto:' + cand.Email, color: color });
  if (cand.LinkedIn) {
    var li = String(cand.LinkedIn).trim();
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
  var cv = {
    headline: 'Senior Staff Nurse - Acute Medicine',
    profile_summary: 'Band 6 staff nurse with eight years of acute medical experience across busy NHS wards. ' +
      'Leads shifts of up to 12 staff, mentors student nurses and drives measurable improvements in patient safety. ' +
      'Calm under pressure, with a strong record of audit-led change and multidisciplinary collaboration.',
    skills: ['Acute patient care', 'Shift leadership', 'Clinical audit', 'IV therapy', 'Mentoring',
      'Discharge planning', 'Sepsis management', 'EPR systems', 'Safeguarding'],
    experience: [
      { title: 'Senior Staff Nurse (Band 6)', employer: 'Manchester University NHS Foundation Trust',
        location: 'Manchester', dates: 'Mar 2021 - Present', bullets: [
          'Lead nurse in charge on a 28-bed acute medical unit, coordinating 10-12 staff per shift.',
          'Introduced a falls-risk huddle that cut inpatient falls by 22% over 12 months.',
          'Mentor 15+ student nurses a year, with a 100% placement pass rate.'] },
      { title: 'Staff Nurse (Band 5)', employer: 'Salford Royal Hospital', location: 'Salford',
        dates: 'Sep 2017 - Feb 2021', bullets: [
          'Delivered holistic care to up to 8 patients per shift on a respiratory ward.',
          'Completed IV and venepuncture competencies within the first six months.'] }
    ],
    education: [
      { qualification: 'BSc (Hons) Adult Nursing, 2:1', institution: 'University of Manchester', year: '2017' }
    ],
    certifications: ['NMC Registered Nurse (PIN on request)', 'Immediate Life Support (ILS), 2025']
  };
  var doc = renderCVDoc_(cand, { Company: 'Template Preview' }, cv, 'PREVIEW');
  Logger.log(doc.getUrl());
  return doc.getUrl();
}
