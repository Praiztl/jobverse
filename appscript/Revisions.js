/**
 * JOBVERSE MVP - Revisions.gs
 * What happens when a reviewer clicks "Send back" on a generated document.
 *
 * dashDecide marks the ReviewQueue row Decided / revise and calls
 * scheduleRevisions_(), which sets a one-off trigger a few seconds out - the
 * rewrite takes about a minute of AI time, far too long to hold the
 * reviewer's click. processRevisionQueue then rebuilds each sent-back
 * document with the reviewer's notes and the Reviewer Agent's findings as a
 * brief. The new version goes through the Reviewer Agent like any other, so
 * it lands back in the Review queue as a fresh item.
 *
 * ReviewQueue.RevisedAs records the outcome on the sent-back row: the new
 * document's ID, 'In progress', or 'Error: ...'. Rows with it blank are
 * still to do. setupJobverse also installs a 10-minute fallback trigger in
 * case a one-off trigger can't be created or fails.
 */

var REVISABLE_DOCS_ = {
  CV: { sheet: 'CVVersions', idField: 'VersionID' },
  CoverLetter: { sheet: 'CoverLetters', idField: 'LetterID' },
  NHSStatement: { sheet: 'NHSStatements', idField: 'StatementID' }
};

/** Runs processRevisionQueue in a few seconds, unless a run is already scheduled. */
function scheduleRevisions_() {
  try {
    var pending = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === 'processRevisionQueueSoon';
    });
    if (!pending) ScriptApp.newTrigger('processRevisionQueueSoon').timeBased().after(5 * 1000).create();
  } catch (e) {
    // The 10-minute fallback trigger picks it up instead
    logActivity_('system', 'revision_schedule_error', 'system', '-', e.message);
  }
}

/** One-off trigger target: clears its own trigger, then works the queue. */
function processRevisionQueueSoon() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processRevisionQueueSoon') ScriptApp.deleteTrigger(t);
  });
  processRevisionQueue();
}

/** Rebuilds every sent-back document that hasn't been revised yet. Safe to run any time. */
function processRevisionQueue() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // another run is already on it
  try {
    ensureColumns_('ReviewQueue', ['RevisedAs']);
    var started = Date.now();
    var todo = readRows_('ReviewQueue', ['TaskID', 'Type', 'Status', 'Decision', 'RevisedAs']).filter(function (r) {
      return r.Status === 'Decided' && r.Decision === 'revise' && REVISABLE_DOCS_[r.Type] && !r.RevisedAs;
    });
    for (var i = 0; i < todo.length; i++) {
      // Stay well inside the 6-minute execution limit; the rest go to the next run
      if (Date.now() - started > 4 * 60 * 1000) { scheduleRevisions_(); break; }
      reviseOne_(todo[i].TaskID);
    }
  } finally {
    lock.releaseLock();
  }
}

function reviseOne_(taskId) {
  var t = findRow_('ReviewQueue', 'TaskID', taskId);
  if (!t) return;
  updateRow_('ReviewQueue', t._row, { RevisedAs: 'In progress' });
  try {
    var docTab = REVISABLE_DOCS_[t.Type];
    var prev = findRow_(docTab.sheet, docTab.idField, t.RefID);
    var revision = { notes: t.Notes || '', findings: t.AIFindings || '' };
    var tone = prev ? prev.ToneProfile : '';
    var revisedId;
    if (t.Type === 'CV') revisedId = runResumeBuilder_(t.CandidateID, t.JobID, tone, revision);
    else if (t.Type === 'CoverLetter') revisedId = runCoverLetterBuilder_(t.CandidateID, t.JobID, tone, revision);
    else revisedId = runNHSSupportingStatement_(t.CandidateID, t.JobID, tone || 'NHS', revision).statementId;
    updateRow_('ReviewQueue', t._row, { RevisedAs: revisedId });
    logActivity_('ai', 'document_revised', t.Type, revisedId, 'Revision of ' + t.RefID + ' (sent back in ' + t.TaskID + ')');
  } catch (e) {
    updateRow_('ReviewQueue', t._row, { RevisedAs: ('Error: ' + e.message).slice(0, 500) });
    logActivity_('system', 'revision_error', t.Type, t.RefID, e.message);
  }
}

/**
 * The prompt section that turns a sent-back document into a revision brief:
 * the reviewer's own notes come first and win over anything else.
 */
function revisionBrief_(revision) {
  if (!revision) return '';
  var f = {};
  try { f = JSON.parse(revision.findings || '{}'); } catch (ignored) {}
  var lines = ['\n\nREVISION REQUEST: a human reviewer sent the previous version of this document back. ' +
    'Write a new version that fixes the points below. The grounding rules still apply - fix unsupported ' +
    'claims by removing or rewording them, never by inventing evidence.'];
  if (revision.notes) lines.push('Reviewer notes (highest priority): ' + revision.notes);
  if ((f.unsupported_claims || []).length) lines.push('Unsupported claims to remove or reword: ' + f.unsupported_claims.join('; '));
  if ((f.missing_keywords || []).length) lines.push('Missing keywords to include only where the profile supports them: ' + f.missing_keywords.join(', '));
  if ((f.issues || []).length) lines.push('Other issues: ' + f.issues.join('; '));
  return lines.join('\n');
}
