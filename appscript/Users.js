/**
 * JOBVERSE - Users.gs
 * Who may open the Jobverse Console, and what each person may do there.
 *
 * Personal Gmail viewers are invisible to Apps Script (the web app runs as the
 * deployer, so Session.getActiveUser() is blank for them), so each person signs
 * in with their own link: <web app URL>?key=<personal key>. Only a SHA-256 hash
 * of the key is kept in the Users tab; a new link replaces the old one.
 *
 * Roles (ROLE_PERMS_):
 *   Admin  - everything, plus managing users, deleting candidates, clearing the
 *            log and seeing / changing saved site passwords
 *   Staff  - day-to-day work: approvals, documents, jobs, follow-ups, candidates' targets
 *   Viewer - read only (every page and report, no actions)
 *
 * The deploying account (signed in) and the old shared DASHBOARD_KEY link still
 * open the console as the Owner, an Admin, so nobody is locked out.
 */

var USERS_SHEET_ = 'Users';
var ROLES_ = ['Admin', 'Staff', 'Viewer'];
var ROLE_PERMS_ = {
  Admin: ['view', 'work', 'admin'],
  Staff: ['view', 'work'],
  Viewer: ['view']
};
var USERS_CACHE_KEY_ = 'users:v1';

// The person behind the current dashboard call, set by requireDashAccess_
var DASH_USER_ = null;

/* ------------------------------ identity ------------------------------ */

/** The console user for this key / signed-in account, or null. */
function dashUser_(key) {
  key = String(key || '');
  var owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  var ownerUser = { id: 'owner', name: 'Owner', email: owner, role: 'Admin' };

  var shared = getConfig_('DASHBOARD_KEY');
  if (shared && key && key === shared) return ownerUser;

  var users = usersCached_();
  if (key) {
    var hash = hashKey_(key);
    var byKey = users.filter(function (u) { return u.keyHash === hash; })[0];
    if (byKey) return byKey.status === 'Active' ? publicUser_(byKey) : null;
  }

  // Signed-in Google account: only visible for the deployer and same-domain Workspace accounts
  var viewer = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!viewer) return null;
  if (viewer === owner) return ownerUser;
  var listed = users.filter(function (u) { return u.email === viewer && u.status === 'Active'; })[0];
  if (listed) return publicUser_(listed);
  var legacyAdmins = (getConfig_('DASHBOARD_EMAILS') || '').split(',')
    .map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  if (legacyAdmins.indexOf(viewer) > -1) return { id: 'email:' + viewer, name: viewer, email: viewer, role: 'Admin' };
  return null;
}

