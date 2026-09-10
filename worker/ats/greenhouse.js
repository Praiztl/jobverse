/**
 * Greenhouse submission module — same as the earlier draft, unchanged.
 * Test against a couple of real Greenhouse postings and adjust selectors
 * for custom employer questions as needed.
 */

async function submit(page, application, files) {
  const iframe = page.frameLocator('iframe[src*="greenhouse.io"]').first();
  const hasIframe = await iframe.locator('body').count().catch(() => 0);
  const form = hasIframe ? iframe : page;

  await form.locator('input#first_name, input[name="job_application[first_name]"]').fill(application.FirstName || '');
  await form.locator('input#last_name, input[name="job_application[last_name]"]').fill(application.LastName || '');
  await form.locator('input#email, input[name="job_application[email]"]').fill(application.Email || '');
  if (application.Phone) {
    await form.locator('input#phone, input[name="job_application[phone]"]').fill(application.Phone).catch(() => {});
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

  await form.locator('button#submit_app, button[type="submit"]').click();
  await page.waitForSelector('text=/application.*received|thank you|successfully submitted/i', { timeout: 15000 });
}

module.exports = { submit };
