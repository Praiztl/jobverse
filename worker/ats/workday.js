/**
 * Workday module: handles the sign-in/sign-up wall Workday tenants put in
 * front of the actual application form, reusing the candidate's existing
 * ApplicationEmail/ApplicationPassword (from the intake form, exposed by
 * getCandidatePayload) rather than generating new credentials - every
 * candidate is assumed not to already have a Workday account for a given
 * employer's tenant unless PlatformAccounts says otherwise.
 *
 * Fills the same fillForm/clickSubmit interface as ats/greenhouse.js so
 * worker.js can treat every ATS module the same way. Actual Workday
 * application-form filling (after the account step) is NOT implemented yet -
 * Workday's form structure varies a lot by tenant and needs verification
 * against real postings before it's safe to guess at selectors, same
 * caution already applied to the Greenhouse module.
 */

async function hasAuthWall_(page) {
  return page.locator('text=/sign in|log in|create account|create an account/i').first().count().catch(() => 0);
}

async function signIn_(page, candidate) {
  await page.getByLabel(/email/i).first().fill(candidate.applicationEmail || '');
  await page.getByLabel(/password/i).first().fill(candidate.applicationPassword || '');
  await page.getByRole('button', { name: /sign in|log in/i }).first().click();
}

async function signUp_(page, candidate) {
  await page.getByRole('link', { name: /create account/i }).first().click().catch(() => {});
  await page.getByLabel(/email/i).first().fill(candidate.applicationEmail || '');
  await page.getByLabel(/^password/i).first().fill(candidate.applicationPassword || '');
  const confirmField = page.getByLabel(/confirm password/i).first();
  if (await confirmField.count()) await confirmField.fill(candidate.applicationPassword || '');
  await page.getByRole('checkbox', { name: /agree|terms/i }).first().check().catch(() => {});
  await page.getByRole('button', { name: /create account|sign up|submit/i }).first().click();

  const captcha = await page.locator('iframe[src*="captcha"], text=/verify you are human/i').first().count().catch(() => 0);
  if (captcha) return { blocked: true, blockedReason: 'Blocked-CAPTCHA', notes: 'CAPTCHA on account creation' };

  const emailVerify = await page.locator('text=/verify your email|check your email|confirmation email/i').first().count().catch(() => 0);
  if (emailVerify) {
    return {
      blocked: true, blockedReason: 'Blocked-EmailVerification',
      notes: 'Requires clicking a verification link sent to ' + (candidate.applicationEmail || '(no application email on file)'),
    };
  }

  return { blocked: false };
}

/**
 * Resolves any sign-in/signup wall, recording the outcome in PlatformAccounts
 * either way, and pausing for a human via captchaPause if account creation
 * hits something genuinely unautomatable (CAPTCHA / mandatory email
 * verification link). Throws past that point - the actual form fill isn't
 * built yet.
 */
async function fillForm(page, application, files, candidate, api) {
  if (!candidate.applicationEmail || !candidate.applicationPassword) {
    throw new Error('Candidate has no ApplicationEmail/ApplicationPassword on file - can\'t sign in or sign up on this Workday tenant.');
  }

  if (await hasAuthWall_(page)) {
    const domain = new URL(page.url()).hostname;
    const existing = await api('checkPlatformAccount', { candidateId: application.candidateId, atsDomain: domain });

    if (existing.found && existing.status === 'Created') {
      await signIn_(page, candidate);
    } else if (existing.found && String(existing.status).indexOf('Blocked') === 0) {
      throw new Error(`Known blocked platform account (${existing.status}) for ${domain} - needs human resolution, not retrying automatically.`);
    } else {
      const result = await signUp_(page, candidate);
      if (result.blocked) {
        await api('recordPlatformAccount', { candidateId: application.candidateId, atsDomain: domain, status: result.blockedReason, notes: result.notes });
        await api('captchaPause', {
          applicationId: application.applicationId,
          reason: result.blockedReason === 'Blocked-EmailVerification' ? 'EmailVerification' : 'CAPTCHA',
          jobUrl: page.url(), company: application.company,
        });
        throw new Error(`Account creation blocked for ${domain}: ${result.blockedReason}`);
      }
      await api('recordPlatformAccount', { candidateId: application.candidateId, atsDomain: domain, status: 'Created', notes: 'Auto-created during application' });
    }
  }

  throw new Error('Workday form filling not yet implemented past the sign-in/signup step - needs verification against a real Workday posting.');
}

async function clickSubmit() {
  throw new Error('Workday clickSubmit not implemented - form filling is not implemented yet either.');
}

module.exports = { fillForm, clickSubmit };