function publicUser_(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

function userCan_(user, perm) {
  return !!user && (ROLE_PERMS_[user.role] || []).indexOf(perm || 'view') > -1;
}

/** What the log records as the actor of a dashboard action. */
function dashActor_() {
  if (DASH_USER_) return DASH_USER_.email || DASH_USER_.name || 'reviewer';
  return Session.getActiveUser().getEmail() || 'reviewer';
}

function hashKey_(key) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(key), Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function newUserKey_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

/* --------------------- the extension's person (doPost) --------------------- */

/*
 * Each person's Chrome extension sends their sign-in key (from their console
 * link) with every request, so the work it picks up is theirs: the jobs they
 * queued, and the applications it started. Requests without a key - an
 * extension not set up with a link yet - only get work nobody owns.
 */
var CALLER_ = null, CALLER_EXT_ = '';

// The extension version in the repo's main branch. Bump with manifest.json, so the console can tell
// people whose Chrome runs an older copy to update it.
var CURRENT_EXTENSION_VERSION_ = '1.3.23';

function setCaller_(userKey, ext) {
  CALLER_ = null;
  CALLER_EXT_ = String(ext || '').slice(0, 20);
  if (!userKey) return;
  CALLER_ = dashUser_(userKey);
  if (!CALLER_) throw new Error('The sign-in link saved in the Jobverse extension no longer works. ' +
    'Paste your current console link into the extension\'s Connection settings (ask an admin for a new one).');
}

function callerId_() { return CALLER_ ? CALLER_.id : ''; }

/** True for work this caller may pick up: theirs, or owned by nobody. */
function ownedByCaller_(owner) {
  owner = String(owner || '');
  return !owner || owner === callerId_();
}

function apiWhoAmI_() {
  return CALLER_ ? { name: CALLER_.name, email: CALLER_.email, role: CALLER_.role } : null;
}

/**
 * Who has jobs in line for a candidate, for the popup to explain an empty "Run my jobs":
 * { me: name or null (extension not linked), mine, unowned, others: [{ name, count }] }.
 */
function apiQueueSummary_(req) {
  var names = peopleNames_(), counts = {}, mine = 0, unowned = 0;
  readRows_('Prospects', ['CandidateID', 'Status', 'QueuedBy']).forEach(function (p) {
    if (p.CandidateID !== req.candidateId || p.Status !== 'Queued') return;
    var by = String(p.QueuedBy || '');
    if (!by) unowned++;
    else if (by === callerId_()) mine++;
    else counts[by] = (counts[by] || 0) + 1;
  });
  return {
    me: CALLER_ ? CALLER_.name : null, mine: mine, unowned: unowned,
    others: Object.keys(counts).map(function (id) { return { name: names[id] || 'someone who no longer has access', count: counts[id] }; })
  };
}

/**
 * "Run them here instead": this person takes over a candidate's jobs in line that belong to someone
 * else (or nobody), so their Chrome runs them. Only jobs still waiting - never one being applied to.
 */
function apiTakeOverQueue_(req) {
  if (!CALLER_) throw new Error('Link this Chrome to yourself first: paste your console sign-in link under Connection settings.');
  if (!userCan_(CALLER_, 'work')) throw new Error('Your role (' + CALLER_.role + ') cannot run jobs.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    ensureColumns_('Prospects', ['QueuedBy', 'QueuedAt']);
    var rows = readRows_('Prospects', ['ProspectID', 'CandidateID', 'Status', 'QueuedBy']).filter(function (p) {
      return p.CandidateID === req.candidateId && p.Status === 'Queued' && String(p.QueuedBy || '') !== CALLER_.id;
    });
    setColumnForRows_('Prospects', 'QueuedBy', rows.map(function (p) { return p._row; }), CALLER_.id);
    if (rows.length) logActivity_(CALLER_.email || CALLER_.name, 'queue_taken_over', 'candidate', req.candidateId, rows.length + ' job(s) now run by ' + CALLER_.name);
    return { taken: rows.length };
  } finally {
    lock.releaseLock();
  }
}

/** Names for the console to show next to queued jobs and applications: { userId: name }. */
function peopleNames_() {
  var out = { owner: 'Owner' };
  usersCached_().forEach(function (u) { out[u.id] = u.name || u.email; });
  return out;
}

/* ------------------------------ storage ------------------------------- */

function usersSheet_() {
  var sh = sheet_(USERS_SHEET_);
  if (!sh) {
    sh = SpreadsheetApp.getActiveSpreadsheet().insertSheet(USERS_SHEET_);
    SHEET_CACHE_[USERS_SHEET_] = sh;
  }
  if (sh.getLastRow() === 0) {
    sh.appendRow(JV.SHEETS.Users);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, JV.SHEETS.Users.length).setFontWeight('bold');
  }
  return sh;
}

/** Every user, from a one-minute shared copy (cleared whenever a user changes). */
function usersCached_() {
  var cache = CacheService.getScriptCache();
  try {
    var hit = cache.get(USERS_CACHE_KEY_);
    if (hit) return JSON.parse(hit);
  } catch (ignored) {}
  var sh = sheet_(USERS_SHEET_);
  var list = (sh && sh.getLastRow() >= 2 ? readRows_(USERS_SHEET_) : []).map(function (r) {
    return { id: String(r.UserID), name: String(r.Name || ''), email: String(r.Email || '').trim().toLowerCase(),
             role: ROLES_.indexOf(r.Role) > -1 ? r.Role : 'Viewer', status: r.Status === 'Disabled' ? 'Disabled' : 'Active',
             keyHash: String(r.KeyHash || '') };
  });
  try { cache.put(USERS_CACHE_KEY_, JSON.stringify(list), 60); } catch (ignored) {}
  return list;
}

