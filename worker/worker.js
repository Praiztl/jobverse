/**
 * Jobverse application worker (Playwright), wired to the real Api.gs
 * endpoints (not the earlier invented claim/report model).
 *
 * Two passes each cycle, deliberately non-blocking:
 *
 *  1. FILL: for each active candidate's Queued prospects - precheck, read the
 *     job ad from its page, analyse it, generate the CV/cover letter, start the application,
 *     download the generated documents as real PDFs, fill the form with
 *     unified-form-filler.js, then request human review of a snapshot of what
 *     would be submitted. The worker never clicks the real Submit button in
 *     this pass - Applications sits at "Awaiting Review" until a human
 *     decides in the Jobverse Console (dashDecide).
 *
 *  2. SUBMIT: for each candidate's applications now "Approved - Submitting"
 *     (a human said yes), re-open a fresh page, re-fill the form the same
 *     way, then actually click Submit and confirm it.
 *
 * Re-filling on submit instead of holding one long-lived browser session
 * open while waiting on a human avoids blocking the whole worker on review
 * turnaround time. The cost is filling twice for anything that gets
 * approved - acceptable for an MVP, and worth revisiting if ATS forms turn
 * out to have side effects on repeat fills (rare, but module authors should
 * keep fillForm idempotent).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { chromium } = require('playwright');

const unifiedFormFiller = require('./unified-form-filler');

const {
  JOBVERSE_API_URL,
  JOBVERSE_API_TOKEN,
  WORKER_ID = 'jobverse-worker-1',
  POLL_INTERVAL_MS = 30000,
  DOWNLOAD_DIR = './downloads',
  HEADED = 'false',
  MIN_SUITABILITY = '0',
} = process.env;

if (!JOBVERSE_API_URL || !JOBVERSE_API_TOKEN) {
  console.error('Set JOBVERSE_API_URL and JOBVERSE_API_TOKEN in .env (see .env.example).');
  process.exit(1);
}

async function callApi(action, body) {
  const res = await fetch(JOBVERSE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, token: JOBVERSE_API_TOKEN, ...body }),
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  if (!res.ok || !json || json.ok === false) {
    const msg = json && json.error ? json.error : `HTTP ${res.status}`;
    throw new Error(`Jobverse API "${action}" failed: ${msg}`);
  }
  return json.data;
}

async function downloadDocPdf(docUrl, destPath) {
  if (!docUrl) throw new Error('No document URL to download (cvUrl/letterUrl was empty).');
  const { base64 } = await callApi('exportDocumentPdf', { docUrl });
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.from(base64, 'base64'));
  return destPath;
}

// Unified form filler handles all ATS platforms automatically

/** Leading number of a suitability like "85 (strong match on X)", or null if there isn't one. */
function suitabilityScore(s) {
  const n = parseFloat(String(s || ''));
  return Number.isFinite(n) ? n : null;
}

/** The job ad's text, read from the live page - prospects only carry a URL, and the AI needs the real description. */
async function readJobText(browser, url) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    return String(text || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 25000);
  } finally {
    await context.close();
  }
}

/**
 * Pass 1: discover queued prospects, generate + fill, hand off to review.
 *
 * Every prospect leaves 'Queued' whatever happens - otherwise a failure is
 * picked up again on the next poll and the whole pipeline (AI calls, new
 * Docs) re-runs every POLL_INTERVAL_MS. Failed ones end as 'Error' with the
 * reason in Notes; a person re-queues them from the dashboard.
 */
