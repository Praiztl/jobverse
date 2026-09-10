# Api.gs additions — simplified, auto-clear only

Same caveat as every other patch this session: drafted from the
conventions used elsewhere in the codebase (appendObject/logActivity/
readRows naming), not copy-edited from the live file. Diff before pasting.

```javascript
var CLAIM_TIMEOUT_MINUTES = 10;
var AUTO_CLEAR_CONFIDENCE_MIN = 0.8; // match whatever the Reviewer Agent already uses for auto-Decided

/**
 * Claims the next generated-but-unsubmitted application whose Reviewer
 * Agent self-check came back clean: no unsupported_claims, confidence
 * at/above the existing auto-clear bar. Flagged items are left alone —
 * they stay in ReviewQueue for whenever (if) a human looks.
 */
function claimNextCleared_(workerId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var now = new Date();
    var apps = readRows('Applications');

    // release stale claims
    apps.forEach(function (a) {
      if (a.Status === 'Claiming' && a.ClaimedAt &&
          (now - new Date(a.ClaimedAt)) > CLAIM_TIMEOUT_MINUTES * 60 * 1000) {
        updateRow('Applications', 'ApplicationID', a.ApplicationID, { Status: 'Generated', ClaimedBy: '', ClaimedAt: '' });
      }
    });

    var candidates = readRows('Applications').filter(function (a) {
      if (a.Status !== 'Generated') return false; // generated, not yet submitted/claimed
      var findings = parseFindings_(a.AIFindings); // however AIFindings is actually stored/parsed elsewhere
      if (!findings) return false;
      var noUnsupported = !findings.unsupported_claims || findings.unsupported_claims.length === 0;
      var confident = (findings.confidence || 0) >= AUTO_CLEAR_CONFIDENCE_MIN;
      return noUnsupported && confident;
    });

    var next = candidates[0];
    if (!next) return null;

    updateRow('Applications', 'ApplicationID', next.ApplicationID, { Status: 'Claiming', ClaimedBy: workerId, ClaimedAt: now });
    logActivity('system', 'auto_submission_claimed', 'application', next.ApplicationID, 'claimed by ' + workerId);

    return {
      ApplicationID: next.ApplicationID,
      CandidateID: next.CandidateID,
      JobURL: next.JobURL,
      ATSType: next.ATSType || detectATSFromUrl_(next.JobURL),
      CVFileId: next.CVFileId || '',
      CoverLetterFileId: next.CoverLetterFileId || ''
    };
  } finally {
    lock.releaseLock();
  }
}

function reportSubmissionResult_(applicationId, status, notes) {
  if (status !== 'Submitted' && status !== 'Failed') throw new Error('bad status: ' + status);
  updateRow('Applications', 'ApplicationID', applicationId, {
    Status: status, ClaimedBy: '', ClaimedAt: '',
    SubmittedAt: status === 'Submitted' ? new Date() : '',
    Notes: notes || ''
  });
  logActivity('system', 'submission_' + status.toLowerCase(), 'application', applicationId, notes || '');
  return { ok: true };
}
```

Wire both into `doPost` the same way the extension's existing actions are
dispatched.
