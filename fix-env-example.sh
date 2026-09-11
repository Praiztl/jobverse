#!/usr/bin/env bash
# Removes the real deployment URL that got committed into worker/.env.example
# by mistake (commit 0f87da3) and puts a placeholder back. Note: this does
# NOT erase the real URL from git history - it's still visible in that old
# commit on GitHub. The actual fix for that is rotating the Apps Script
# deployment (new URL, old one archived) - do that in the Apps Script editor
# before or after running this, it's independent of this script.
#
# Usage: run from inside your jobverse-repo clone:
#   bash fix-env-example.sh

set -euo pipefail

if [ ! -d ".git" ]; then
  echo "Run this from inside your jobverse-repo clone (the folder with .git in it)." >&2
  exit 1
fi

echo "Pulling latest..."
git pull origin main

echo "Restoring placeholder in worker/.env.example..."
mkdir -p worker
cat > worker/.env.example << 'ENVEXAMPLE_EOF'
JOBVERSE_API_URL=https://script.google.com/macros/s/XXXXXXXXXXXX/exec
JOBVERSE_API_TOKEN=
WORKER_ID=jobverse-worker-1
POLL_INTERVAL_MS=30000
DOWNLOAD_DIR=./downloads
HEADED=false
# Optional: skip generating/filling anything below this suitability score
# (whatever scale runJobAnalyst uses). 0 = no filtering.
MIN_SUITABILITY=0
ENVEXAMPLE_EOF

echo "Committing..."
git add -A
git commit -m "Remove real deployment URL from worker/.env.example, restore placeholder

The real URL only leaves git history once the deployment behind it is
rotated (new Apps Script deployment/URL, old one archived) - this commit
just stops it being visible in the CURRENT file for anyone browsing the
repo going forward.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"

echo "Pushing..."
git push

echo ""
echo "Done. Reminder: this alone does not remove the old URL from history -"
echo "rotate the Apps Script deployment (new URL, archive the old one) so the"
echo "leaked URL actually stops working, same as rotating a leaked API key."