async function fillQueuedProspects(candidate, browser) {
  const prospects = await callApi('listProspects', { candidateId: candidate.id, status: 'Queued' });

  for (const prospect of prospects) {
    const setStatus = (status, notes) =>
      callApi('updateProspectStatus', { prospectId: prospect.id, status, notes: String(notes || '').slice(0, 500) })
        .catch((e) => console.error(`[${prospect.id}] Could not set prospect status ${status}:`, e.message));
    try {
      const pre = await callApi('precheckApplication', {
        candidateId: candidate.id, jobUrl: prospect.url, company: prospect.company, jobTitle: prospect.title,
      });
      if (pre.block) {
        console.log(`[${prospect.id}] Skipping (${pre.block}).`);
        // A full day or a met target applies to every prospect - leave them queued for later
        if (pre.block === 'throttled' || pre.block === 'targetMet') return;
        await setStatus('Skipped', 'precheck: ' + pre.block);
        continue;
      }
      await setStatus('In Progress - Worker', 'Picked up by ' + WORKER_ID);

      const jdText = await readJobText(browser, prospect.url);
      if (jdText.length < 200) throw new Error('Could not read the job description from the posting page');

      const posting = await callApi('analyseJobPosting', {
        candidateId: candidate.id, jobUrl: prospect.url, jdText, ats: prospect.ats || '',
      });

      // Checked before the CV and letter are written, so a poor match costs one AI call, not three
      const score = suitabilityScore(posting.suitability);
      if (Number(MIN_SUITABILITY) && score !== null && score < Number(MIN_SUITABILITY)) {
        console.log(`[${prospect.id}] Suitability ${score} below MIN_SUITABILITY (${MIN_SUITABILITY}), skipping.`);
        await setStatus('Skipped', 'low suitability: ' + posting.suitability);
        continue;
      }

      // Build the CV and cover letter at the same time (two concurrent Apps Script executions)
      const [cv, letter] = await Promise.all([
        callApi('buildTailoredCV', { candidateId: candidate.id, jobId: posting.jobId }),
        callApi('buildCoverLetter', { candidateId: candidate.id, jobId: posting.jobId }),
      ]);
      const company = posting.company || prospect.company || '';
      const title = posting.title || prospect.title || '';

      const start = await callApi('startApplication', {
        candidateId: candidate.id, jobId: posting.jobId, company,
        jobTitle: title, jobUrl: prospect.url, ats: prospect.ats || '',
      });
      if (start.duplicate || start.targetMet || start.throttled || start.inactive) {
        const why = start.duplicate ? 'duplicate' : start.targetMet ? 'targetMet' : start.throttled ? 'throttled' : 'inactive';
        console.log(`[${prospect.id}] Not starting (${why}).`);
        await setStatus('Skipped', why);
        continue;
      }

      const outcome = await fillAndRequestReview(candidate, {
        applicationId: start.applicationId, jobId: posting.jobId, company,
        title, url: prospect.url, ats: prospect.ats || '',
        cvUrl: cv.cvUrl, letterUrl: letter.letterUrl,
      }, browser);
      await setStatus(outcome.ok ? 'In Review - Worker' : 'Error',
        outcome.ok ? 'Application ' + start.applicationId : outcome.error);
    } catch (err) {
      console.error(`[${prospect.id}] Error in fill pass:`, err.message);
      await setStatus('Error', err.message);
    }
    // Each fill takes minutes; don't make an approval wait behind the whole queue
    await submitApproved(browser);
  }
}

/** Download docs, fill the form (never submitting), request review. Returns { ok } or { ok: false, error }. */
async function fillAndRequestReview(candidate, app, browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const files = {
      cv: await downloadDocPdf(app.cvUrl, path.join(DOWNLOAD_DIR, `${app.applicationId}-cv.pdf`)),
      coverLetter: await downloadDocPdf(app.letterUrl, path.join(DOWNLOAD_DIR, `${app.applicationId}-cover-letter.pdf`)),
    };
    const candidatePayload = await callApi('getCandidatePayload', { candidateId: candidate.id });

    console.log(`[${app.applicationId}] Filling application -> ${app.url}`);
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });

    const snapshot = await unifiedFormFiller.fillForm(
      page,
      { candidateId: candidate.id, applicationId: app.applicationId, jobId: app.jobId, company: app.company, title: app.title, url: app.url },
      files,
      candidatePayload.fields,
      callApi
    );

    const { taskId } = await callApi('requestReview', {
      candidateId: candidate.id, jobId: app.jobId, applicationId: app.applicationId,
      company: app.company, jobTitle: app.title, snapshot, filledBy: 'worker',
    });
    console.log(`[${app.applicationId}] Filled, awaiting human approval (task ${taskId}).`);
    return { ok: true };
  } catch (err) {
    console.error(`[${app.applicationId}] Failed:`, err.message);
    const shotPath = path.join(DOWNLOAD_DIR, `${app.applicationId}-failure.png`);
    try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (_) {}
    await callApi('reportError', { applicationId: app.applicationId, message: `${err.message} (screenshot: ${shotPath})` })
      .catch((e) => console.error(`[${app.applicationId}] Could not report error:`, e.message));
    return { ok: false, error: err.message };
  } finally {
    await context.close();
  }
}

