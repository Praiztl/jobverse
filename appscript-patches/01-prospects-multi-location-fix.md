# Prospects.gs patch — findProspectsForCandidate

**What this changes:** searches every location in a candidate's `PreferredLocations`
list and merges all results, instead of only ever using the first one.

**Where it goes:** `Prospects.gs`, replacing the existing `findProspectsForCandidate`
function in full.

**Important:** this is reconstructed from what I read on screen across several
screenshots while diagnosing the empty-prospects issue, not copy-pasted from the
live file. Please diff it against the actual current function before pasting —
in particular double-check the `readRows('Prospects')`/`readRows('Applications')`
filter block and the `appendObject('Prospects', {...})` field list, which I'm
least certain I transcribed byte-for-byte. Everything from the `existingUrls`
line down should be logically identical to what's already there; only the
`what`/`where`/source-calling block above it is a real change.

```javascript
function findProspectsForCandidate(candidateId) {
  var cand = findRow('Candidates', 'CandidateID', candidateId);
  if (!cand) throw new Error('Candidate not found: ' + candidateId);

  var what = (cand.PreferredRoles || '').split(',')[0].trim() || 'software engineer';
  var resultsWanted = parseInt(getConfig('ADZUNA_RESULTS_PER_CANDIDATE') || '15', 10);

  var enabledSources = (getConfig('PROSPECT_SOURCES') || 'adzuna,reed,jsearch')
    .split(',').map(function (s) { return s.trim().toLowerCase(); });

  // CHANGED: search every preferred location the candidate listed, not just the first.
  // Was: var where = (cand.PreferredLocations || '').split(',')[0].trim();
  var locations = (cand.PreferredLocations || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!locations.length) locations = ['']; // preserve old "no location filter" behaviour

  var allResults = [];
  var sourceErrors = [];

  locations.forEach(function (where) {
    if (enabledSources.indexOf('adzuna') > -1) {
      try { allResults = allResults.concat(sourceAdzuna_(what, where, resultsWanted)); }
      catch (e) { sourceErrors.push('Adzuna (' + where + '): ' + e.message); }
    }
    if (enabledSources.indexOf('reed') > -1) {
      try { allResults = allResults.concat(sourceReed_(what, where, resultsWanted)); }
      catch (e) { sourceErrors.push('Reed (' + where + '): ' + e.message); }
    }
    if (enabledSources.indexOf('jsearch') > -1) {
      try { allResults = allResults.concat(sourceJSearch_(what, where, resultsWanted)); }
      catch (e) { sourceErrors.push('JSearch (' + where + '): ' + e.message); }
    }
  });

  // --- unchanged from the original file below this line ---

  var existingUrls = readRows('Prospects')
    .filter(function (p) { return p.CandidateID === candidateId; })
    .map(function (p) { return p.JobURL; });
  var appliedUrls = readRows('Applications')
    .filter(function (a) { return a.CandidateID === candidateId; })
    .map(function (a) { return a.JobURL; });
  var seen = {};
  existingUrls.concat(appliedUrls).forEach(function (u) { seen[u] = true; });

  var added = 0;
  allResults.forEach(function (job) {
    if (!job.url || seen[job.url]) return;
    seen[job.url] = true;

    var supportedATS = detectATSFromUrl_(job.url);
    appendObject('Prospects', {
      ProspectID: newId('PROS'),
      FoundAt: new Date(),
      CandidateID: candidateId,
      Company: job.company || '',
      JobTitle: job.title || '',
      JobURL: job.url,
      Source: job.source,
      Status: supportedATS ? 'Found' : 'Found - Manual Review',
      Notes: supportedATS ? '' : 'No supported ATS detected in this link. Open it, find the real employer application page, and paste that URL in if you want the extension to handle it.'
    });
    added++;
  });

  if (sourceErrors.length) {
    logActivity('system', 'prospect_source_error', 'candidate', candidateId, sourceErrors.join(' | '));
  }
  logActivity('system', 'prospects_found', 'candidate', candidateId, added + ' new prospects from ' + enabledSources.join('/'));
  return { found: allResults.length, added: added, errors: sourceErrors };
}
```

## After pasting

1. Save in the Apps Script editor.
2. No new deployment needed if the web app is deployed with "Execute as: Me" /
   "Who has access" pointed at the latest code already — Apps Script web apps
   only need a **redeploy** (Deploy → Manage deployments → Edit → new version)
   if the existing deployment is pinned to a specific old version. If unsure,
   redeploy to be safe.
3. Test: run `findProspectsForCandidate('CAND-260818-CAR3EJ')` (Germany, Uk,
   Ireland, Nigeria) or `'CAND-260819-PXDIPV'` (Germany, Ireland, Nigerian) —
   both should now return non-zero results from the `de`/`ie` Adzuna legs,
   now that ADZUNA_COUNTRY includes them.
4. `CAND-260729-6DE4NK` and `CAND-260818-IR2BAV` (Nigeria-only) will still
   return zero from Adzuna/Reed — Nigeria isn't served by either. Their only
   path to results is JSearch actually working; worth checking RAPIDAPI_KEY
   validity/quota separately, since it contributed 0 of 1,162 existing rows.
