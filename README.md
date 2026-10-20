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
- `worker/` — the Playwright worker. Polls the real `Api.js` endpoints,
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
| `worker/worker.js` | Fills a form and requests review, then re-fills and submits for real only after a human approves. Reads the job ad itself before analysing it. Every prospect leaves `Queued` (`In Review - Worker`, `Skipped` or `Error`), so failures are never retried in a loop - re-queue from the dashboard. Only submits applications it filled itself (`FilledBy = worker`). |
| `worker/unified-form-filler.js` | Generic filler for any ATS: picks the frame holding the form, fills text/select/radio/checkbox fields via `answerField`, uploads CV/cover letter, follows Next. `fillForm` never clicks Submit/Apply on a form - only `clickSubmit` does, after approval, and it reports whether a confirmation appeared. |
| `worker/ats/greenhouse.js`, `worker/ats/workday.js` | Not loaded by the worker any more (superseded by the unified filler) |
| NHS Jobs | Handled by the extension's generic driver like any other site. `chrome-extension/content/nhs-flow.js` (NHS supporting statement + Trac follow-up) is **not** in the extension manifest and never runs - wiring it in is still to do. |
| `Api.js`: `exportDocumentPdf`, `listApplicationsByStatus` | Added so the worker can download real CV/cover-letter PDFs and find human-approved applications to submit |
| `Api.js`: `apiListProspects_` returning `ats` | Fixed — previously always returned `undefined`, so the worker could never match a prospect to an ATS module regardless of what it actually was |
| Help & guide (`Dashboard.html`) | Updated — documents the worker as the default hands-off path, extension as the fallback for one-off jobs or unsupported ATSes |
| Postgres schema / `db/sync/*.js` | Still stale/unused — needs a full rework against the real tables (`Jobs`, `CVVersions`, `CoverLetters`, `NHSStatements`, `AIOutputs`, `FollowUps`) |
| `worker/.env.example` deployment URL leak | A real `/exec` URL was briefly committed, then removed (`fix-env-example.sh`). If the Apps Script deployment behind it hasn't been rotated (new deployment, old one archived) yet, do that — the URL is still visible in git history. |

## Next manual steps (need your Google login — can't be scripted)

1. `clasp push`, then redeploy the existing web app deployment (Deploy →
   Manage deployments → pencil icon → Version: New version → Deploy) — a
   plain `clasp push` alone does **not** update what's live at your `/exec`
   URL, it only updates the editor's source.
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
