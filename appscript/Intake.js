/**
 * JOBVERSE MVP - Intake.gs
 * Google Form submission -> Candidate record -> files filed in Drive -> AI profile.
 *
 * Field matching is done by fuzzy title matching so the client can rename or
 * reorder questions without breaking intake. Add aliases in FIELD_ALIASES if
 * the form uses unusual wording.
 */

var FIELD_ALIASES = {
  FullName: ['full name'],
  Phone: ['mobile number', 'phone', 'contact number'],
  ApplicationEmail: ['application email'],
  EmailAndPassword: ['email address and password'],
  Address: ['full address'],
  MaritalStatus: ['marital status'],
  Nationality: ['nationality'],
  Gender: ['gender'],
  DateOfBirth: ['date of birth'],
  NoticePeriod: ['notice period'],
  MinSalary: ['salary expectation', 'minimum acceptable salary', 'minimum salary'],
  PreferredRoles: ['preferred job title', 'preferred roles', 'target roles'],
  PreferredLocations: ['preferred work location'],
  WorkModel: ['preferred work model', 'work model'],
  VisaStatus: ['visa type', 'visa'],
  NINumber: ['national insurance number'],
  DrivingLicence: ["driver's licence", 'driving licence', 'driving license'],
  RightToWork: ['visa sponsorship', 'right to work'],
  References: ['reference details'],
  PreferredIndustries: ['preferred industries', 'industries'],
  Registrations: ['professional registration', 'hcpc', 'nmc', 'gmc'],
  EmploymentType: ['preferred employment type', 'employment type'],
  LinkedIn: ['linkedin'],
  GitHub: ['github'],
  Portfolio: ['portfolio', 'website'],
  CV: ['upload your cv', 'cv', 'resume'],
  Certificates: ['certificate']
};

function onFormSubmit(e) {
  try {
    var answers = {};
    var uploads = { CV: [], Certificates: [] };

    e.response.getItemResponses().forEach(function (ir) {
      var title = ir.getItem().getTitle().toLowerCase();
      var value = ir.getResponse();
      var key = matchField_(title);
      if (!key) return;
      if (key === 'CV' || key === 'Certificates') {
        var ids = Array.isArray(value) ? value : [value];
        uploads[key] = uploads[key].concat(ids);
      } else {
        answers[key] = Array.isArray(value) ? value.join(', ') : value;
      }
    });
    var loginEmail = e.response.getRespondentEmail() || '';
    var parsedCreds = parseEmailAndPassword_(answers.EmailAndPassword || '');
    var candidateId = newId('CAND');

    // File the uploads into /Jobverse Platform/Candidates/<Name CAND-id>/
    var root = DriveApp.getFolderById(getConfig('ROOT_FOLDER_ID'));
    var candidatesFolder = root.getFoldersByName('Candidates').next();
    var folder = candidatesFolder.createFolder(((answers.FullName || 'Unnamed') + ' ' + candidateId).trim());

    var cvId = '';
    uploads.CV.forEach(function (fid) {
      var f = DriveApp.getFileById(fid);
      f.moveTo(folder);
      cvId = cvId || fid;
    });
    var certIds = uploads.Certificates.map(function (fid) {
      DriveApp.getFileById(fid).moveTo(folder);
      return fid;
    });

    appendObject('Candidates', {
      CandidateID: candidateId,
      CreatedAt: new Date(),
      Status: 'New',
      Active: 'TRUE',
      TargetApplications: getConfig('DEFAULT_TARGET_APPLICATIONS') || '50',
      FullName: answers.FullName || '',
      Email: loginEmail,
      ApplicationEmail: answers.ApplicationEmail || parsedCreds.email || '',
      ApplicationPassword: parsedCreds.password || '',
      Phone: answers.Phone || '',
      Address: answers.Address || '',
      MaritalStatus: answers.MaritalStatus || '',
      Nationality: answers.Nationality || '',
      Gender: answers.Gender || '',
      DateOfBirth: answers.DateOfBirth || '',
      Location: answers.PreferredLocations || '',
      RightToWork: answers.RightToWork || '',
      VisaStatus: answers.VisaStatus || '',
      NINumber: answers.NINumber || '',
      DrivingLicence: answers.DrivingLicence || '',
      MinSalary: answers.MinSalary || '',
      PreferredRoles: answers.PreferredRoles || '',
      PreferredIndustries: answers.PreferredIndustries || '',
      PreferredLocations: answers.PreferredLocations || '',
      WorkModel: answers.WorkModel || '',
      EmploymentType: answers.EmploymentType || '',
      NoticePeriod: answers.NoticePeriod || '',
      Registrations: answers.Registrations || '',
      References: answers.References || '',
      LinkedIn: answers.LinkedIn || '',
      GitHub: answers.GitHub || '',
      Portfolio: answers.Portfolio || '',
      CVFileID: cvId,
      CertificateFileIDs: certIds.join(','),
      DriveFolderID: folder.getId()
    });

    logActivity('form', 'candidate_created', 'candidate', candidateId, answers.FullName || candidateId);

    // Kick off the Resume Analyst immediately if a CV was uploaded.
    if (cvId) runResumeAnalyst(candidateId);
  } catch (err) {
    logActivity('form', 'intake_error', 'form', '-', String(err && err.stack || err));
  }
}

