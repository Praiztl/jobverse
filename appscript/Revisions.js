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
 * The same rewrite also serves "Update CV" / "Update cover letter" on an
 * application (dashReviseDocument), which runs it straight away instead of
 * through a trigger. The writer gets the current text of the document, so a
 * person's edits in Google Docs and everything they didn't ask to change are
 * kept.
 *
 * ReviewQueue.RevisedAs records the outcome on the sent-back row: the new
 * document's ID, 'In progress <ms>', or 'Error: ...'. Rows with it blank are
 * still to do. setupJobverse also installs a 10-minute fallback trigger in
 * case a one-off trigger can't be created or fails, and it picks up a rewrite
 * whose execution died.
 *
 * Rows are claimed one at a time under a brief lock. The rewrite itself runs
 * outside the lock: it takes a minute or more, and the script lock is the same
 * one every Chrome needs to claim a queued job.
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

var REVISION_STALE_MS_ = 10 * 60 * 1000; // longer than any rewrite takes; after that its execution has died

/** 'todo', 'working', 'stalled' (its execution died), 'error' or 'done', from a ReviewQueue.RevisedAs value. */
function revisionState_(revisedAs) {
  var v = String(revisedAs || '');
  if (!v) return 'todo';
  if (/^Error/.test(v)) return 'error';
  if (!/^In progress/.test(v)) return 'done';
  var at = Number(v.replace(/^In progress\s*/, ''));
  return at && Date.now() - at < REVISION_STALE_MS_ ? 'working' : 'stalled';
}

function revisionStamp_() { return 'In progress ' + Date.now(); }

/** Takes one sent-back row for this execution. False if another run has it. */
function claimRevision_(taskId) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    var t = findRow_('ReviewQueue', 'TaskID', taskId, ['RevisedAs']);
    if (!t) return false;
    var state = revisionState_(t.RevisedAs);
    // A bare 'In progress' is from before stamps; it waits for a person's Try again rather than rerunning unasked
    if (state !== 'todo' && !(state === 'stalled' && /\d/.test(String(t.RevisedAs)))) return false;
    updateRow_('ReviewQueue', t._row, { RevisedAs: revisionStamp_() });
    SpreadsheetApp.flush();
    return true;
  } finally {
    lock.releaseLock();
  }
}

/** Rebuilds every sent-back document that hasn't been revised yet. Safe to run any time, even twice at once. */
function processRevisionQueue() {
  ensureColumns_('ReviewQueue', ['RevisedAs']);
  var started = Date.now();
  var todo = readRows_('ReviewQueue', ['TaskID', 'Type', 'Status', 'Decision', 'RevisedAs']).filter(function (r) {
    var state = revisionState_(r.RevisedAs);
    return r.Status === 'Decided' && r.Decision === 'revise' && REVISABLE_DOCS_[r.Type] && (state === 'todo' || state === 'stalled');
  });
  for (var i = 0; i < todo.length; i++) {
    // Stay well inside the 6-minute execution limit; the rest go to the next run
    if (Date.now() - started > 4 * 60 * 1000) { scheduleRevisions_(); break; }
    if (claimRevision_(todo[i].TaskID)) reviseOne_(todo[i].TaskID);
  }
}

/** The text of a generated document as it reads now, including any edits made in Google Docs. */
function currentDocText_(docRow) {
  try { return docRow && docRow.DocID ? DocumentApp.openById(docRow.DocID).getBody().getText() : ''; }
  catch (e) { return ''; }
}

/** Writes the new version for a claimed row (RevisedAs already 'In progress'). */
function reviseOne_(taskId) {
  var t = findRow_('ReviewQueue', 'TaskID', taskId);
  if (!t) return;
  try {
    var docTab = REVISABLE_DOCS_[t.Type];
    var prev = findRow_(docTab.sheet, docTab.idField, t.RefID);
    var revision = { notes: t.Notes || '', findings: t.AIFindings || '', previousText: currentDocText_(prev) };
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
  dashTouch_();
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
  if (revision.previousText) {
    lines.push('PREVIOUS VERSION of the document, which a person may have edited by hand. Start from it and keep ' +
      'everything nobody asked to change, word for word where you can:\n' + String(revision.previousText).slice(0, 15000));
  }
  if (revision.notes) {
    lines.push('Reviewer notes (highest priority; facts the reviewer states count as evidence from the candidate): ' + revision.notes);
  }
  if ((f.unsupported_claims || []).length) lines.push('Unsupported claims to remove or reword: ' + f.unsupported_claims.join('; '));
  if ((f.missing_keywords || []).length) lines.push('Missing keywords to include only where the profile supports them: ' + f.missing_keywords.join(', '));
  if ((f.issues || []).length) lines.push('Other issues: ' + f.issues.join('; '));
  return lines.join('\n');
}
