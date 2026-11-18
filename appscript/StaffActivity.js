/**
 * JOBVERSE - StaffActivity.gs
 * What each person on the team did, reported back to the Admins.
 *
 * Every ActivityLog row written during a person's call - a console action, or
 * their linked Chrome extension - carries their UserID (logActivity_ in
 * Setup.gs). Rows from before that column existed are matched by the actor's
 * email instead. From those rows:
 *  - the Staff activity page (dashStaffActivity): Admins see everyone, Staff
 *    see their own work;
 *  - the daily / weekly / monthly report email gets a "Team activity" section
 *    (staffActivityLines_, called from buildReport_ in Reports.gs);
 *  - anyone who can work can record work done outside the console - a call to
 *    a recruiter, an application sent by hand - as a work note (dashLogWork).
 *
 * Clearing the activity log clears this history too.
 */

var STAFF_CATS_ = [
  { key: 'approved', label: 'Applications approved' },
  { key: 'sentBack', label: 'Applications sent back' },
  { key: 'docs', label: 'Documents checked' },
  { key: 'submitted', label: 'Applications submitted' },
  { key: 'started', label: 'Applications started' },
  { key: 'queued', label: 'Jobs queued' },
  { key: 'followups', label: 'Follow-ups handled' },
  { key: 'notes', label: 'Work notes' },
  { key: 'other', label: 'Other actions' }
];
var STAFF_SCAN_CHUNK_ = 2000;
var STAFF_SCAN_MAX_ROWS_ = 40000;  // keeps one read well inside the execution limit
var STAFF_RECENT_MAX_ = 60;

/**
 * The category a logged action counts under, and how many it counts as, or null
 * for steps that aren't a person's work (AI and system steps run during their call,
 * the extension's housekeeping).
 */
function staffCategory_(actor, action, refType, detail) {
  actor = String(actor || ''); action = String(action || '');
  if (/^(ai|system|form)$/.test(actor)) return null;
  if (actor === 'extension') {
    if (action === 'application_started') return { key: 'started', n: 1 };
    if (action === 'application_submitted') return { key: 'submitted', n: 1 };
    return null;
  }
  if (action === 'work_note') return { key: 'notes', n: 1 };
  if (/^review_/.test(action) && action !== 'review_missing') {
    if (refType !== 'Submission') return { key: 'docs', n: 1 };
    return { key: action === 'review_approve' ? 'approved' : 'sentBack', n: 1 };
  }
  if (action === 'document_update_requested') return { key: 'docs', n: 1 };
  if (action === 'application_marked_submitted') return { key: 'submitted', n: 1 };
  if (action === 'prospect_Queued') return { key: 'queued', n: 1 };
  if (action === 'prospects_bulk_queued') return { key: 'queued', n: parseInt(detail, 10) || 0 };
  if (/^followup_/.test(action)) return { key: 'followups', n: 1 };
  if (action === 'review_missing') return null;
  return { key: 'other', n: 1 };
}

/**
 * Each person's work between fromMs (included) and toMs (not included).
 * onlyUserId limits it to one person. Reads the log from the newest row back,
 * so a short period costs a short read.
 */
