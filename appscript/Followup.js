/**
 * JOBVERSE MVP - FollowUps.gs
 * Tracks tasks that are logged automatically but require a human at a later
 * date - currently just the NHS Trac claim/verify step, which can only
 * happen after a vacancy closes and needs the candidate's own identity
 * verification (see RISK_MITIGATION.md / README Part 2 for why that step
 * can't be automated).
 */

function createFollowUp(candidateId, applicationId, type, company, jobTitle, dueDate, notes) {
  var id = newId('FU');
  appendObject('FollowUps', {
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
  logActivity('system', 'followup_created', 'followup', id, type + ' due ' + Utilities.formatDate(new Date(dueDate), 'GMT', 'yyyy-MM-dd'));
  return id;
}

/** Creates the standard NHS Trac follow-up: closing date + 2 days, or a config-driven default if no closing date was found. */
function createNHSTracFollowUp(candidateId, applicationId, company, jobTitle, closingDateStr) {
  var due;
  if (closingDateStr) {
    var parsed = new Date(closingDateStr);
    if (!isNaN(parsed.getTime())) due = new Date(parsed.getTime() + 2 * 24 * 60 * 60 * 1000);
  }
  if (!due) {
    var defaultDays = parseInt(getConfig('NHS_TRAC_FOLLOWUP_DEFAULT_DAYS') || '14', 10);
    due = new Date(Date.now() + defaultDays * 24 * 60 * 60 * 1000);
  }
  return createFollowUp(candidateId, applicationId, 'NHS Trac Claim/Verify', company, jobTitle, due,
    closingDateStr ? 'Closing date detected: ' + closingDateStr : 'No closing date detected on the posting - used the default window instead.');
}

/** Daily 07:30 trigger. Emails REPORT_EMAILS anything due today or overdue and not yet done. */
function sendDueFollowUpReminders() {
  var today = new Date(); today.setHours(23, 59, 59, 999);
  var due = readRows('FollowUps').filter(function (f) {
    return f.Status === 'Pending' && new Date(f.DueDate) <= today;
  });
  if (!due.length) return 'None due.';

  var emails = getConfig('REPORT_EMAILS');
  if (emails) {
    var body = 'Follow-ups due or overdue:\n\n' + due.map(function (f) {
      return '- ' + f.Type + ': ' + f.Company + ' - ' + f.JobTitle + ' (candidate ' + f.CandidateID +
        ', due ' + Utilities.formatDate(new Date(f.DueDate), 'GMT', 'yyyy-MM-dd') + ')';
    }).join('\n') + '\n\nOpen the dashboard\'s Follow-ups tab to mark these done.';
    emails.split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (to) {
      try { MailApp.sendEmail(to, '[Jobverse] ' + due.length + ' follow-up(s) due', body); } catch (ignored) {}
    });
  }
  logActivity('system', 'followup_reminders_sent', 'system', '-', due.length + ' due');
  return due.length + ' reminder(s) sent.';
}