function matchField_(title) {
  var keys = Object.keys(FIELD_ALIASES);
  for (var i = 0; i < keys.length; i++) {
    var aliases = FIELD_ALIASES[keys[i]];
    for (var j = 0; j < aliases.length; j++) {
      if (title.indexOf(aliases[j]) > -1) return keys[i];
    }
  }
  return null;
}

/**
 * The client's form asks for email and password in one free-text field, so
 * candidates answer in all sorts of formats ("a@b.com / mypassword",
 * "a@b.com, pw: mypassword", two lines, etc). Pull out the email with a
 * regex and treat the remaining text as the password. Falls back to putting
 * the whole raw string in `password` if no email-shaped substring is found,
 * so nothing is silently dropped and a human can fix it in the Candidates row.
 */
function parseEmailAndPassword_(raw) {
  var text = String(raw || '').trim();
  if (!text) return { email: '', password: '' };

  var emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (!emailMatch) return { email: '', password: text };

  var email = emailMatch[0];
  var rest = (text.slice(0, emailMatch.index) + ' ' + text.slice(emailMatch.index + email.length)).trim();
  // Strip common separators/labels left over around the password.
  rest = rest.replace(/^[\s,;|/\-–:]+|[\s,;|/\-–:]+$/g, '')
             .replace(/^(password|pw|pass)\s*[:\-]\s*/i, '')
             .trim();
  return { email: email, password: rest };
}

/**
 * Extract plain text from an uploaded CV (pdf, docx, doc, txt).
 * Converts via Drive to a temporary Google Doc, reads the body, deletes the temp.
 * PDF conversion uses Drive OCR so scanned CVs also work.
 */
function extractFileText(fileId) {
  var file = DriveApp.getFileById(fileId);
  var mime = file.getMimeType();
  if (mime === MimeType.PLAIN_TEXT) return file.getBlob().getDataAsString();
  if (mime === MimeType.GOOGLE_DOCS) return DocumentApp.openById(fileId).getBody().getText();

  var copy = Drive.Files.copy(
    { name: 'tmp-extract-' + fileId, mimeType: 'application/vnd.google-apps.document' },
    fileId,
    { ocrLanguage: 'en' }
  );
  try {
    return DocumentApp.openById(copy.id).getBody().getText();
  } finally {
    Drive.Files.remove(copy.id);
  }
}

/** Manual re-run helper: select a CandidateID and rebuild their AI profile. */
function rebuildProfileForCandidate(candidateId) {
  runResumeAnalyst(candidateId);
}