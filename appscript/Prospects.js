/**
 * JOBVERSE MVP - Prospects.gs
 * Finds job openings for a candidate using legitimate third-party job search
 * APIs (never scraping LinkedIn/Indeed directly, which both actively fight
 * scraping and would put the client's accounts at risk). Three sources are
 * supported, each optional and independently configured in Config:
 *
 *   - Adzuna (developer.adzuna.com)   - free, strong UK/Western Europe coverage
 *   - Reed (reed.co.uk/developers)    - free, UK-only, strong on healthcare/NHS-adjacent roles
 *   - JSearch (via rapidapi.com)      - metered free tier, reads Google for Jobs,
 *                                       much broader geographic reach (covers
 *                                       markets like Nigeria that Adzuna/Reed don't)
 *
 * PROSPECT_SOURCES in Config (default "adzuna,reed,jsearch") controls which
 * are attempted. Any source with no key configured is skipped silently -
 * this is deliberate so the daily trigger never errors just because one
 * source isn't set up yet.
 */

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
    if (enabledSources.indexOf('remotive') > -1) {
    try { allResults = allResults.concat(sourceRemotive_(what, where, resultsWanted)); }
    catch (e) { sourceErrors.push('Remotive: ' + e.message); }
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
  var companyCache = {}; // reused across resolver calls this run
  allResults.forEach(function (job) {
    // Adzuna links are geo-blocked redirects. Try to resolve to the
    // employer's own ATS page so the application isn't blocked by location.
    if (job.source && job.source.indexOf('Adzuna') === 0) {
      var resolved = resolveToATS_(job.company, job.title, companyCache);
      if (resolved) { job.url = resolved.url; job.source = 'Adzuna→' + resolved.ats; }
    }
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
/** Run for every active candidate. Safe to run on a daily trigger - skips inactive/archived candidates and silently skips any source with no key set. */
function findProspectsForAllCandidates() {
  var summary = [];
  readRows('Candidates').forEach(function (c) {
    if (c.Status === 'Archived') return;
    if (String(c.Active).toUpperCase() === 'FALSE') return; // skip inactive clients
    try {
      var r = findProspectsForCandidate(c.CandidateID);
      summary.push(c.CandidateID + ': +' + r.added);
    } catch (e) {
      logActivity('system', 'prospect_search_error', 'candidate', c.CandidateID, String(e.message || e));
    }
  });
  return summary.join(', ');
}

/* -------------------------------- sources -------------------------------- */

function sourceAdzuna_(what, where, resultsWanted) {
  var appId = getConfig('ADZUNA_APP_ID');
  var appKey = getConfig('ADZUNA_APP_KEY');
  if (!appId || !appKey) return []; // not configured - skip silently

  // Adzuna's API is per-country (no single global endpoint), so support a
  // comma separated list here and query each one, merging results.
  var countries = (getConfig('ADZUNA_COUNTRY') || 'gb')
    .split(',').map(function (c) { return c.trim().toLowerCase(); }).filter(Boolean);

  var allResults = [];
  countries.forEach(function (country) {
    var url = 'https://api.adzuna.com/v1/api/jobs/' + encodeURIComponent(country) + '/search/1'
      + '?app_id=' + encodeURIComponent(appId) + '&app_key=' + encodeURIComponent(appKey)
      + '&results_per_page=' + resultsWanted + '&what=' + encodeURIComponent(what)
      + (where ? '&where=' + encodeURIComponent(where) : '') + '&content-type=application/json';

    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var code = res.getResponseCode();
    if (code === 404) {
      // Country not supported by Adzuna - expected for markets like Nigeria. Skip silently.
      logActivity('system', 'adzuna_country_skipped', 'source', country, 'Country not in Adzuna coverage (404) - use JSearch for this market');
      return;
    }
    if (code !== 200) {
      logActivity('system', 'adzuna_country_error', 'source', country, 'HTTP ' + code);
      return;
    }
    var data = JSON.parse(res.getContentText());
    allResults = allResults.concat((data.results || []).map(function (job) {
      return {
        source: 'Adzuna (' + country + ')', company: (job.company && job.company.display_name) || '',
        title: job.title || '', url: job.redirect_url || ''
      };
    }));
  });
  return allResults;
}

function sourceReed_(what, where, resultsWanted) {
  var apiKey = getConfig('REED_API_KEY');
  if (!apiKey) return []; // not configured - skip silently

  var url = 'https://www.reed.co.uk/api/1.0/search?keywords=' + encodeURIComponent(what)
    + (where ? '&locationName=' + encodeURIComponent(where) : '')
    + '&resultsToTake=' + resultsWanted;

  // Reed uses HTTP Basic auth with the API key as the username and a blank password.
  var res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(apiKey + ':') },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  var data = JSON.parse(res.getContentText());
  return (data.results || []).map(function (job) {
    return {
      source: 'Reed', company: job.employerName || '',
      title: job.jobTitle || '', url: job.jobUrl || ''
    };
  });
}

function sourceJSearch_(what, where, resultsWanted) {
  var rapidKey = getConfig('RAPIDAPI_KEY');
  if (!rapidKey) return []; // not configured - skip silently

  var query = what + (where ? ' in ' + where : '');
  var url = 'https://jsearch.p.rapidapi.com/search?query=' + encodeURIComponent(query) + '&num_pages=1';

  var res = UrlFetchApp.fetch(url, {
    headers: { 'X-RapidAPI-Key': rapidKey, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 404) return []; // no jobs found for this query/location - not an error, just no coverage
  if (code !== 200) {
    logActivity('system', 'jsearch_error', 'source', 'HTTP ' + code,
      res.getContentText().slice(0, 400));
    throw new Error('HTTP ' + code);
  }
  var data = JSON.parse(res.getContentText());
  return ((data.data || []).slice(0, resultsWanted)).map(function (job) {
    return {
      source: 'JSearch', company: job.employer_name || '',
      title: job.job_title || '', url: job.job_apply_link || job.job_google_link || ''
    };
  });
}

/* =====================================================================
   JOBVERSE — Adzuna geo-block fix (ATS resolver) + Remotive source
   Paste the functions below into Prospects.gs, then apply the three small
   wiring changes described at the very bottom of this file.
   ===================================================================== */


/* ---------------------------------------------------------------------
   PART 1 — ATS RESOLVER
   Turns an Adzuna job (company name + title, whose redirect_url is
   geo-blocked) into a direct application URL on the employer's own
   Greenhouse / Lever / Ashby board. These are free, keyless, public
   JSON APIs. If we can't resolve it, we return null and the caller
   keeps the job flagged "Found - Manual Review" as before.

   NOTE ON COST: this makes a few extra UrlFetch calls per Adzuna job.
   To stay well within Apps Script's daily UrlFetch quota, resolution is
   only attempted for Adzuna results (not JSearch/Remotive, which are
   already direct), and it caches negative company lookups within a run.
   --------------------------------------------------------------------- */

/**
 * Try to find a direct apply URL on a supported ATS for a given company +
 * job title. Returns { url, ats } or null.
 * companyCache is a plain object reused across one findProspects run so we
 * don't re-probe the same company repeatedly.
 */
function resolveToATS_(companyName, jobTitle, companyCache) {
  if (!companyName) return null;
  var slugs = companySlugCandidates_(companyName);
  var wantTitle = normaliseTitle_(jobTitle);

  for (var i = 0; i < slugs.length; i++) {
    var slug = slugs[i];
    var cacheKey = slug;
    var jobs = companyCache[cacheKey];
    if (jobs === undefined) {
      jobs = probeAllATS_(slug);          // array of {title, url, ats} or []
      companyCache[cacheKey] = jobs;      // cache even empty results
    }
    if (!jobs.length) continue;

    // Exact-ish title match first, then loose contains match.
    var exact = jobs.find(function (j) { return normaliseTitle_(j.title) === wantTitle; });
    if (exact) return { url: exact.url, ats: exact.ats };
    var loose = jobs.find(function (j) {
      var t = normaliseTitle_(j.title);
      return t.indexOf(wantTitle) > -1 || wantTitle.indexOf(t) > -1;
    });
    if (loose) return { url: loose.url, ats: loose.ats };
  }
  return null;
}

/** Probe Greenhouse, Lever and Ashby for a slug. Returns merged job list. */
function probeAllATS_(slug) {
  var out = [];
  out = out.concat(probeGreenhouse_(slug), probeLever_(slug), probeAshby_(slug));
  return out;
}

function probeGreenhouse_(slug) {
  try {
    var res = UrlFetchApp.fetch(
      'https://api.greenhouse.io/v1/boards/' + encodeURIComponent(slug) + '/jobs?content=true',
      { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return [];
    var data = JSON.parse(res.getContentText());
    return (data.jobs || []).map(function (j) {
      return { title: j.title || '', url: j.absolute_url || '', ats: 'Greenhouse' };
    });
  } catch (e) { return []; }
}

function probeLever_(slug) {
  try {
    var res = UrlFetchApp.fetch(
      'https://api.lever.co/v0/postings/' + encodeURIComponent(slug) + '?mode=json',
      { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return [];
    var data = JSON.parse(res.getContentText());
    if (!Array.isArray(data)) return [];
    return data.map(function (j) {
      return { title: (j.text || '') , url: j.hostedUrl || j.applyUrl || '', ats: 'Lever' };
    });
  } catch (e) { return []; }
}

function probeAshby_(slug) {
  try {
    var res = UrlFetchApp.fetch(
      'https://api.ashbyhq.com/posting-api/job-board/' + encodeURIComponent(slug),
      { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return [];
    var data = JSON.parse(res.getContentText());
    return (data.jobs || []).filter(function (j) { return j.isListed !== false; }).map(function (j) {
      return { title: j.title || '', url: j.jobUrl || j.applyUrl || '', ats: 'Ashby' };
    });
  } catch (e) { return []; }
}

/**
 * Generate plausible ATS board slugs from a company display name.
 * "Acme Corp Ltd." -> ["acmecorp", "acme-corp", "acme", ...]
 * ATS slugs are lowercase, no spaces/punctuation; we try a few shapes.
 */
function companySlugCandidates_(name) {
  var base = String(name).toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\b(ltd|limited|inc|llc|plc|gmbh|corp|corporation|co|company|group|holdings)\b/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
  var words = base.split(/\s+/).filter(Boolean);
  var cands = {};
  if (words.length) {
    cands[words.join('')] = 1;      // acmecorp
    cands[words.join('-')] = 1;     // acme-corp
    cands[words[0]] = 1;            // acme
  }
  return Object.keys(cands).filter(Boolean);
}

function normaliseTitle_(t) {
  return String(t).toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(senior|junior|lead|staff|principal|sr|jr|i|ii|iii|remote|hybrid|contract|permanent|full time|part time)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}


/* ---------------------------------------------------------------------
   PART 2 — REMOTIVE SOURCE
   Free, no key, remote jobs. Returns direct apply/listing links (no
   aggregator redirect, so no geo-block). Especially useful for
   Nigeria/remote candidates that Adzuna/Reed can't serve.
   Remotive asks that you keep their job URL and credit Remotive as the
   source — we store their url and tag Source = "Remotive", satisfying that.
   --------------------------------------------------------------------- */

function sourceRemotive_(what, where, resultsWanted) {
  // Remotive has no per-country filter (jobs are remote); we search by term.
  var url = 'https://remotive.com/api/remote-jobs?search=' + encodeURIComponent(what) +
            '&limit=' + resultsWanted;
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return [];
    var data = JSON.parse(res.getContentText());
    return (data.jobs || []).slice(0, resultsWanted).map(function (j) {
      return {
        source: 'Remotive', company: j.company_name || '',
        title: j.title || '', url: j.url || ''
      };
    });
  } catch (e) { return []; }
}

function detectATSFromUrl_(url) {
  var u = String(url).toLowerCase();
  return /myworkdayjobs|workday\.com|greenhouse\.io|lever\.co|ashbyhq\.com|jobs\.nhs\.uk/.test(u);
}

