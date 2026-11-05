# Jobverse

Job-application automation: candidates get matched to prospects, a
Resume/Cover Letter Builder generates documents, a Reviewer Agent
self-checks them, and — always, today, with no exceptions — a human
approves the actual submission before anything reaches a real employer.

## Repo layout

- `appscript/` — the live Apps Script project, pulled via `clasp clone`.
  Real files: `AI.js`, `Agents.js`, `Api.js`, `FormBuilder.js`, `Intake.js`,
  `Reports.js`, `Setup.js`, `Dashboard.html`, `Followup.js`, `Prospects.js`,
  plus `Sync.js` and `Analytics.js`, added here.
- `worker/` — **retired, not run any more.** The Chrome extension's
  "Auto-run the queue" now fills queued jobs and submits every approved
  application. Kept for reference. It was the Playwright worker: it polled the real `Api.js` endpoints,
  fills real ATS application forms, and requests human review before ever
  clicking a real Submit button. `worker/unified-form-filler.js` fills every
  ATS generically. `worker/ats/*.js` are the older per-ATS modules and are
  **not loaded** by `worker.js` any more - kept only for reference.
- `appscript-patches/` — reviewed changes, in the order they were designed.
  `DEPRECATED-02` should never be applied — built on a wrong model of the
  system. `03` and `04` are standalone files, already live in `appscript/`.
  `05` is written but intentionally not applied — see status table.
- `db/schema.sql`, `db/sync/*.js` — an earlier design for a Postgres sync
  layer, built before the real `Api.js`/`Agents.js` were read. **Known
  stale** — don't provision a DB against this yet.
- `docs/` — supporting docs. `help-guide-review-queue-addition.md` is now
  applied directly in `Dashboard.html` and kept only as a historical draft.

## Status

| Piece | State |
|---|---|
| Prospects.gs multi-location fix | Live, verified |
| Adzuna geo-block ATS resolver + Remotive source | Live (pre-existing) |
| `Sync.js` (`onReviewQueueEdit`) | Deployed — confirm the installable trigger is set (Triggers → Add Trigger → `onReviewQueueEdit` → From spreadsheet → On edit) if not done already |
| `Analytics.js` (`reviewerAccuracyReport`) | Deployed and run once — `ReviewQueue` had zero Decided rows at last check, so there's nothing to measure yet |
| Config-gated auto-decide (patch 05) | Still not applied — needs real Decided rows in `ReviewQueue` first |
| `PlatformAccounts` tab + site sign-in/sign-up handling | Live in the **Chrome extension** (per-site random passwords in Script Properties). The worker has no sign-in/sign-up handling - jobs behind an account wall end as `Error` there; run them through the extension. |
| Account emails + password reset (`findAccountEmail`) | **Written, not yet deployed or tested on a live site.** On a "verify your email" page the extension asks the backend for the site's email (Gmail advanced service, read-only, `gmail.readonly` scope) and enters the code or opens the link. "Email already registered" on sign-up, or a rejected saved password, runs Forgot password -> reset email -> sets the saved password -> signs in. After any account step the tab goes back to the job page once, since many sites land on a dashboard. Needs each candidate's application inbox to forward to the Jobverse Gmail; Config `ACCOUNT_EMAIL_LOOKUP` = `off` disables it. Email parsing tested against sample emails only. |
| Chrome extension auto-run | **Live** — replaces the worker. With "Auto-run the queue" ticked in the popup, the extension claims the next queued prospect (`nextQueuedProspect`, `Queued` -> `In Progress - Extension` under the script lock, stale claims re-queued after 45 min) every 3 minutes and fills it. Every approval becomes `Approved - Extension`; leftover `Approved - Submitting` rows are submitted by the extension too. |
| `worker/worker.js` | **Retired.** Fills a form and requests review, then re-fills and submits for real only after a human approves. Reads the job ad itself before analysing it. Every prospect leaves `Queued` (`In Review - Worker`, `Skipped` or `Error`), so failures are never retried in a loop - re-queue from the dashboard. Only submits applications it filled itself (`FilledBy = worker`). |
| `worker/unified-form-filler.js` | Generic filler for any ATS: picks the frame holding the form, fills text/select/radio/checkbox fields via `answerField`, uploads CV/cover letter, follows Next. `fillForm` never clicks Submit/Apply on a form - only `clickSubmit` does, after approval, and it reports whether a confirmation appeared. |
| `worker/ats/greenhouse.js`, `worker/ats/workday.js` | Not loaded by the worker any more (superseded by the unified filler) |
| NHS Jobs | Handled by the extension's generic driver like any other site. `chrome-extension/content/nhs-flow.js` (NHS supporting statement + Trac follow-up) is **not** in the extension manifest and never runs - wiring it in is still to do. |
| `Api.js`: `exportDocumentPdf`, `listApplicationsByStatus` | Added so the worker can download real CV/cover-letter PDFs and find human-approved applications to submit |
| `Api.js`: `apiListProspects_` returning `ats` | Fixed — previously always returned `undefined`, so the worker could never match a prospect to an ATS module regardless of what it actually was |
| Google Forms | Extension fills them: `autofill.js` answers the ARIA multiple choice / checkbox / scale / grid / dropdown questions itself (`fillGoogleFormChoices`), text boxes are labelled from `aria-labelledby`, and `navigator.js` always treats a Google Form as the application form (previously it could be taken for an "email first" sign-in step and its Submit pressed). File-upload questions need the candidate's Google sign-in, so they are flagged for a person. Tested against a mock of the Google Forms DOM, not yet a live form. |
| Approving from Applications (`Dashboard.html`) | Filled forms show under Applications → **Ready to approve** with View CV / View cover letter (inline preview), **What was filled in**, and **Approve & submit**, which approves the job's waiting documents and final application together; the waiting Chrome tab then clicks Submit. This is the only place job applications are approved: the old Review queue is now **More → Documents to check** and holds only documents not tied to an application being applied to (matched by `jobId`, which `dashData` now returns for applications and reviews). |
| Screenshot check (`apiVisualCheck_` + extension) | Before a filled form goes to review, and again right before Submit, the extension screenshots the form (up to 8 screens, JPEG, ~1100px wide) and the AI lists anything unanswered, showing an error, or wrong for the candidate. Review: issues go to the reviewer in red. Submit: it holds with a list in the tab ("check again" / "submit anyway"), status `Check Before Submit - Human Needed`. Taking a screenshot brings the tab to the front for a moment. If the check fails to run, it never blocks. Turn off with Config `VISUAL_CHECK` = `off`. Tested with a stubbed AI only. |
| Simplified console (`Dashboard.html`) | Five main nav items (Overview, Applications, Find jobs, Candidates, Follow-ups), the rest under **More**. An "Auto-applying is on/off" line tops every page. Overview has a first-run checklist (hideable, per browser), the 4-step flow, and a to-do list led by approvals. Job statuses use plain words ("In line to apply" for `Queued`); the sheet values are unchanged. |
| Shared dashboard data (`Cache.js`) | **Written, tested against a mocked Apps Script only.** `dashData` serves one gzipped snapshot from CacheService to everyone, for up to 20 s; `logActivity_` marks it stale on every action, and a person's own action reads the sheet. The page polls every 30 s only while visible and gets `{ unchanged: true }` when nothing moved. Config is shared for 60 s, so a hand edit in the Config tab can take that long. `jobverseHealth()` in the editor prints row counts and build time. |
| One submission across Chromes (`apiClaimSubmission_`) | **Written, tested with `background.js` against a mock backend, not on a live site.** Every Chrome sees an approved application, so each must win this claim before filling or pressing Submit. A claim never passes to another Chrome by itself; a stuck one goes to a person (Retry / Mark submitted). |
| Update CV / cover letter (`dashReviseDocument`) | **Written, not yet tried live.** On Ready to approve and Sent back: a new version from a person's notes and keywords, built on the document's current text, then the Reviewer Agent. Newest version always wins. A tab waiting with the old file is told at approval (`docsChanged`, which also catches edits made in Google Docs), closes, and the form is filled again. |
| Sent back (`Dashboard.html`) | **Written, not yet tried live.** Don't submit moves an application to Applications > Sent back with its reason; Update, then Run again (fresh fill, back to Ready to approve) or Drop (`Dropped` status). |
| Follow-ups on submission | **Written, tested against a mocked Apps Script only.** The page opens on All open, so an application shows from the moment it is submitted; `DueDate` stays the chase date. `buildDashData_` adds any follow-up a Submitted row lacks, so hand-marked rows no longer wait for the morning backfill. |
| Rewrites and the script lock (`Revisions.js`) | Rows are claimed one at a time under a brief lock and the AI work runs outside it. It used to hold the lock every Chrome needs to claim a job for minutes at a time. |
| Help & guide (`Dashboard.html`) | Updated — documents the extension's auto-run as the hands-off path, document updates, Sent back and working as a team |
| Postgres schema / `db/sync/*.js` | Still stale/unused — needs a full rework against the real tables (`Jobs`, `CVVersions`, `CoverLetters`, `NHSStatements`, `AIOutputs`, `FollowUps`) |
| `worker/.env.example` deployment URL leak | A real `/exec` URL was briefly committed, then removed (`fix-env-example.sh`). If the Apps Script deployment behind it hasn't been rotated (new deployment, old one archived) yet, do that — the URL is still visible in git history. |

