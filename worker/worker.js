/**
 * Jobverse auto-submit worker (simplified: Playwright only).
 *
 * Polls Api.gs's claimNextCleared endpoint for applications the Reviewer
 * Agent already self-checked and cleared (no unsupported_claims, confidence
 * at/above the auto-clear bar). Submits those automatically via Playwright,
 * no human action required. Anything the Reviewer Agent flagged is never
 * returned by claimNextCleared_ in the first place — this worker never
 * sees flagged items, so there's no risk of it racing a human to them.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { chromium } = require('playwright');
const greenhouse = require('./ats-greenhouse');

const {
  JOBVERSE_API_URL,
  JOBVERSE_API_TOKEN,
  WORKER_ID = 'auto-submit-worker-1',
  POLL_INTERVAL_MS = 30000,
  DOWNLOAD_DIR = './downloads',
  HEADED = 'false',
} = process.env;

if (!JOBVERSE_API_URL || !JOBVERSE_API_TOKEN) {
  console.error('Set JOBVERSE_API_URL and JOBVERSE_API_TOKEN in .env (see .env.example).');
  process.exit(1);
}

async function callApi(action, body) {
  const res = await fetch(JOBVERSE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, token: JOBVERSE_API_TOKEN, workerId: WORKER_ID, ...body }),
  });
  if (!res.ok) throw new Error(`Jobverse API ${action} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const claimNext = () => callApi('claimNextCleared', {});
const reportResult = (applicationId, status, notes) => callApi('reportSubmissionResult', { applicationId, status, notes });

async function downloadDriveFile(fileId, destPath) {
  // Same stub as before: wire this to however generated CVs/cover letters
  // are actually stored (Drive file id, signed URL, etc.) before running
  // for real. Left unimplemented on purpose.
  throw new Error(`downloadDriveFile() not implemented for fileId ${fileId} -> ${destPath}`);
}

async function handleApplication(app, browser) {
  const atsKey = String(app.ATSType || '').toLowerCase();
  if (atsKey !== 'greenhouse') {
    // Only one ATS module for now, per "keep it simple." Anything else
    // just accumulates unclaimed — extend ATS_MODULES below when ready.
    console.log(`[${app.ApplicationID}] No module for ATS "${atsKey}" yet — leaving unclaimed.`);
    return;
  }

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const files = {};
  if (app.CVFileId) {
    files.cv = path.join(DOWNLOAD_DIR, `${app.ApplicationID}-cv.pdf`);
    await downloadDriveFile(app.CVFileId, files.cv);
  }
  if (app.CoverLetterFileId) {
    files.coverLetter = path.join(DOWNLOAD_DIR, `${app.ApplicationID}-cover-letter.pdf`);
    await downloadDriveFile(app.CoverLetterFileId, files.coverLetter);
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    console.log(`[${app.ApplicationID}] Auto-submitting (Reviewer Agent cleared) -> ${app.JobURL}`);
    await page.goto(app.JobURL, { waitUntil: 'domcontentloaded' });
    await greenhouse.submit(page, app, files);
    await reportResult(app.ApplicationID, 'Submitted', `Auto-submitted by ${WORKER_ID}, Reviewer Agent cleared`);
    console.log(`[${app.ApplicationID}] Submitted.`);
  } catch (err) {
    console.error(`[${app.ApplicationID}] Failed:`, err.message);
    const shot = path.join(DOWNLOAD_DIR, `${app.ApplicationID}-failure.png`);
    try { await page.screenshot({ path: shot, fullPage: true }); } catch (_) {}
    await reportResult(app.ApplicationID, 'Failed', `${err.message} (screenshot: ${shot})`);
  } finally {
    await context.close();
  }
}

async function pollLoop() {
  const browser = await chromium.launch({ headless: HEADED !== 'true' });
  console.log(`Auto-submit worker "${WORKER_ID}" started. Polling every ${POLL_INTERVAL_MS}ms.`);
  while (true) {
    try {
      const app = await claimNext();
      if (app && app.ApplicationID) {
        await handleApplication(app, browser);
        continue;
      }
    } catch (err) {
      console.error('Poll loop error:', err.message);
    }
    await new Promise((r) => setTimeout(r, Number(POLL_INTERVAL_MS)));
  }
}

pollLoop();
