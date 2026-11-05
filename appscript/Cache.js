/**
 * JOBVERSE - Cache.js
 * One shared copy of the dashboard's data, so 16 people looking at the console
 * cost about one read of the spreadsheet rather than 16.
 *
 * buildDashData_ (Api.js) takes seconds: it reads a dozen tabs. Its result is
 * kept here, gzipped and split into chunks (CacheService holds 100 KB per key),
 * and handed to everyone for up to DASH_TTL_MS_.
 *
 * Freshness:
 *  - logActivity_ calls dashTouch_ on every action by a person or the
 *    extension, which marks the copy out of date at once.
 *  - The next request rebuilds it. Requests arriving during a rebuild, or
 *    within DASH_MIN_REBUILD_MS_ of the last one, get the copy already there -
 *    unless they pass `fresh`, as the page does after a person's own action,
 *    so nobody ever sees their own change undone.
 *  - Edits typed straight into the sheet show up within DASH_TTL_MS_.
 *
 * If the cache misbehaves in any way the data is simply built and returned.
 */
var DASH_TTL_MS_ = 20000;
var DASH_MIN_REBUILD_MS_ = 8000;
var DASH_MAX_STALE_MS_ = 60000;       // however busy it is, nobody is served older than this
var DASH_CHUNK_CHARS_ = 90000;
var DASH_CACHE_SECONDS_ = 300;

/** Marks the shared copy out of date. Flushes first, so a rebuild can't read the sheet from before this write. */
function dashTouch_() {
  try {
    SpreadsheetApp.flush();
    CacheService.getScriptCache().put('dash:gen', Utilities.getUuid(), 21600);
  } catch (ignored) {}
}

/**
 * The dashboard data as a JSON string (cheaper for google.script.run to carry
 * than a big object), or { unchanged: true } when `haveVersion` is still current.
 */
function dashSnapshot_(haveVersion, fresh) {
  var cache = null, gen = '', meta = null, building = false;
  try {
    cache = CacheService.getScriptCache();
    var got = cache.getAll(['dash:gen', 'dash:meta', 'dash:building']);
    gen = got['dash:gen'] || '';
    building = !!got['dash:building'];
    meta = got['dash:meta'] ? JSON.parse(got['dash:meta']) : null;
  } catch (ignored) {}

  if (meta && !fresh) {
    var age = Date.now() - meta.builtAt;
    var current = meta.gen === gen && age < DASH_TTL_MS_;
    if (current || (age < DASH_MAX_STALE_MS_ && (building || age < DASH_MIN_REBUILD_MS_))) {
      if (haveVersion && haveVersion === meta.version) return { unchanged: true, version: meta.version };
      var kept = dashReadChunks_(cache, meta);
      if (kept) return kept;
    }
  }

  try { if (cache) cache.put('dash:building', '1', 30); } catch (ignored) {}
  var data = buildDashData_();
  var version = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(data))).slice(0, 16);
  data.version = version;
  var json = JSON.stringify(data);
  // `gen` was read before the sheet was: a write during the build leaves this copy marked out of date
  dashWriteChunks_(cache, gen, version, json);
  if (haveVersion && haveVersion === version) return { unchanged: true, version: version };
  return json;
}

function dashWriteChunks_(cache, gen, version, json) {
  if (!cache) return;
  try {
    var packed = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(json, 'application/json')).getBytes());
    var parts = {}, count = 0;
    for (var i = 0; i < packed.length; i += DASH_CHUNK_CHARS_) {
      parts['dash:c:' + version + ':' + count++] = packed.slice(i, i + DASH_CHUNK_CHARS_);
    }
    cache.putAll(parts, DASH_CACHE_SECONDS_);
    // Chunks are named by version, so two builds at once can't mix; meta goes last so it never points at nothing
    cache.put('dash:meta', JSON.stringify({ gen: gen, version: version, builtAt: Date.now(), chunks: count }), DASH_CACHE_SECONDS_);
    cache.remove('dash:building');
  } catch (e) {
    console.warn('Dashboard snapshot not cached: ' + e.message);
  }
}

function dashReadChunks_(cache, meta) {
  try {
    var keys = [];
    for (var i = 0; i < meta.chunks; i++) keys.push('dash:c:' + meta.version + ':' + i);
    var got = cache.getAll(keys);
    var packed = keys.map(function (k) {
      if (!got[k]) throw new Error('chunk missing');
      return got[k];
    }).join('');
    return Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(packed), 'application/x-gzip')).getDataAsString('UTF-8');
  } catch (e) {
    return null;
  }
}

/**
 * Run from the editor to see how big the data has grown and how long the
 * dashboard takes to build. A Google Sheet slows down as it fills, and has a
 * hard limit of 10 million cells; AIOutputs and ActivityLog grow fastest.
 */
function jobverseHealth() {
  var lines = [], cells = 0;
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sh) {
    var n = sh.getMaxRows() * sh.getMaxColumns();
    cells += n;
    lines.push(sh.getName() + ': ' + Math.max(sh.getLastRow() - 1, 0) + ' rows, ' + n + ' cells');
  });
  var started = Date.now();
  var json = JSON.stringify(buildDashData_());
  lines.push('Total: ' + cells + ' of 10,000,000 cells');
  lines.push('Dashboard build: ' + (Date.now() - started) + ' ms, ' + Math.round(json.length / 1024) + ' KB');
  Logger.log(lines.join('\n'));
  return lines.join('\n');
}
