# Jobverse

Job-application automation: candidates get matched to prospects, a
Resume/Cover Letter Builder generates documents, a Reviewer Agent
self-checks them, and — always, today, with no exceptions — a human
approves the actual submission before anything reaches a real employer.

## Repo layout

- `appscript/` — the live Apps Script project, pulled via `clasp clone`.
  Real files: `AI.js`, `Agents.js`, `Api.js`, `FormBuilder.js`, `Intake.js`,
  `Reports.js`, `Setup.js`, `Dashboard.html`, `Followup.js`, `Prospects.js`,
  plus the new `Sync.js` and `Analytics.js` added here.
- `appscript-patches/` — reviewed changes, in the order they were designed.
  `DEPRECATED-02` should never be applied — built on a wrong model of the
  system. `03` and `04` are new standalone files (already added to
  `appscript/` by this script). `05` is written but intentionally not
  applied — see status table.
- `db/schema.sql`, `db/sync/*.js`, `worker/*.js` — an earlier design for a
  Postgres sync layer and Playwright submission worker, built before the
  real `Api.js`/`Agents.js` were read. **Known stale** — don't provision a
  DB or run the worker against these yet.
- `docs/` — supporting docs, including the corrected Help & guide addition.

## Status

| Piece | State |
|---|---|
| Prospects.gs multi-location fix | Live, verified |
| Config (`ADZUNA_COUNTRY`) | Fixed in the live Sheet |
| Adzuna geo-block ATS resolver + Remotive source | Already live (found already in place when Prospects.js was read — built independently of this repo's work) |
| `Sync.js` (onReviewQueueEdit) | Added to `appscript/`, not yet deployed live or enabled as a trigger |
| `Analytics.js` (reviewerAccuracyReport) | Added to `appscript/`, not yet deployed live or run |
| Config-gated auto-decide (patch 05) | Written, intentionally not applied — wait for real accuracy numbers first |
| `DEPRECATED-02` claim/report endpoints | Do not apply — real `Api.js` already covers this via `apiPrecheckApplication_`/`apiStartApplication_`/`apiAnalyseJob_`/`apiRequestReview_`/`apiCheckApproval_`/`apiConfirmSubmission_` |
| Postgres schema / sync scripts / worker | Stale, built on wrong assumptions about the schema — needs a full rework against the real tables (`Jobs`, `CVVersions`, `CoverLetters`, `NHSStatements`, `AIOutputs`, `FollowUps` weren't accounted for) |
| Submission-type independent review | Doesn't exist yet — `apiRequestReview_` stores a raw snapshot with no AI verdict, so there's nothing to threshold on for auto-decide there. Future milestone, not started. |

## Next manual steps (need your Google login — can't be scripted)

1. Open the Apps Script editor (or run `clasp push` from this repo) to
   actually deploy `Sync.js` and `Analytics.js` to the live project.
2. Triggers (clock icon) -> Add Trigger -> `onReviewQueueEdit` -> From
   spreadsheet -> On edit -> Save. Must be an installable trigger, not a
   bare `onEdit(e)`.
3. Run `reviewerAccuracyReport()` once manually and look at the real
   numbers before deciding whether/when to apply patch 05.
