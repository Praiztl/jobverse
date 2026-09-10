# ReviewQueue instant-sync trigger

**Goal:** the moment a human changes `Decision` or `Status` on a ReviewQueue
row, push that row to the sync webhook immediately — no polling lag.

**Important — this must be an *installable* trigger, not a simple one.**
A plain function named `onEdit(e)` (a "simple trigger") runs automatically
but is barred from calling any service that needs authorization —
`UrlFetchApp` included. Since this needs to make an outbound HTTPS call,
it has to be wired up as an **installable trigger** instead: write the
function under any name, then in the Apps Script editor go to the clock
icon (Triggers) → **Add Trigger** → function `onReviewQueueEdit` → event
source "From spreadsheet" → event type "On edit" → Save. That one-time
setup click is on your side, same bucket as creating a deployment version —
project configuration, not something I do myself.

**Where the code goes:** a new function in `Api.gs` (or a new `Sync.gs` if
you'd rather keep it separate — your call).

```javascript
/**
 * Installable "On edit" trigger. Fires on every edit to the spreadsheet;
 * exits immediately unless the edit touched ReviewQueue's Decision or
 * Status column. Pushes the affected row(s) to the sync webhook so the DB
 * layer sees a human decision within ~1 second instead of waiting for the
 * next periodic pull.
 */
function onReviewQueueEdit(e) {
  var sheet = e.range.getSheet();
  if (sheet.getName() !== 'ReviewQueue') return;

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var decisionCol = headers.indexOf('Decision') + 1;
  var statusCol = headers.indexOf('Status') + 1;
  if (!decisionCol && !statusCol) return;

  // Only react if the edited range actually overlaps Decision or Status —
  // handles both a single-cell edit and a multi-cell paste.
  var watchedCols = [decisionCol, statusCol].filter(Boolean);
  var editedStart = e.range.getColumn();
  var editedEnd = e.range.getLastColumn();
  var overlaps = watchedCols.some(function (c) { return c >= editedStart && c <= editedEnd; });
  if (!overlaps) return;

  var firstRow = Math.max(e.range.getRow(), 2); // never treat the header row as data
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
  if (!webhookUrl) return; // sync layer not configured yet — no-op, don't error out edits

  try {
    UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + webhookToken },
      payload: JSON.stringify({ table: 'ReviewQueue', rows: rows }),
      muteHttpExceptions: true
    });
  } catch (err) {
    // Never let a sync failure block the human's edit — just log it.
    logActivity('system', 'sync_webhook_error', 'reviewqueue',
      rows.map(function (r) { return r.TaskID; }).join(','), err.message);
  }
}
```

## Two new Config entries this needs

- `SYNC_WEBHOOK_URL` — the DB-side receiver's endpoint (part of the `db/`
  sync layer we haven't built yet — this trigger no-ops safely until it
  exists, so it's safe to paste and enable now, ahead of the DB work).
- `SYNC_WEBHOOK_TOKEN` — shared secret the receiver checks before trusting
  a payload.

Both are plain Config cells — same category as `ADZUNA_COUNTRY` earlier, so
once you have real values I can drop them into the Config sheet directly,
same as before.

## Same caveat as every patch this session

I haven't read the live `Api.gs`/Config-reading code in this session, so
`getConfig`/`logActivity` are assumed to work exactly as they do elsewhere
in the codebase (which they should, since every other file uses them the
same way) — still worth a quick diff before pasting.