function staffActivity_(fromMs, toMs, onlyUserId) {
  var users = usersCached_();
  var owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  var byEmail = {};
  users.forEach(function (u) { if (u.email) byEmail[u.email] = u.id; });
  if (owner) byEmail[owner] = 'owner';

  var people = {};
  var person = function (id) {
    if (people[id]) return people[id];
    var u = users.filter(function (x) { return x.id === id; })[0];
    var p = people[id] = {
      id: id,
      name: u ? (u.name || u.email) : id === 'owner' ? 'Owner' : id.replace(/^email:/, ''),
      email: u ? u.email : id === 'owner' ? owner : id.replace(/^email:/, ''),
      role: u ? u.role : 'Admin', status: u ? u.status : 'Active',
      total: 0, counts: {}, lastMs: 0, days: {}, recent: []
    };
    STAFF_CATS_.forEach(function (c) { p.counts[c.key] = 0; });
    return p;
  };
  // Everyone who can work shows up, even with nothing done - a quiet week is worth seeing too
  users.forEach(function (u) {
    if (u.status === 'Active' && userCan_(u, 'work') && (!onlyUserId || u.id === onlyUserId)) person(u.id);
  });

  var tz = Session.getScriptTimeZone();
  var sh = sheet_('ActivityLog');
  var last = sh ? sh.getLastRow() : 0;
  var truncated = false;
  if (last >= 2) {
    var map = getHeaderMap_(sh);
    var uCol = map.UserID || 0;
    var width = Math.max(6, uCol);
    var end = last, scanned = 0, done = false;
    while (end >= 2 && !done) {
      if (scanned >= STAFF_SCAN_MAX_ROWS_) { truncated = true; break; }
      var start = Math.max(2, end - STAFF_SCAN_CHUNK_ + 1);
      var vals = sh.getRange(start, 1, end - start + 1, width).getValues();
      scanned += vals.length;
      for (var i = vals.length - 1; i >= 0; i--) {
        var r = vals[i], ms = toEpochMs_(r[0]);
        if (!ms) continue;
        if (ms < fromMs) { done = true; break; }  // the log is in time order
        if (ms >= toMs) continue;
        var actor = String(r[1] || '');
        var id = uCol ? String(r[uCol - 1] || '') : '';
        if (!id) id = byEmail[actor.toLowerCase()] || '';
        if (!id || (onlyUserId && id !== onlyUserId)) continue;
        var cat = staffCategory_(actor, r[2], String(r[3] || ''), String(r[5] || ''));
        if (!cat) continue;
        var p = person(id);
        p.counts[cat.key] += cat.n;
        p.total += cat.n;
        if (ms > p.lastMs) p.lastMs = ms;
        p.days[Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd')] = true;
        if (p.recent.length < STAFF_RECENT_MAX_) {
          p.recent.push({ ms: ms, action: String(r[2] || ''), cat: cat.key, via: actor === 'extension' ? 'extension' : 'console',
                          ref: String(r[4] || ''), detail: String(r[5] || '').slice(0, 300) });
        }
      }
      end = start - 1;
    }
  }

  var list = Object.keys(people).map(function (k) {
    var p = people[k];
    p.activeDays = Object.keys(p.days).length;
    delete p.days;
    return p;
  }).sort(function (a, b) { return b.total - a.total || String(a.name).localeCompare(String(b.name)); });

  var sheetUsers = sheet_(USERS_SHEET_);
  if (sheetUsers && sheetUsers.getLastRow() >= 2) {
    var lastSeen = {};
    readRows_(USERS_SHEET_, ['UserID', 'LastSeenAt']).forEach(function (r) { lastSeen[String(r.UserID)] = toEpochMs_(r.LastSeenAt); });
    list.forEach(function (p) { p.lastSeenMs = lastSeen[p.id] || 0; });
  }
  return { categories: STAFF_CATS_, people: list, truncated: truncated };
}

/* ------------------------------ dashboard RPC ------------------------------ */

/**
 * The Staff activity page for a period (yyyy-MM-dd, both days included).
 * Admins get everyone; Staff get their own work only.
 */
function dashStaffActivity(key, from, to) {
  var me = requireDashAccess_(key, 'work');
  var start = reportDay_(from), end = reportDay_(to);
  if (!start || !end || end < start) throw new Error('Pick a start date on or before the end date');
  end.setDate(end.getDate() + 1);
  var only = userCan_(me, 'admin') ? '' : me.id;

  var cache = CacheService.getScriptCache(), ckey = '';
  try { ckey = 'staff:' + (only || 'all') + ':' + from + ':' + to + ':' + (cache.get('dash:gen') || ''); } catch (ignored) {}
  if (ckey) {
    try { var hit = cache.get(ckey); if (hit) return JSON.parse(hit); } catch (ignored) {}
  }
  var out = staffActivity_(start.getTime(), end.getTime(), only);
  out.from = from; out.to = to; out.generated = Date.now(); out.everyone = !only; out.me = me.id;
  if (ckey) { try { cache.put(ckey, JSON.stringify(out), 600); } catch (ignored) { /* too big to keep */ } }
  return out;
}

/** Records work done outside the console (a call, an email, an application sent by hand) for the Admins to see. */
function dashLogWork(key, text) {
  requireDashAccess_(key, 'work');
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Write what you did');
  if (text.length > 1000) text = text.slice(0, 1000);
  logActivity_(dashActor_(), 'work_note', 'note', '-', text);
  return { logged: true };
}

/* --------------------------------- email --------------------------------- */

/** The "Team activity" lines of a report email, or [] when nobody has console access yet. */
function staffActivityLines_(fromMs, toMs) {
  var s = staffActivity_(fromMs, toMs, '');
  if (!s.people.length) return [];
  var tz = Session.getScriptTimeZone();
  var lines = ['', 'Team activity:'];
  s.people.forEach(function (p) {
    if (!p.total) { lines.push('- ' + p.name + ' (' + p.role + '): nothing recorded'); return; }
    var parts = STAFF_CATS_.filter(function (c) { return p.counts[c.key]; })
      .map(function (c) { return p.counts[c.key] + ' ' + c.label.toLowerCase(); });
    lines.push('- ' + p.name + ' (' + p.role + '): ' + parts.join(', ') +
      '. Last active ' + Utilities.formatDate(new Date(p.lastMs), tz, 'd MMM HH:mm'));
    p.recent.filter(function (r) { return r.cat === 'notes'; }).slice(0, 5).forEach(function (r) {
      lines.push('    note: ' + r.detail);
    });
  });
  if (s.truncated) lines.push('(Only the newest ' + STAFF_SCAN_MAX_ROWS_ + ' log entries were read.)');
  return lines;
}