## Next manual steps (need your Google login — can't be scripted)

1. `clasp push`, then redeploy the existing web app deployment (Deploy →
   Manage deployments → pencil icon → Version: New version → Deploy) — a
   plain `clasp push` alone does **not** update what's live at your `/exec`
   URL, it only updates the editor's source.
   This push adds the `gmail.readonly` scope and the Gmail advanced service:
   run any function once in the editor (e.g. `setupJobverse()`, which also
   adds the new `ACCOUNT_EMAIL_LOOKUP` Config row) and accept the new
   permission before redeploying. Then, in each candidate's application
   inbox, forward mail to the Gmail account that owns the script (Settings ->
   Forwarding and POP/IMAP), and reload the unpacked extension in Chrome.
   Deploy the backend first, then reload the extension (version 1.1.0) in
   **every** Chrome: the new extension needs `claimSubmission`, and an old
   extension still running alongside it skips the claim. Run `setupJobverse()`
   once to add the new `Applications` columns and the `LOG_AI_STEPS` Config row.
   For VAs to see documents, share the Drive folder `Jobverse Platform` with
   their Google accounts: generated Docs are private to the deploying account.
2. Confirm the `onReviewQueueEdit` installable trigger is registered
   (Triggers → Add Trigger → From spreadsheet → On edit), if not already.
3. Run `reviewerAccuracyReport()` once real `Decided` rows exist, and look
   at the numbers before deciding whether/when to apply patch 05.
4. If you haven't already: rotate the Apps Script deployment that was
   briefly exposed via `worker/.env.example`. "Who has access" has to stay
   "Anyone, even anonymous" (the extension and worker POST without a Google
   login), so the console is protected by `DASHBOARD_KEY` instead: run
   `setupJobverse()` once to generate it, then open the console as
   `<web app URL>?key=<DASHBOARD_KEY>`. Also rotate `API_TOKEN` (and update
   the extension and worker `.env`), since the old dashboard could read it.