function clearUsersCache_() {
  try { CacheService.getScriptCache().remove(USERS_CACHE_KEY_); } catch (ignored) {}
}

/** Notes when someone last opened the console - at most every 10 minutes per person. */
function noteUserSeen_(user) {
  if (!user || /^(owner|email:)/.test(user.id)) return;
  var cache = CacheService.getScriptCache(), k = 'userSeen:' + user.id;
  try { if (cache.get(k)) return; cache.put(k, '1', 600); } catch (ignored) {}
  var row = findRow_(USERS_SHEET_, 'UserID', user.id, ['UserID']);
  if (row) updateRow_(USERS_SHEET_, row._row, { LastSeenAt: new Date() });
}

/* --------------------------- console address -------------------------- */

/** The console's /exec address: Config CONSOLE_URL if set, else this deployment's own. */
function consoleUrl_() {
  var url = getConfig_('CONSOLE_URL') || ScriptApp.getService().getUrl() || '';
  return url.replace(/\/dev$/, '/exec');
}

function userLink_(key) {
  return consoleUrl_() + '?key=' + encodeURIComponent(key);
}

/** Emails a person their sign-in link from the deploying account (Gmail API, gmail.send scope). */
function sendUserLink_(name, email, role, link) {
  var subject = 'Your Jobverse Console access';
  var body = 'Hi ' + (name || 'there') + ',\n\n' +
    'You have been given ' + role + ' access to the Jobverse Console. Open it with your personal link:\n\n' +
    link + '\n\n' +
    'Bookmark it. The link signs you in, so do not share it - anyone with it can act as you. ' +
    'If it leaks, ask an admin for a new one and the old one stops working.\n\n' +
    'Jobverse';
  if (!sendMail_(email, subject, body)) throw new Error('Gmail would not send it - see the Activity log (email_failed)');
}

/* ------------------------------ dashboard RPC ------------------------------ */

/** Everyone with console access, for the Users page (admins only). Keys are never returned. */
function dashUsers(key) {
  var me = requireDashAccess_(key, 'admin');
  var sh = sheet_(USERS_SHEET_);
  var rows = sh && sh.getLastRow() >= 2 ? readRows_(USERS_SHEET_) : [];
  return {
    me: me.id,
    owner: String(Session.getEffectiveUser().getEmail() || ''),
    roles: ROLES_,
    users: rows.map(function (r) {
      return { id: String(r.UserID), name: String(r.Name || ''), email: String(r.Email || ''), role: String(r.Role || ''),
               status: r.Status === 'Disabled' ? 'Disabled' : 'Active', hasLink: !!r.KeyHash,
               linkSentMs: toEpochMs_(r.LinkSentAt), lastSeenMs: toEpochMs_(r.LastSeenAt),
               createdMs: toEpochMs_(r.CreatedAt), createdBy: String(r.CreatedBy || '') };
    })
  };
}

/**
 * Adds a person (no id) or changes one's name / role. A new person gets a
 * sign-in link straight away: returned for the admin to copy, and emailed to
 * them when `send` is true.
 */
function dashSaveUser(key, u, send) {
  var me = requireDashAccess_(key, 'admin');
  u = u || {};
  var name = String(u.name || '').trim();
  var email = String(u.email || '').trim().toLowerCase();
  var role = String(u.role || '');
  if (ROLES_.indexOf(role) === -1) throw new Error('Pick a role: ' + ROLES_.join(', '));
  if (!name) throw new Error('Enter their name');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    usersSheet_();
    var rows = readRows_(USERS_SHEET_, ['UserID', 'Email']);
    var clash = rows.filter(function (r) {
      return String(r.Email).trim().toLowerCase() === email && String(r.UserID) !== String(u.id || '');
    })[0];
    if (clash) throw new Error(email + ' already has access - edit that person instead.');

    if (u.id) {
      var row = findRow_(USERS_SHEET_, 'UserID', u.id);
      if (!row) throw new Error('User not found');
      if (String(u.id) === me.id && role !== row.Role) throw new Error('You cannot change your own role - ask another admin.');
      updateRow_(USERS_SHEET_, row._row, { Name: name, Email: email, Role: role });
      clearUsersCache_();
      logActivity_(dashActor_(), 'user_updated', 'user', u.id, name + ' <' + email + '> ' + role);
      return { saved: true, id: u.id };
    }

    var id = newId_('USR'), userKey = newUserKey_();
    appendObject_(USERS_SHEET_, {
      UserID: id, CreatedAt: new Date(), Name: name, Email: email, Role: role, Status: 'Active',
      KeyHash: hashKey_(userKey), CreatedBy: dashActor_()
    });
    clearUsersCache_();
    logActivity_(dashActor_(), 'user_added', 'user', id, name + ' <' + email + '> ' + role);
  } finally {
    lock.releaseLock();
  }
  return deliverLink_(id, name, email, role, userKey, send);
}

