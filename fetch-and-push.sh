#!/bin/bash
# Called by launchd every 30 minutes.
# Fetches the SF report via Playwright, then runs push.sh if a file landed.

PROJ=~/Projects/survey-ops
LOG=~/Library/Logs/survey-ops-fetch.log

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }

# Run fetch-report.js (exits non-zero silently when SF unreachable / session expired)
/usr/local/bin/node "$PROJ/fetch-report.js" >> "$LOG" 2>&1
if [ $? -ne 0 ]; then
  exit 0
fi

# push.sh finds the latest report*.xls in Downloads automatically
"$PROJ/push.sh" >> "$LOG" 2>&1