/**
 * Pass 2: approved applications the worker filled (the extension submits its
 * own - see dashDecide) - re-fill for real and submit. Runs at the start of
 * each cycle and again after every prospect fill, so an approval is picked up
 * within one fill.
 */
async function submitApproved(browser) {
  let approved;
  try {
    const active = new Set((await callApi('listCandidates', {})).map((c) => c.id));
    approved = (await callApi('listApplicationsByStatus', { status: 'Approved - Submitting' }))
      .filter((app) => active.has(app.candidateId));
  } catch (err) {
    console.error('Could not list approved applications:', err.message);
    return;
  }

  for (const app of approved) {
    const candidate = { id: app.candidateId };
    let context = null;
    let page = null;
    let clicked = false;
    // Once Submit may have been clicked the employer may have it: never mark it Failed (that allows a retry)
    const flagUnconfirmed = () =>
      callApi('captchaPause', { applicationId: app.id, reason: 'Submit Unconfirmed', jobUrl: app.url, company: app.company });
    try {
      const files = {
        cv: await downloadDocPdf(app.cvUrl, path.join(DOWNLOAD_DIR, `${app.id}-cv.pdf`)),
        coverLetter: await downloadDocPdf(app.letterUrl, path.join(DOWNLOAD_DIR, `${app.id}-cover-letter.pdf`)),
      };
      const candidatePayload = await callApi('getCandidatePayload', { candidateId: candidate.id });
      context = await browser.newContext();
      page = await context.newPage();

      console.log(`[${app.id}] Re-filling approved application -> ${app.url}`);
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await unifiedFormFiller.fillForm(
        page,
        { candidateId: candidate.id, applicationId: app.id, jobId: app.jobId, company: app.company, title: app.title, url: app.url },
        files,
        candidatePayload.fields,
        callApi
      );

      clicked = true;
      const confirmed = await unifiedFormFiller.clickSubmit(page);
      const shot = (await page.screenshot({ fullPage: true })).toString('base64');
      if (confirmed) {
        await callApi('confirmSubmission', { applicationId: app.id, screenshotBase64: shot });
        console.log(`[${app.id}] Submitted.`);
      } else {
        const shotPath = path.join(DOWNLOAD_DIR, `${app.id}-unconfirmed.png`);
        fs.writeFileSync(shotPath, Buffer.from(shot, 'base64'));
        await flagUnconfirmed();
        console.log(`[${app.id}] Submit clicked but no confirmation seen - flagged for a person (screenshot: ${shotPath}).`);
      }
    } catch (err) {
      console.error(`[${app.id}] Submit failed:`, err.message);
      const shotPath = path.join(DOWNLOAD_DIR, `${app.id}-submit-failure.png`);
      try { if (page) await page.screenshot({ path: shotPath, fullPage: true }); } catch (_) {}
      const recorded = clicked
        ? flagUnconfirmed()
        : callApi('reportError', { applicationId: app.id, message: `${err.message} (screenshot: ${shotPath})` });
      await recorded.catch((e) => console.error(`[${app.id}] Could not record the failure:`, e.message));
    } finally {
      if (context) await context.close();
    }
  }
}

async function pollLoop() {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: HEADED !== 'true' });
  console.log(`Jobverse worker "${WORKER_ID}" started. Polling every ${POLL_INTERVAL_MS}ms.`);

  while (true) {
    try {
      await submitApproved(browser);
      const candidates = await callApi('listCandidates', {});
      for (const candidate of candidates) {
        await fillQueuedProspects(candidate, browser);
      }
    } catch (err) {
      console.error('Poll loop error:', err.message);
    }
    await new Promise((r) => setTimeout(r, Number(POLL_INTERVAL_MS)));
  }
}

pollLoop();
