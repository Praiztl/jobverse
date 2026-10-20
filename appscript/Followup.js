/**
 * JOBVERSE MVP - FollowUps.gs
 * Tracks tasks that are logged automatically but require a human at a later
 * date: chasing the employer on every submitted application, and the NHS
 * Trac claim/verify step, which can only happen after a vacancy closes and
 * needs the candidate's own identity verification (see RISK_MITIGATION.md /
 * README Part 2 for why that step can't be automated).
 */

function createFollowUp_(candidateId, applicationId, type, company, jobTitle, dueDate, notes) {
  var id = newId_('FU');
  appendObject_('FollowUps', {
    FollowUpID: id,
    CreatedAt: new Date(),
    CandidateID: candidateId,
    ApplicationID: applicationId || '',
    Type: type,
    Company: company || '',
    JobTitle: jobTitle || '',
    DueDate: dueDate,
    Status: 'Pending',
    Notes: notes || ''
  });
  logActivity_('system', 'followup_created', 'followup', id, type + ' due ' + Utilities.formatDate(new Date(dueDate), 'GMT', 'yyyy-MM-dd'));
  return id;
}

/** Creates the standard NHS Trac follow-up: closing date + 2 days, or a config-driven default if no closing date was found. */
function createNHSTracFollowUp_(candidateId, applicationId, company, jobTitle, closingDateStr) {
  var due;
  if (closingDateStr) {
    var parsed = new Date(closingDateStr);
    if (!isNaN(parsed.getTime())) due = new Date(parsed.getTime() + 2 * 24 * 60 * 60 * 1000);
  }
  if (!due) {
    var defaultDays = parseInt(getConfig_('NHS_TRAC_FOLLOWUP_DEFAULT_DAYS') || '14', 10);
    due = new Date(Date.now() + defaultDays * 24 * 60 * 60 * 1000);
  }
  return createFollowUp_(candidateId, applicationId, 'NHS Trac Claim/Verify', company, jobTitle, due,
    closingDateStr ? 'Closing date detected: ' + closingDateStr : 'No closing date detected on the posting - used the default window instead.');
}

/**
 * The follow-up every submitted application gets: chase the employer
 * FOLLOWUP_DAYS_AFTER_SUBMIT days after submission. One per application -
 * returns the existing id if it's already been logged.
 */
function createSubmissionFollowUp_(app) {
  var existing = readRows_('FollowUps').filter(function (f) {
    return f.ApplicationID === app.ApplicationID && f.Type === 'Application Follow-up';
  })[0];
  if (existing) return existing.FollowUpID;
  var days = parseInt(getConfig_('FOLLOWUP_DAYS_AFTER_SUBMIT') || '7', 10);
  var submitted = app.SubmittedAt ? new Date(app.SubmittedAt) : new Date();
  if (isNaN(submitted.getTime())) submitted = new Date();
  var due = new Date(submitted.getTime() + days * 24 * 60 * 60 * 1000);
  return createFollowUp_(app.CandidateID, app.ApplicationID, 'Application Follow-up', app.Company, app.JobTitle, due,
    'Submitted ' + Utilities.formatDate(submitted, 'GMT', 'yyyy-MM-dd') + ' - check for a reply and chase the employer if there is none.');
}

/**
 * Logs the follow-up for any Submitted application that doesn't have one yet
 * (applications submitted before follow-ups were automatic, or marked
 * Submitted by hand in the sheet). Run once from the editor to backfill; the
 * daily reminder trigger also runs it as a safety net.
 */
function backfillSubmissionFollowUps() {
  var have = {};
  readRows_('FollowUps').forEach(function (f) {
    if (f.Type === 'Application Follow-up') have[f.ApplicationID] = true;
  });
  var added = 0;
  readRows_('Applications').forEach(function (a) {
    if (a.Status === 'Submitted' && a.ApplicationID && !have[a.ApplicationID]) {
      createSubmissionFollowUp_(a);
      added++;
    }
  });
  return added + ' follow-up(s) added.';
}

/** Daily 07:30 trigger. Emails REPORT_EMAILS anything due today or overdue and not yet done. */
function sendDueFollowUpReminders() {
  backfillSubmissionFollowUps();
  var today = new Date(); today.setHours(23, 59, 59, 999);
  var due = readRows_('FollowUps').filter(function (f) {
    return f.Status === 'Pending' && new Date(f.DueDate) <= today;
  });
  if (!due.length) return 'None due.';

  var emails = getConfig_('REPORT_EMAILS');
  if (emails) {
    var body = 'Follow-ups due or overdue:\n\n' + due.map(function (f) {
      return '- ' + f.Type + ': ' + f.Company + ' - ' + f.JobTitle + ' (candidate ' + f.CandidateID +
        ', due ' + Utilities.formatDate(new Date(f.DueDate), 'GMT', 'yyyy-MM-dd') + ')';
    }).join('\n') + '\n\nOpen the dashboard\'s Follow-ups tab to mark these done.';
    emails.split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (to) {
      try { MailApp.sendEmail(to, '[Jobverse] ' + due.length + ' follow-up(s) due', body); } catch (ignored) {}
    });
  }
  logActivity_('system', 'followup_reminders_sent', 'system', '-', due.length + ' due');
  return due.length + ' reminder(s) sent.';
}