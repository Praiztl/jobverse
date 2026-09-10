/**
 * Jobverse - Analytics.js
 * Measures how often the Reviewer Agent's own verdict matched what a human
 * actually decided, from real ReviewQueue history - by type and by
 * confidence bucket. Read-only, zero side effects. Run manually (Apps
 * Script editor -> select reviewerAccuracyReport -> Run) before ever
 * considering patch 05 (config-gated auto-decide).
 *
 * Submission-type rows will show under "no AI verdict to compare" - that's
 * expected, not a bug: apiRequestReview_ stores a raw form snapshot, not a
 * Reviewer Agent assessment, so there's nothing to compare yet for that type.
 *
 * Output goes to three places: the Apps Script execution log, the
 * ActivityLog sheet tab (via logActivity - easiest place to actually read
 * it), and email if REPORT_EMAILS is set (best-effort, never blocks).
 */
function reviewerAccuracyReport() {
  var rows = readRows('ReviewQueue').filter(function (r) { return r.Status === 'Decided'; });
  var byType = {};

  rows.forEach(function (r) {
    var type = r.Type || 'Unknown';
    if (!byType[type]) byType[type] = { total: 0, noVerdict: 0, agree: 0, disagree: 0, dangerousDisagree: 0, buckets: {} };
    var b = byType[type];
    b.total++;

    var findings = null;
    try { findings = JSON.parse(r.AIFindings || '{}'); } catch (e) {}
    if (!findings || findings.verdict === undefined) { b.noVerdict++; return; }

    var aiSaidApprove = findings.verdict === 'approve';
    var humanSaidApprove = r.Decision === 'approve';
    var confidence = Number(findings.confidence) || 0;
    var bucket = confidence >= 90 ? '90-100' : confidence >= 70 ? '70-89' : confidence >= 50 ? '50-69' : '<50';
    if (!b.buckets[bucket]) b.buckets[bucket] = { total: 0, agree: 0 };
    b.buckets[bucket].total++;

    if (aiSaidApprove === humanSaidApprove) {
      b.agree++;
      b.buckets[bucket].agree++;
    } else {
      b.disagree++;
      if (aiSaidApprove && !humanSaidApprove) b.dangerousDisagree++;
    }
  });

  var lines = [];
  if (!rows.length) lines.push('No Decided ReviewQueue rows yet - nothing to measure.');

  Object.keys(byType).forEach(function (type) {
    var b = byType[type];
    lines.push('--- ' + type + ' ---');
    lines.push('Total decided: ' + b.total + ' (no AI verdict to compare: ' + b.noVerdict + ')');
    var compared = b.agree + b.disagree;
    if (compared) {
      lines.push('Agreement rate: ' + Math.round(100 * b.agree / compared) + '% (' + b.agree + '/' + compared + ')');
      lines.push('Dangerous disagreements (AI approve, human said no): ' + b.dangerousDisagree);
      Object.keys(b.buckets).sort().reverse().forEach(function (bucket) {
        var bb = b.buckets[bucket];
        lines.push('  confidence ' + bucket + ': ' + Math.round(100 * bb.agree / bb.total) + '% agreement (' + bb.agree + '/' + bb.total + ')');
      });
    } else {
      lines.push('No comparable rows yet.');
    }
    lines.push('');
  });

  var report = lines.join('\n');
  Logger.log(report);

  // Easiest place to actually read this: the ActivityLog sheet tab,
  // most recent row, Detail column.
  logActivity('system', 'reviewer_accuracy_report', 'system', '-', report);

  // Best-effort only - never let a permissions/scope issue here stop the
  // report from completing.
  var emails = getConfig('REPORT_EMAILS');
  if (emails) {
    emails.split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (to) {
      try {
        MailApp.sendEmail(to, '[Jobverse] Reviewer Agent accuracy report', report);
      } catch (err) {
        Logger.log('Could not email report to ' + to + ': ' + err.message);
      }
    });
  }
  return report;
}
