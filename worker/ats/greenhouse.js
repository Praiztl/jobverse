/**
 * Greenhouse module, rewritten against the real candidate payload shape
 * (fullName, not separate first/last) and the fillForm/clickSubmit split so
 * the real Submit click always waits for requestReview/dashDecide - this
 * module used to click Submit itself with no human gate at all, which
 * doesn't match how every other part of Jobverse treats a real submission.
 *
 * Test against a couple of real Greenhouse postings and adjust selectors
 * for custom employer questions as needed.
 */

function splitName_(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

async function formLocator_(page) {
  const iframe = page.frameLocator('iframe[src*="greenhouse.io"]').first();
  const hasIframe = await iframe.locator('body').count().catch(() => 0);
  return hasIframe ? iframe : page;
}

/** Fills the form and returns a snapshot for human review. Never submits. */
async function fillForm(page, application, files, candidate) {
  const form = await formLocator_(page);
  const { first, last } = splitName_(candidate.fullName);

  await form.locator('input#first_name, input[name="job_application[first_name]"]').fill(first);
  await form.locator('input#last_name, input[name="job_application[last_name]"]').fill(last);
  await form.locator('input#email, input[name="job_application[email]"]').fill(candidate.email || '');
  if (candidate.phone) {
    await form.locator('input#phone, input[name="job_application[phone]"]').fill(candidate.phone).catch(() => {});
  }

  if (files.cv) {
    await form.locator('input[type="file"]#resume, input[name="job_application[resume]"]').setInputFiles(files.cv);
  }
  if (files.coverLetter) {
    const clInput = form.locator('input[type="file"]#cover_letter, input[name="job_application[cover_letter]"]');
    if (await clInput.count()) await clInput.setInputFiles(files.coverLetter);
  }

  const unhandledRequired = await form.locator('[required]').evaluateAll((els) =>
    els.filter((el) => el.tagName === 'INPUT' && el.type === 'text' && !el.value)
       .map((el) => el.name || el.id || el.outerHTML.slice(0, 80))
  );
  if (unhandledRequired.length) {
    throw new Error(`Unhandled required field(s): ${unhandledRequired.join(', ')}`);
  }

  return {
    ats: 'greenhouse', firstName: first, lastName: last, email: candidate.email || '',
    phone: candidate.phone || '', cvAttached: !!files.cv, coverLetterAttached: !!files.coverLetter,
  };
}

/** Only called after a human has approved the snapshot from fillForm. */
async function clickSubmit(page) {
  const form = await formLocator_(page);
  await form.locator('button#submit_app, button[type="submit"]').click();
  await page.waitForSelector('text=/application.*received|thank you|successfully submitted/i', { timeout: 15000 });
}

module.exports = { fillForm, clickSubmit };
