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
