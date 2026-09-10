#!/usr/bin/env bash
# Fixes Analytics.js: wraps MailApp.sendEmail in try/catch, matching the
# pattern the live codebase already uses in Api.js's notifyReviewers_ helper,
# so a mail-permission issue can never block the report itself from
# completing (Logger.log(report) already runs first regardless).
#
# Usage: run from inside your jobverse-repo clone:
#   bash fix-analytics-mail.sh

set -euo pipefail

if [ ! -d ".git" ]; then
  echo "Run this from inside your jobverse-repo clone (the folder with .git in it)." >&2
  exit 1
fi

echo "Pulling latest..."
git pull origin main

echo "Rewriting appscript/Analytics.js..."
cat > appscript/Analytics.js << 'ANALYTICSJS_EOF'
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

  // Email is best-effort only - never let a permissions/scope issue here
  // stop the report itself from returning, matching how notifyReviewers_
  // in Api.js already treats MailApp.
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
ANALYTICSJS_EOF

echo "Committing..."
git add -A
git commit -m "Fix Analytics.js: wrap MailApp.sendEmail in try/catch

Matches the existing notifyReviewers_ pattern in Api.js - a mail
permissions/scope issue should never block the report itself, since
Logger.log(report) already runs before the email attempt.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"

echo "Pushing..."
git push

echo ""
echo "Done. Now: clasp push, then re-run reviewerAccuracyReport() in the Apps Script editor."
