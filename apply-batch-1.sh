#!/usr/bin/env bash
# Jobverse: apply the ready patches straight to your local repo clone.
#
# What this does:
#   - Deprecates appscript-patches/02 (built on wrong assumptions - never apply it)
#   - Adds appscript/Sync.js (patch 03: onEdit instant-sync trigger)
#   - Adds appscript/Analytics.js (patch 04: reviewer accuracy report)
#   - Replaces docs/help-guide-review-queue-addition.md with the corrected version
#   - Updates the root README.md status table
#   - Commits and pushes
#
# What this does NOT do:
#   - Does not touch your live Apps Script project in any way
#   - Does not run `clasp push` - that's a deliberate step you take yourself,
#     after reviewing what landed in appscript/Sync.js and Analytics.js
#   - Does not apply patch 05 (auto-decide) - hold that until reviewerAccuracyReport()
#     has given you real numbers to decide on
#   - Only ever WRITES NEW files under appscript/ - never edits your existing
#     Api.js, Agents.js, Prospects.js, etc.
#
# Usage: run this from inside your local jobverse-repo clone:
#   bash apply-batch-1.sh

set -euo pipefail

if [ ! -d ".git" ]; then
  echo "Run this from inside your jobverse-repo clone (the folder with .git in it)." >&2
  exit 1
fi

echo "Pulling latest..."
git pull origin main

echo "Deprecating appscript-patches/02 (do not apply - built on wrong assumptions)..."
if [ -f appscript-patches/02-claim-and-report-endpoints.md ]; then
  git mv appscript-patches/02-claim-and-report-endpoints.md \
         appscript-patches/DEPRECATED-02-claim-and-report-endpoints.md
fi

mkdir -p appscript

echo "Writing appscript/Sync.js..."
cat > appscript/Sync.js << 'SYNCJS_EOF'
/**
 * Jobverse - Sync.js
 * Instant push of ReviewQueue Decision/Status edits to the DB sync layer's
 * webhook, so a human's decision reaches Postgres within ~1 second instead
 * of waiting for the next periodic pull. No-ops safely (does nothing) until
 * SYNC_WEBHOOK_URL is set in Config - safe to have this deployed ahead of
 * the DB layer existing.
 *
 * SETUP REQUIRED (cannot be scripted - do this in the Apps Script UI):
 *   Triggers (clock icon) -> Add Trigger -> function: onReviewQueueEdit
 *   -> Event source: From spreadsheet -> Event type: On edit -> Save
 *
 * This MUST be an installable trigger, not left as a bare onEdit(e) - a
 * simple trigger can't call UrlFetchApp, which this needs to reach the
 * webhook.
 */
function onReviewQueueEdit(e) {
  var sheet = e.range.getSheet();
  if (sheet.getName() !== 'ReviewQueue') return;

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var decisionCol = headers.indexOf('Decision') + 1;
  var statusCol = headers.indexOf('Status') + 1;
  if (!decisionCol && !statusCol) return;

  var watchedCols = [decisionCol, statusCol].filter(Boolean);
  var editedStart = e.range.getColumn();
  var editedEnd = e.range.getLastColumn();
  var overlaps = watchedCols.some(function (c) { return c >= editedStart && c <= editedEnd; });
  if (!overlaps) return;

  var firstRow = Math.max(e.range.getRow(), 2);
  var lastRow = e.range.getLastRow();

  var rows = [];
  for (var r = firstRow; r <= lastRow; r++) {
    var values = sheet.getRange(r, 1, 1, headers.length).getValues()[0];
    var rowObj = {};
    headers.forEach(function (h, i) { rowObj[h] = values[i]; });
    if (rowObj.TaskID) rows.push(rowObj);
  }
  if (!rows.length) return;

  var webhookUrl = getConfig('SYNC_WEBHOOK_URL');
  var webhookToken = getConfig('SYNC_WEBHOOK_TOKEN');
  if (!webhookUrl) return; // sync layer not configured yet - no-op, don't error out edits

  try {
    UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + webhookToken },
      payload: JSON.stringify({ table: 'ReviewQueue', rows: rows }),
      muteHttpExceptions: true
    });
  } catch (err) {
    logActivity('system', 'sync_webhook_error', 'reviewqueue',
      rows.map(function (r) { return r.TaskID; }).join(','), err.message);
  }
}
SYNCJS_EOF

echo "Writing appscript/Analytics.js..."
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

  var emails = getConfig('REPORT_EMAILS');
  if (emails) {
    emails.split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (to) {
      MailApp.sendEmail(to, '[Jobverse] Reviewer Agent accuracy report', report);
    });
  }
  return report;
}
ANALYTICSJS_EOF

mkdir -p docs
echo "Writing corrected docs/help-guide-review-queue-addition.md..."
cat > docs/help-guide-review-queue-addition.md << 'HELPGUIDE_EOF'
# Help & guide addition — "What brings data to the Review Queue?"

**Where this goes:** Jobverse Console -> Help & guide page (lives in `Dashboard.html`).
Add as a new FAQ entry, matching the existing question/answer style.

### Suggested FAQ entry

**What brings an item into the Review Queue?**

