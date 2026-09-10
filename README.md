# Jobverse

Job-application automation: candidates get matched to prospects, a
Resume/Cover Letter Builder generates documents, a Reviewer Agent
self-checks them, and cleared applications submit automatically via
Playwright. Flagged applications (unsupported claims, low confidence)
wait in the Review Queue for a human look.

## Repo layout

- `appscript/` — the live Apps Script project (Prospects.gs, Api.gs,
  Followup.gs, Reports.gs, Dashboard.html, etc). **Not populated yet** —
  see `appscript/README.md` for the one-time `clasp clone` step needed to
  fill this in from the real project. This step needs to run from a real
  browser under the Google account that owns the Apps Script project, so
  it isn't something that can be scripted from a cloud sandbox.
- `appscript-patches/` — reviewed, not-yet-applied (or already-applied)
  changes to the live Apps Script project, in the order they were
  designed. Once `appscript/` is populated, each of these becomes a normal
  PR against real files instead of a manual copy-paste into the Apps
  Script editor.
- `db/schema.sql` — Postgres schema for the four DB-synced tables
  (`prospects`, `applications`, `review_queue`, `activity_log`).
- `worker/` — the Playwright auto-submission worker. Currently talks to
  `Api.gs`'s web app endpoints; once the DB layer exists, its `callApi`
  functions get swapped for direct Postgres queries (see `db/schema.sql`'s
  claim-query comment).
- `docs/` — supporting docs, including a Help & guide addition for the
  in-app FAQ.

## Status

| Piece | State |
|---|---|
| Prospects.gs multi-location fix | Written, applied to the live project, verified |
| Config (`ADZUNA_COUNTRY`) | Fixed in the live Sheet |
| `claimNextCleared_` / `reportSubmissionResult_` (Api.gs) | Drafted, not yet pasted into the live project |
| `onReviewQueueEdit` (instant sync trigger) | Drafted, not yet pasted or enabled |
| Postgres schema | Drafted, no DB provisioned yet |
| `sheet-to-db.js` / `db-to-sheet.js` sync scripts | Not started — next up once a DB exists |
| Worker repointed at Postgres | Not started — worker currently targets `Api.gs` |
| Followup.gs submission-trigger gap | Identified, fix not yet written |

## What's still manual, and why

Three things in this project need a human's own credentials and can't be
done by an agent from a sandbox, regardless of tooling:

1. **Pushing to the live Apps Script project** (`clasp login` / `clasp
   push`) needs interactive Google OAuth under the account that owns the
   project.
2. **Provisioning the Postgres DB** (Supabase/Neon) needs an account
   signup.
3. **This GitHub repo's remote** needs to exist under someone's GitHub
   account before anything can be pushed to it.

Everything else in this repo is ready to go the moment those three exist.