/** Disables (the link stops working at once) or re-enables a person. */
function dashSetUserStatus(key, userId, active) {
  var me = requireDashAccess_(key, 'admin');
  if (String(userId) === me.id) throw new Error('You cannot disable yourself.');
  var row = findRow_(USERS_SHEET_, 'UserID', userId);
  if (!row) throw new Error('User not found');
  updateRow_(USERS_SHEET_, row._row, { Status: active ? 'Active' : 'Disabled' });
  clearUsersCache_();
  logActivity_(dashActor_(), active ? 'user_enabled' : 'user_disabled', 'user', userId, row.Name + ' <' + row.Email + '>');
  return { status: active ? 'Active' : 'Disabled' };
}

/** Makes a new sign-in link for a person; their old link stops working. Emailed when `send` is true. */
function dashNewUserLink(key, userId, send) {
  requireDashAccess_(key, 'admin');
  var row = findRow_(USERS_SHEET_, 'UserID', userId);
  if (!row) throw new Error('User not found');
  var userKey = newUserKey_();
  updateRow_(USERS_SHEET_, row._row, { KeyHash: hashKey_(userKey) });
  clearUsersCache_();
  logActivity_(dashActor_(), 'user_link_reset', 'user', userId, row.Name + ' <' + row.Email + '>');
  return deliverLink_(userId, row.Name, row.Email, row.Role, userKey, send);
}

/**
 * The Owner's own sign-in link (the shared DASHBOARD_KEY), for their Chrome extension's Connection
 * settings. Shown only to the Owner: anyone holding it acts as the Owner.
 */
function dashOwnerLink(key) {
  var me = requireDashAccess_(key, 'admin');
  if (me.id !== 'owner') throw new Error("Only the Owner can see the Owner's sign-in link.");
  var shared = getConfig_('DASHBOARD_KEY');
  if (!shared) throw new Error('No DASHBOARD_KEY in the Config tab - run setup again to make one.');
  return { link: userLink_(shared) };
}

/** Permanently removes a person's access (their row is deleted). */
function dashRemoveUser(key, userId) {
  var me = requireDashAccess_(key, 'admin');
  if (String(userId) === me.id) throw new Error('You cannot remove yourself.');
  var row = findRow_(USERS_SHEET_, 'UserID', userId, ['Name', 'Email']);
  if (!row) throw new Error('User not found');
  deleteRowsWhere_(USERS_SHEET_, 'UserID', userId);
  clearUsersCache_();
  logActivity_(dashActor_(), 'user_removed', 'user', userId, row.Name + ' <' + row.Email + '>');
  return { removed: true };
}

function deliverLink_(id, name, email, role, userKey, send) {
  var link = userLink_(userKey), emailed = false, emailError = '';
  if (send) {
    try {
      sendUserLink_(name, email, role, link);
      emailed = true;
      var row = findRow_(USERS_SHEET_, 'UserID', id, ['UserID']);
      if (row) updateRow_(USERS_SHEET_, row._row, { LinkSentAt: new Date() });
    } catch (e) {
      emailError = e.message;
      logActivity_('system', 'user_link_email_failed', 'user', id, e.message);
    }
  }
  return { id: id, link: link, emailed: emailed, emailError: emailError };
}