Every time the Resume Builder or Cover Letter Builder generates a document, a
second AI — the Reviewer Agent — checks that document before it goes any
further. It looks for things like claims the CV makes that aren't backed up
by anything in the candidate's actual background (`unsupported_claims`), and
keywords from the job posting that are missing from the document
(`missing_keywords`), and produces an overall `ats_score` and a `confidence`
rating for its own review.

Every one of these reviews lands in the queue with **Status: Awaiting
Human**, along with its score and findings, and stays there until someone
opens it and decides. There's a separate, second checkpoint too: right
before an application would actually be submitted, the extension pauses
again and files a full snapshot of everything it's about to send — that
one also waits for a human Approve before anything reaches a real
employer. Nothing skips either queue on its own.

(If auto-decide is ever turned on for CV/CoverLetter/NHSStatement reviews
specifically — a config setting, off by default — a document that clears
a confidence bar gets decided automatically instead of waiting. That
never applies to the final submission checkpoint, which always waits for
a person.)

**Where do I see why something was flagged?**

Open the item in the Review Queue and check the `AIFindings` details — it
breaks out the ATS score, the confidence rating, any unsupported claims, and
any missing keywords the Reviewer Agent found, so you're not just looking at
a bare pass/fail number.
HELPGUIDE_EOF

echo "Updating README.md status table..."
cat > README.md << 'README_EOF'
# Jobverse

Job-application automation: candidates get matched to prospects, a
Resume/Cover Letter Builder generates documents, a Reviewer Agent
self-checks them, and — always, today, with no exceptions — a human
approves the actual submission before anything reaches a real employer.

## Repo layout

- `appscript/` — the live Apps Script project, pulled via `clasp clone`.
  Real files: `AI.js`, `Agents.js`, `Api.js`, `FormBuilder.js`, `Intake.js`,
  `Reports.js`, `Setup.js`, `Dashboard.html`, `Followup.js`, `Prospects.js`,
  plus the new `Sync.js` and `Analytics.js` added here.
- `appscript-patches/` — reviewed changes, in the order they were designed.
  `DEPRECATED-02` should never be applied — built on a wrong model of the
  system. `03` and `04` are new standalone files (already added to
  `appscript/` by this script). `05` is written but intentionally not
  applied — see status table.
- `db/schema.sql`, `db/sync/*.js`, `worker/*.js` — an earlier design for a
  Postgres sync layer and Playwright submission worker, built before the
  real `Api.js`/`Agents.js` were read. **Known stale** — don't provision a
  DB or run the worker against these yet.
- `docs/` — supporting docs, including the corrected Help & guide addition.

## Status

| Piece | State |
|---|---|
| Prospects.gs multi-location fix | Live, verified |
| Config (`ADZUNA_COUNTRY`) | Fixed in the live Sheet |
| Adzuna geo-block ATS resolver + Remotive source | Already live (found already in place when Prospects.js was read — built independently of this repo's work) |
| `Sync.js` (onReviewQueueEdit) | Added to `appscript/`, not yet deployed live or enabled as a trigger |
| `Analytics.js` (reviewerAccuracyReport) | Added to `appscript/`, not yet deployed live or run |
| Config-gated auto-decide (patch 05) | Written, intentionally not applied — wait for real accuracy numbers first |
| `DEPRECATED-02` claim/report endpoints | Do not apply — real `Api.js` already covers this via `apiPrecheckApplication_`/`apiStartApplication_`/`apiAnalyseJob_`/`apiRequestReview_`/`apiCheckApproval_`/`apiConfirmSubmission_` |
| Postgres schema / sync scripts / worker | Stale, built on wrong assumptions about the schema — needs a full rework against the real tables (`Jobs`, `CVVersions`, `CoverLetters`, `NHSStatements`, `AIOutputs`, `FollowUps` weren't accounted for) |
| Submission-type independent review | Doesn't exist yet — `apiRequestReview_` stores a raw snapshot with no AI verdict, so there's nothing to threshold on for auto-decide there. Future milestone, not started. |

## Next manual steps (need your Google login — can't be scripted)

1. Open the Apps Script editor (or run `clasp push` from this repo) to
   actually deploy `Sync.js` and `Analytics.js` to the live project.
2. Triggers (clock icon) -> Add Trigger -> `onReviewQueueEdit` -> From
   spreadsheet -> On edit -> Save. Must be an installable trigger, not a
   bare `onEdit(e)`.
3. Run `reviewerAccuracyReport()` once manually and look at the real
   numbers before deciding whether/when to apply patch 05.
README_EOF

echo "Committing..."
git add -A
git commit -m "Apply patch 03 (Sync.js) and 04 (Analytics.js), deprecate patch 02, correct Help & guide doc, update status README

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"

echo "Pushing..."
git push

echo ""
echo "Done. Repo updated. Still needed on your side (see README.md's 'Next manual steps'):"
echo "  1. clasp push (or paste manually) to actually deploy Sync.js/Analytics.js"
echo "  2. Add the installable onReviewQueueEdit trigger in the Apps Script UI"
echo "  3. Run reviewerAccuracyReport() once and look at the numbers"
