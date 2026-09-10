# Help & guide addition — "What brings data to the Review Queue?"

**Where this goes:** Jobverse Console -> Help & guide page (lives in `Dashboard.html`).
Add as a new FAQ entry, matching the existing question/answer style.

### Suggested FAQ entry

**What brings an item into the Review Queue?**

Every time the Resume Builder or Cover Letter Builder generates a document, a
second AI — the Reviewer Agent — checks that document before it goes any
further. It looks for things like claims the CV makes that aren't backed up
by anything in the candidate's actual background (`unsupported_claims`), and
keywords from the job posting that are missing from the document
(`missing_keywords`), and produces an overall `ats_score` and a `confidence`
rating for its own review.

Every one of these reviews lands in the queue with **Status: Awaiting
Human**, along with its score and findings, and stays there until someone
opens it and decides. There's a separate, second checkpoint too: right
before an application would actually be submitted, the extension pauses
again and files a full snapshot of everything it's about to send — that
one also waits for a human Approve before anything reaches a real
employer. Nothing skips either queue on its own.

(If auto-decide is ever turned on for CV/CoverLetter/NHSStatement reviews
specifically — a config setting, off by default — a document that clears
a confidence bar gets decided automatically instead of waiting. That
never applies to the final submission checkpoint, which always waits for
a person.)

**Where do I see why something was flagged?**

Open the item in the Review Queue and check the `AIFindings` details — it
breaks out the ATS score, the confidence rating, any unsupported claims, and
any missing keywords the Reviewer Agent found, so you're not just looking at
a bare pass/fail number.
