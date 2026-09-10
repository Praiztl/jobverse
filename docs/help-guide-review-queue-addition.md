# Help & guide addition — "What brings data to the Review Queue?"

**Where this goes:** Jobverse Console → Help & guide page (lives in `Dashboard.html`,
an Apps Script project file). Add as a new FAQ entry, matching the existing
question/answer style (e.g. sitting near "Is anything ever submitted without a
human?").

**Note:** I haven't edited `Dashboard.html` myself — per the standing rule, I don't
touch Apps Script project files directly. This is worded and formatted to paste in
as-is; a human (or the AI Coder role, if that's how changes normally get made) still
needs to add it to the file and save/redeploy.

---

### Suggested FAQ entry

**What brings an item into the Review Queue?**

Every time the Resume Builder or Cover Letter Builder generates a document, a
second AI — the Reviewer Agent — checks that document before it goes any
further. It looks for things like claims the CV makes that aren't backed up
by anything in the candidate's actual background (`unsupported_claims`), and
keywords from the job posting that are missing from the document
(`missing_keywords`), and produces an overall `ats_score` and a `confidence`
rating for its own review.

If that self-check comes back clean and confident, the item is auto-decided
and never needs your attention — you'll still see it logged, just not sitting
in the queue.

If the Reviewer Agent isn't confident, or flags anything worth a second look,
the item lands in the Review Queue with **Status: Awaiting Human**, along with
its score and findings so you can see exactly what it flagged. Nothing from
that item is ever sent to an employer until a person opens it and clicks
Approve — there's no path from "generated" to "submitted" that skips this
queue.

**Where do I see why something was flagged?**

Open the item in the Review Queue and check the `AIFindings` details — it
breaks out the ATS score, the confidence rating, any unsupported claims, and
any missing keywords the Reviewer Agent found, so you're not just looking at
a bare pass/fail number.

---

## Why I didn't just add this myself

I read `Dashboard.html` only through the browser, and I'm not allowed to open
it in the Apps Script editor and save changes — that falls under the same
"no editing or deploying Apps Script" rule I've been holding to for the
Prospects.gs fix all session. If you want this in the guide today, paste the
section above into the Help & guide part of `Dashboard.html` and save. Happy
to re-check the formatting once it's in, or adjust the wording first if you
want it shorter.
