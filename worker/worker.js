/**
 * Jobverse application worker (Playwright), wired to the real Api.gs
 * endpoints (not the earlier invented claim/report model).
 *
 * Two passes each cycle, deliberately non-blocking:
 *
 *  1. FILL: for each active candidate's Queued prospects - precheck, analyse
 *     (generates CV/cover letter via the AI agents), start the application,
 *     download the generated documents as real PDFs, fill the ATS form via
 *     an ats/*.js module, then request human review of a snapshot of what
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

const ats = {
  greenhouse: require('./ats/greenhouse'),
  workday: require('./ats/workday'),
};

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

function moduleFor(atsName) {
  return ats[String(atsName || '').toLowerCase().trim()];
}

/** Pass 1: discover queued prospects, generate + fill, hand off to review. */
async function fillQueuedProspects(candidate, browser) {
  const prospects = await callApi('listProspects', { candidateId: candidate.id, status: 'Queued' });

  for (const prospect of prospects) {
    try {
      const pre = await callApi('precheckApplication', {
        candidateId: candidate.id, jobUrl: prospect.url, company: prospect.company, jobTitle: prospect.title,
      });
      if (pre.block) {
        console.log(`[${prospect.id}] Skipping (${pre.block}).`);
        await callApi('updateProspectStatus', { prospectId: prospect.id, status: 'Skipped', notes: 'precheck: ' + pre.block });
        continue;
      }

      const analysis = await callApi('analyseJob', {
        candidateId: candidate.id, jobUrl: prospect.url, jdText: prospect.jdText || '', ats: prospect.ats || '',
      });

      if (Number(MIN_SUITABILITY) && Number(analysis.suitability || 0) < Number(MIN_SUITABILITY)) {
        console.log(`[${prospect.id}] Suitability ${analysis.suitability} below MIN_SUITABILITY (${MIN_SUITABILITY}), skipping.`);
        await callApi('updateProspectStatus', { prospectId: prospect.id, status: 'Skipped', notes: 'low suitability: ' + analysis.suitability });
        continue;
      }

      const start = await callApi('startApplication', {
        candidateId: candidate.id, jobId: analysis.jobId, company: analysis.company,
        jobTitle: analysis.title, jobUrl: prospect.url, ats: prospect.ats || '',
      });
      if (start.duplicate || start.targetMet || start.throttled || start.inactive) {
        const why = start.duplicate ? 'duplicate' : start.targetMet ? 'targetMet' : start.throttled ? 'throttled' : 'inactive';
        console.log(`[${prospect.id}] Not starting (${why}).`);
        await callApi('updateProspectStatus', { prospectId: prospect.id, status: 'Skipped', notes: why });
        continue;
      }

      await fillAndRequestReview(candidate, {
        applicationId: start.applicationId, jobId: analysis.jobId, company: analysis.company,
        title: analysis.title, url: prospect.url, ats: prospect.ats || '',
        cvUrl: analysis.cvUrl, letterUrl: analysis.letterUrl,
      }, browser);
    } catch (err) {
      console.error(`[${prospect.id}] Unhandled error in fill pass:`, err.message);
    }
  }
}

/** Shared by both passes: download docs, run the ATS module's fillForm. */
async function fillAndRequestReview(candidate, app, browser) {
  const files = {};
  files.cv = await downloadDocPdf(app.cvUrl, path.join(DOWNLOAD_DIR, `${app.applicationId}-cv.pdf`));
  files.coverLetter = await downloadDocPdf(app.letterUrl, path.join(DOWNLOAD_DIR, `${app.applicationId}-cover-letter.pdf`));

  const module = moduleFor(app.ats);
  if (!module) {
    console.log(`[${app.applicationId}] No automation module for ATS "${app.ats}" yet - leaving for manual handling.`);
    await callApi('reportError', { applicationId: app.applicationId, message: `No automation module for ATS "${app.ats}"` });
    return;
  }

  const candidatePayload = await callApi('getCandidatePayload', { candidateId: candidate.id });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    console.log(`[${app.applicationId}] Filling application -> ${app.url}`);
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });

    const snapshot = await module.fillForm(
      page,
      { candidateId: candidate.id, applicationId: app.applicationId, jobId: app.jobId, company: app.company, title: app.title, url: app.url },
      files,
      candidatePayload.fields,
      callApi
    );

    const { taskId } = await callApi('requestReview', {
      candidateId: candidate.id, jobId: app.jobId, applicationId: app.applicationId,
      company: app.company, jobTitle: app.title, snapshot,
    });
    console.log(`[${app.applicationId}] Filled, awaiting human approval (task ${taskId}).`);
  } catch (err) {
    console.error(`[${app.applicationId}] Failed:`, err.message);
    const shotPath = path.join(DOWNLOAD_DIR, `${app.applicationId}-failure.png`);
    try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (_) {}
    await callApi('reportError', { applicationId: app.applicationId, message: `${err.message} (screenshot: ${shotPath})` });
  } finally {
    await context.close();
  }
}

/** Pass 2: applications a human has already approved - re-fill for real and submit. */
async function submitApproved(candidate, browser) {
  const approved = await callApi('listApplicationsByStatus', {
    candidateId: candidate.id, status: 'Approved - Submitting',
  });

  for (const app of approved) {
    const module = moduleFor(app.ats);
    if (!module) {
      console.log(`[${app.id}] No automation module for ATS "${app.ats}" - can't complete the real submit.`);
      await callApi('reportError', { applicationId: app.id, message: `No automation module for ATS "${app.ats}" at submit time` });
      continue;
    }

    const files = {};
    const candidatePayload = await callApi('getCandidatePayload', { candidateId: candidate.id });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      files.cv = await downloadDocPdf(app.cvUrl, path.join(DOWNLOAD_DIR, `${app.id}-cv.pdf`));
      files.coverLetter = await downloadDocPdf(app.letterUrl, path.join(DOWNLOAD_DIR, `${app.id}-cover-letter.pdf`));

      console.log(`[${app.id}] Re-filling approved application -> ${app.url}`);
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await module.fillForm(
        page,
        { candidateId: candidate.id, applicationId: app.id, jobId: app.jobId, company: app.company, title: app.title, url: app.url },
        files,
        candidatePayload.fields,
        callApi
      );

      await module.clickSubmit(page);
      const shot = (await page.screenshot({ fullPage: true })).toString('base64');
      await callApi('confirmSubmission', { applicationId: app.id, screenshotBase64: shot });
      console.log(`[${app.id}] Submitted.`);
    } catch (err) {
      console.error(`[${app.id}] Submit failed:`, err.message);
      const shotPath = path.join(DOWNLOAD_DIR, `${app.id}-submit-failure.png`);
      try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (_) {}
      await callApi('reportError', { applicationId: app.id, message: `${err.message} (screenshot: ${shotPath})` });
    } finally {
      await context.close();
    }
  }
}

async function pollLoop() {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: HEADED !== 'true' });
  console.log(`Jobverse worker "${WORKER_ID}" started. Polling every ${POLL_INTERVAL_MS}ms.`);

  while (true) {
    try {
      const candidates = await callApi('listCandidates', {});
      for (const candidate of candidates) {
        await fillQueuedProspects(candidate, browser);
        await submitApproved(candidate, browser);
      }
    } catch (err) {
      console.error('Poll loop error:', err.message);
    }
    await new Promise((r) => setTimeout(r, Number(POLL_INTERVAL_MS)));
  }
}

pollLoop();
