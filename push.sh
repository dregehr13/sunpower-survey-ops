#!/bin/bash
# Data update + deploy script
# Usage: ~/Projects/survey-ops/push.sh [path/to/report.xls]
#
# If a file argument is given, uses that. Otherwise looks for the most recently
# modified report*.xls in .downloads/ (written by fetch-report.js).
#
# For code-only deploys (no data update): git push

set -e
PROJ=~/Projects/survey-ops
DATA_DATE=$(date '+%Y-%m-%d %H:%M')

# --- Find the SF export ---
if [ -n "$1" ]; then
  SF_FILE="$1"
else
  SF_FILE=$(ls -t "$PROJ"/.downloads/report*.xls 2>/dev/null | head -1)
fi

if [ -z "$SF_FILE" ] || [ ! -f "$SF_FILE" ]; then
  echo "ERROR: No Salesforce export found."
  echo "Export from Salesforce (Details Only → Excel format) and re-run, or pass the file path as an argument."
  exit 1
fi

echo "Parsing $SF_FILE..."
TMP_JSON="$PROJ/.data.tmp"
node "$PROJ/parse-sf.js" "$SF_FILE" > "$TMP_JSON"

echo "Writing data.js and data.json..."
{ printf 'const RAW = '; cat "$TMP_JSON"; printf ";\nconst DATA_TS = '%s';\n" "$DATA_DATE"; } > "$PROJ/data.js"
cp "$TMP_JSON" "$PROJ/data.json"
echo "Done."

rm "$TMP_JSON"

echo "Cleaning up..."
rm "$SF_FILE"

echo "Committing and pushing..."
cd "$PROJ"
git pull --rebase --autostash
git add data.js data.json
# Commit only if something actually changed
if git diff --cached --quiet; then
  echo "No changes to commit (data identical to last push)."
else
  git commit -m "Data update $DATA_DATE"
  git push
  echo "Done — live in ~30 seconds."
fi
