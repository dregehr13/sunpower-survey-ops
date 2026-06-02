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

# Sanity check: Details Only exports are 2-4MB; reject small files (wrong format)
FILE_SIZE=$(wc -c < "$SF_FILE" | tr -d ' ')
if [ "$FILE_SIZE" -lt 1000000 ]; then
  echo "ERROR: Export too small (${FILE_SIZE} bytes) — wrong format, expected Details Only. Deleting and aborting."
  rm "$SF_FILE"
  exit 1
fi

echo "Parsing $SF_FILE..."
TMP_JSON="$PROJ/.data.tmp"
node "$PROJ/parse-sf.js" "$SF_FILE" > "$TMP_JSON"

echo "Cleaning up..."
rm "$SF_FILE"

# Skip commit if raw data is unchanged
if [ -f "$PROJ/data.json" ] && diff -q "$TMP_JSON" "$PROJ/data.json" > /dev/null 2>&1; then
  echo "No data changes — skipping commit."
  rm "$TMP_JSON"
  exit 0
fi

echo "Writing data.js and data.json..."
{ printf 'const RAW = '; cat "$TMP_JSON"; printf ";\nconst DATA_TS = '%s';\n" "$DATA_DATE"; } > "$PROJ/data.js"
cp "$TMP_JSON" "$PROJ/data.json"
rm "$TMP_JSON"
echo "Done."

echo "Committing and pushing..."
cd "$PROJ"
git pull --rebase --autostash || true
# If autostash left conflict markers, regenerate data.js cleanly from data.json
if grep -q "<<<<<<" "$PROJ/data.js" 2>/dev/null; then
  { printf 'const RAW = '; cat "$PROJ/data.json"; printf ";\nconst DATA_TS = '%s';\n" "$DATA_DATE"; } > "$PROJ/data.js"
fi
git add data.js data.json
git commit -m "Data update $DATA_DATE"
git push
echo "Done — live in ~30 seconds."
