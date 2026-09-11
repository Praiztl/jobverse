/**
 * Workday submission module - handles the sign-in/sign-up wall Workday
 * tenants commonly put in front of the actual application form.
 *
 * Flow: detect a wall -> check PlatformAccounts (via the API) for an
 * existing account on THIS tenant for THIS candidate -> sign in if one
 * exists, sign up if not, using the candidate's existing
 * ApplicationEmail/ApplicationPassword (never generates new credentials) ->
 * record the outcome. If signup hits a CAPTCHA or requires email
 * verification, that's a real wall nothing here can push through - it
 * records the specific block and pauses via the same human-notify path
 * apiCaptchaPause_ already uses for CAPTCHAs, then throws so the worker
 * doesn't attempt the rest of the application this run.
 *
 * NOTE: Workday's actual form structure varies meaningfully between
 * tenant versions. The selectors below (role/label based, not raw CSS)
 * are a reasonable starting point but should be checked against a couple
 * of real Workday postings and adjusted - same caveat as the Greenhouse
 * module.
 */

async function submit(page, application, files, candidate, api) {
  var wall = await page.locator('text=/sign in|log in|create account|create an account/i').first().count().catch(function () { return 0; });

  if (wall) {
    var domain = new URL(page.url()).hostname;
    var existing = await api('checkPlatformAccount', { candidateId: candidate.CandidateID, atsDomain: domain });

    if (existing.found && existing.status === 'Created') {
      await signIn_(page, candidate);
    } else if (existing.found && String(existing.status).indexOf('Blocked') === 0) {
      throw new Error('Known blocked platform account (' + existing.status + ') for ' + domain + ' - needs human resolution, not retrying automatically.');
    } else {
      var result = await signUp_(page, candidate);
      if (result.blocked) {
        await api('recordPlatformAccount', { candidateId: candidate.CandidateID, atsDomain: domain, status: result.blockedReason, notes: result.notes });
        await api('captchaPause', {
          applicationId: application.ApplicationID,
          reason: result.blockedReason === 'Blocked-EmailVerification' ? 'EmailVerification' : 'CAPTCHA',
          jobUrl: page.url(), company: application.Company
        });
        throw new Error('Account creation blocked for ' + domain + ': ' + result.blockedReason);
      }
      await api('recordPlatformAccount', { candidateId: candidate.CandidateID, atsDomain: domain, status: 'Created', notes: 'Auto-created during application' });
    }
  }

  // Actual Workday application-form filling (name/CV upload/screening
  // questions/submit) still needs to be built once the sign-in/sign-up
  // step above has been checked against real postings - deliberately not
  // guessed at here, since Workday's form structure varies a lot more
  // than Greenhouse's between tenants.
  throw new Error('Workday sign-in/signup handled - application form filling not yet implemented.');
}

async function signIn_(page, candidate) {
  await page.getByLabel(/email/i).first().fill(candidate.ApplicationEmail);
  await page.getByLabel(/password/i).first().fill(candidate.ApplicationPassword);
  await page.getByRole('button', { name: /sign in|log in/i }).first().click();
}

async function signUp_(page, candidate) {
  await page.getByRole('link', { name: /create account/i }).first().click().catch(function () {});
  await page.getByLabel(/email/i).first().fill(candidate.ApplicationEmail);
  await page.getByLabel(/^password/i).first().fill(candidate.ApplicationPassword);
  var confirmField = page.getByLabel(/confirm password/i).first();
  if (await confirmField.count()) await confirmField.fill(candidate.ApplicationPassword);
  await page.getByRole('checkbox', { name: /agree|terms/i }).first().check().catch(function () {});
  await page.getByRole('button', { name: /create account|sign up|submit/i }).first().click();

  var captcha = await page.locator('iframe[src*="captcha"], text=/verify you are human/i').first().count().catch(function () { return 0; });
  if (captcha) return { blocked: true, blockedReason: 'Blocked-CAPTCHA', notes: 'CAPTCHA on account creation' };

  var emailVerify = await page.locator('text=/verify your email|check your email|confirmation email/i').first().count().catch(function () { return 0; });
  if (emailVerify) return { blocked: true, blockedReason: 'Blocked-EmailVerification', notes: 'Requires clicking a verification link sent to ' + candidate.ApplicationEmail };

  return { blocked: false };
}

module.exports = { submit };
