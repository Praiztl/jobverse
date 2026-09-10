# appscript/

This folder is intentionally empty except for this file.

To populate it with the real, live Jobverse Apps Script project:

```bash
npm install -g @google/clasp
clasp login                 # opens a browser, authorize under the account that owns the project
clasp clone <SCRIPT_ID>     # SCRIPT_ID is in the Apps Script project's Settings page
```

Run that from your own machine, then copy the resulting files in here and
commit them. From that point on, changes to Apps Script go through this
repo (edit -> PR -> review -> `clasp push`) instead of pasting code
directly into the Apps Script editor.
