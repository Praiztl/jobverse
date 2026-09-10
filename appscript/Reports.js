/**
 * JOBVERSE MVP - Reports.gs
 * Reporting Agent. runDailyReport is on a 07:00 trigger; weekly and monthly
 * can be run manually or given their own triggers.
 */

function runDailyReport() { buildReport_('Daily', 1); }
function runWeeklyReport() { buildReport_('Weekly', 7); }
function runMonthlyReport() { buildReport_('Monthly', 30); }

function buildReport_(period, days) {
  var since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  var apps = readRows('Applications');
  var inWindow = apps.filter(function (a) { return new Date(a.CreatedAt) >= since; });

  var submitted = inWindow.filter(function (a) { return a.Status === 'Submitted'; });
  var failed = inWindow.filter(function (a) { return a.Status === 'Failed'; });
  var interviews = apps.filter(function (a) {
    return a.Outcome && String(a.Outcome).toLowerCase().indexOf('interview') > -1 &&
      a.InterviewDate && new Date(a.InterviewDate) >= since;
  });
  var offers = apps.filter(function (a) {
    return a.Outcome && String(a.Outcome).toLowerCase().indexOf('offer') > -1;
  });

  var perCandidate = {};
  inWindow.forEach(function (a) { perCandidate[a.CandidateID] = (perCandidate[a.CandidateID] || 0) + 1; });

  var reviews = readRows('ReviewQueue').filter(function (t) {
    return t.DecidedAt && new Date(t.CreatedAt) >= since;
  });
  var avgReviewMins = reviews.length
    ? Math.round(reviews.reduce(function (s, t) {
        return s + (new Date(t.DecidedAt) - new Date(t.CreatedAt)) / 60000;
      }, 0) / reviews.length)
    : 0;

  var prospects = readRows('Prospects').filter(function (p) { return new Date(p.FoundAt) >= since; });
  var prospectsApplied = prospects.filter(function (p) { return p.Status === 'Applied'; });

  var metrics = {
    window_days: days,
    applications_started: inWindow.length,
    applications_submitted: submitted.length,
    applications_failed: failed.length,
    success_rate_pct: inWindow.length ? Math.round(100 * submitted.length / inWindow.length) : 0,
    interviews: interviews.length,
    interview_rate_pct: submitted.length ? Math.round(100 * interviews.length / submitted.length) : 0,
    offers: offers.length,
    offer_rate_pct: submitted.length ? Math.round(100 * offers.length / submitted.length) : 0,
    applications_per_candidate: perCandidate,
    avg_review_minutes: avgReviewMins,
    prospects_found: prospects.length,
    prospects_applied: prospectsApplied.length
  };

  var summary = period + ': ' + submitted.length + ' submitted of ' + inWindow.length +
    ' started, ' + failed.length + ' failed, ' + interviews.length + ' interviews, avg review ' +
    avgReviewMins + ' min.';

  appendObject('Reports', {
    GeneratedAt: new Date(), Period: period,
    MetricsJSON: JSON.stringify(metrics), Summary: summary
  });

  var emails = getConfig('REPORT_EMAILS');
  if (emails) {
    var body = summary + '\n\n' + JSON.stringify(metrics, null, 2) +
      '\n\nFull data: ' + SpreadsheetApp.getActiveSpreadsheet().getUrl();
    emails.split(',').forEach(function (to) {
      if (to.trim()) try { MailApp.sendEmail(to.trim(), '[Jobverse] ' + period + ' report', body); } catch (ignored) {}
    });
  }
  logActivity('system', 'report_generated', 'report', period, summary);
  return metrics;
}