/**
 * JOBVERSE MVP - Reports.gs
 * One set of numbers, worked out from the sheet: the Reports page asks for any
 * period (dashReport), and runDailyReport (07:00 trigger) emails yesterday's.
 * Weekly and monthly can be run by hand or given their own triggers.
 *
 * Two questions are kept apart, because mixing them gives nonsense rates:
 *  - activity: what happened in the period, each thing by the date it happened
 *  - sent: of the jobs sent in the period, how far each one has got since
 *    (so the rates can't pass 100%)
 *
 * A job tried more than once counts once: its attempts are grouped.
 */

function runDailyReport() { buildReport_('Daily', 1); }
function runWeeklyReport() { buildReport_('Weekly', 7); }
function runMonthlyReport() { buildReport_('Monthly', 30); }

var REPORT_DAY_MS_ = 24 * 60 * 60 * 1000;

/** Live numbers for the Reports page. from and to are yyyy-MM-dd, both included. */
function dashReport(key, from, to) {
  requireDashAccess_(key);
  var start = reportDay_(from), end = reportDay_(to);
  if (!start || !end || end < start) throw new Error('Pick a start date on or before the end date');
  end.setDate(end.getDate() + 1);
  return reportMetrics_(start.getTime(), end.getTime());
}

/** Midnight of a yyyy-MM-dd day in the script's time zone, or null. */
function reportDay_(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function pct_(part, whole) { return whole ? Math.round(100 * part / whole) : 0; }

function median_(numbers) {
  if (!numbers.length) return 0;
  var s = numbers.slice().sort(function (a, b) { return a - b; }), mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Each job once, however many attempts it took: { candidateId, startedMs, latest, sent }. */
function reportJobs_(apps) {
  var jobs = {};
  apps.slice().sort(function (a, b) { return toEpochMs_(a.CreatedAt) - toEpochMs_(b.CreatedAt); }).forEach(function (a) {
    var key = a.CandidateID + '|' + (prospectJobKey_(a.Company, a.JobTitle) || normaliseJobKey_(a.JobURL, a.Company, a.JobTitle));
    var job = jobs[key] || (jobs[key] = { candidateId: a.CandidateID, startedMs: toEpochMs_(a.CreatedAt), latest: a, sent: null });
    if (a.Status !== 'Retried') job.latest = a;
    if (a.Status === 'Submitted') job.sent = a;
  });
  return Object.keys(jobs).map(function (k) { return jobs[k]; });
}

function reportMetrics_(fromMs, toMs) {
  var now = Date.now();
  var inPeriod = function (ms) { return ms >= fromMs && ms < toMs; };
  var tz = Session.getScriptTimeZone();
  var day = function (ms) { return Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd'); };

  var apps = readRows_('Applications', ['ApplicationID', 'CandidateID', 'Company', 'JobTitle', 'JobURL', 'Status',
    'CreatedAt', 'SubmittedAt', 'Outcome', 'InterviewDate', 'OfferDate', 'RejectedDate']);
  // Results recorded before OfferDate and RejectedDate existed are dated by the follow-up that closed
  var closedAt = {};
  readRows_('FollowUps', ['ApplicationID', 'Outcome', 'ClosedAt']).forEach(function (f) {
    if (f.ApplicationID && f.ClosedAt) closedAt[f.ApplicationID + '|' + f.Outcome] = toEpochMs_(f.ClosedAt);
  });
  var stages = function (a) {
    var o = String(a.Outcome || ''), id = a.ApplicationID;
    var dated = {
      interview: toEpochMs_(a.InterviewDate) || closedAt[id + '|Interview'] || 0,
      offer: toEpochMs_(a.OfferDate) || closedAt[id + '|Offer'] || 0,
      rejected: toEpochMs_(a.RejectedDate) || closedAt[id + '|Rejected'] || 0
    };
    return {
      dated: dated,
      interview: !!dated.interview || /interview/i.test(o),
      offer: !!dated.offer || /offer/i.test(o),
      rejected: !!dated.rejected || /reject/i.test(o)
    };
  };

  var names = {};
  readRows_('Candidates', ['CandidateID', 'FullName']).forEach(function (c) { names[c.CandidateID] = c.FullName || c.CandidateID; });
  var people = {};
  var person = function (id) {
    return people[id] || (people[id] = { id: id, name: names[id] || id, submitted: 0, interviews: 0, offers: 0 });
  };

  var jobs = reportJobs_(apps);

  // Activity: each thing on the day it happened
  var activity = { submitted: 0, interviews: 0, offers: 0, rejections: 0, undated_results: 0 };
  var sentJobs = [];
  jobs.forEach(function (j) {
    if (!j.sent) return;
    var sentMs = toEpochMs_(j.sent.SubmittedAt) || toEpochMs_(j.sent.CreatedAt);
    var s = stages(j.sent);
    if (inPeriod(sentMs)) {
      activity.submitted++;
      person(j.candidateId).submitted++;
      sentJobs.push({ sentMs: sentMs, stages: s });
    }
    if (inPeriod(s.dated.interview)) { activity.interviews++; person(j.candidateId).interviews++; }
    if (inPeriod(s.dated.offer)) { activity.offers++; person(j.candidateId).offers++; }
    if (inPeriod(s.dated.rejected)) activity.rejections++;
    if ((s.interview && !s.dated.interview) || (s.offer && !s.dated.offer) || (s.rejected && !s.dated.rejected)) activity.undated_results++;
  });

  // Sent: how far those jobs have got since
  var followUpDays = parseInt(getConfig_('FOLLOWUP_DAYS_AFTER_SUBMIT') || '7', 10);
  var count = function (test) { return sentJobs.filter(test).length; };
  var sent = {
    jobs: sentJobs.length,
    interviews: count(function (j) { return j.stages.interview; }),
    offers: count(function (j) { return j.stages.offer; }),
    rejected: count(function (j) { return j.stages.rejected; }),
    no_result_yet: count(function (j) { return !j.stages.interview && !j.stages.offer && !j.stages.rejected; }),
    // Sent too recently for silence to mean anything
    too_early: count(function (j) {
      return !j.stages.interview && !j.stages.offer && !j.stages.rejected && now - j.sentMs < followUpDays * REPORT_DAY_MS_;
    }),
    too_early_days: followUpDays
  };
  sent.interview_rate_pct = pct_(sent.interviews, sent.jobs);
  sent.offer_rate_pct = pct_(sent.offers, sent.jobs);

  // Started: where the jobs first tried in the period stand now
  var started = { jobs: 0, sent: 0, in_progress: 0, not_sent: 0 };
  jobs.forEach(function (j) {
    if (!inPeriod(j.startedMs)) return;
    started.jobs++;
    if (j.sent) started.sent++;
    else if (/^(Failed|Error|Rejected|Dropped)$/.test(String(j.latest.Status))) started.not_sent++;
    else started.in_progress++;
  });
  started.sent_pct = pct_(started.sent, started.jobs);

  // Reviews: applications only, by when they were decided. An application with no real wait
  // (the review row was written at the moment of the decision) says nothing about review time.
  var status = {};
  apps.forEach(function (a) { status[a.ApplicationID] = a.Status; });
  var subs = readRows_('ReviewQueue', ['Type', 'Status', 'RefID', 'CreatedAt', 'DecidedAt']).filter(function (t) { return t.Type === 'Submission'; });
  var waits = subs.filter(function (t) { return inPeriod(toEpochMs_(t.DecidedAt)); })
    .map(function (t) { return (toEpochMs_(t.DecidedAt) - toEpochMs_(t.CreatedAt)) / 60000; })
    .filter(function (m) { return m > 0; });
  var waiting = subs.filter(function (t) { return t.Status === 'Awaiting Human' && status[t.RefID] === 'Awaiting Review'; });
  var oldest = waiting.reduce(function (min, t) { return Math.min(min, toEpochMs_(t.CreatedAt) || now); }, now);
  var reviews = {
    decided: waits.length,
    median_minutes: Math.round(median_(waits)),
    waiting_now: waiting.length,
    oldest_waiting_minutes: waiting.length ? Math.round((now - oldest) / 60000) : 0
  };

  var jobsFound = readRows_('Prospects', ['FoundAt', 'Source']).filter(function (p) {
    return inPeriod(toEpochMs_(p.FoundAt)) && p.Source !== 'Retry';
  }).length;

  return {
    from: day(fromMs), to: day(toMs - 1), generated: now,
    activity: activity, sent: sent, started: started, reviews: reviews, jobs_found: jobsFound,
    candidates: Object.keys(people).map(function (k) { return people[k]; })
      .sort(function (a, b) { return b.submitted - a.submitted || String(a.name).localeCompare(String(b.name)); })
  };
}

/** Whole days up to last midnight, so reports never overlap or miss anything whenever the trigger fires. */
function buildReport_(period, days) {
  var end = new Date(); end.setHours(0, 0, 0, 0);
  var start = new Date(end.getTime()); start.setDate(start.getDate() - days);
  var m = reportMetrics_(start.getTime(), end.getTime());

  var a = m.activity, s = m.sent, t = m.started, r = m.reviews;
  var summary = period + ' ' + m.from + (m.from === m.to ? '' : ' to ' + m.to) + ': ' + a.submitted + ' submitted, ' +
    a.interviews + ' interviews, ' + a.offers + ' offers, ' + a.rejections + ' rejections.';

  appendObject_('Reports', { GeneratedAt: new Date(), Period: period, MetricsJSON: JSON.stringify(m), Summary: summary });

  var emails = getConfig_('REPORT_EMAILS');
  if (emails) {
    var body = [summary, '',
      'Jobs started: ' + t.jobs + ' (' + t.sent + ' sent so far, ' + t.in_progress + ' still in progress, ' + t.not_sent + ' not sent)',
      'Jobs found: ' + m.jobs_found,
      'Applications reviewed: ' + r.decided + ', typical wait ' + r.median_minutes + ' min',
      'Waiting for review now: ' + r.waiting_now + (r.waiting_now ? ' (oldest ' + r.oldest_waiting_minutes + ' min)' : ''),
      '',
      'Of the ' + s.jobs + ' sent in this period: ' + s.interviews + ' interview (' + s.interview_rate_pct + '%), ' +
        s.offers + ' offer (' + s.offer_rate_pct + '%), ' + s.rejected + ' rejected, ' + s.no_result_yet + ' no result yet' +
        (s.too_early ? ' (' + s.too_early + ' sent under ' + s.too_early_days + ' days ago)' : ''),
      '', 'By candidate:'].concat(m.candidates.map(function (c) {
        return '- ' + c.name + ': ' + c.submitted + ' submitted, ' + c.interviews + ' interviews, ' + c.offers + ' offers';
      })).concat(['', 'Any other period: the Reports page in the dashboard.', 'Full data: ' + SpreadsheetApp.getActiveSpreadsheet().getUrl()]).join('\n');
    emails.split(',').forEach(function (to) {
      if (to.trim()) try { MailApp.sendEmail(to.trim(), '[Jobverse] ' + period + ' report', body); } catch (ignored) {}
    });
  }
  logActivity_('system', 'report_generated', 'report', period, summary);
  return m;
}
