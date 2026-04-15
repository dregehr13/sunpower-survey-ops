#!/bin/bash
# Data update + deploy script
# Usage: ~/Projects/survey-ops/push.sh [path/to/report.xls]
#
# If a file argument is given, uses that. Otherwise looks for the most recently
# modified report*.xls in ~/Downloads.
#
# For code-only deploys (no data update): git push

set -e
export PROJ=~/Projects/survey-ops
export DATA_DATE=$(date +%Y-%m-%d)

# --- Find the SF export ---
if [ -n "$1" ]; then
  SF_FILE="$1"
else
  SF_FILE=$(ls -t ~/Downloads/report*.xls 2>/dev/null | head -1)
fi

if [ -z "$SF_FILE" ] || [ ! -f "$SF_FILE" ]; then
  echo "ERROR: No Salesforce export found."
  echo "Export from Salesforce (Details Only → Excel format) and re-run, or pass the file path as an argument."
  exit 1
fi

echo "Parsing $SF_FILE..."
export RAW_JSON=$(node "$PROJ/parse-sf.js" "$SF_FILE")

echo "Splicing data..."
node --input-type=module << 'EOF'
import { readFileSync, writeFileSync } from 'fs';
const raw = process.env.RAW_JSON;
const proj = process.env.PROJ;
const date = process.env.DATA_DATE;

for (const f of [`${proj}/index.html`, `${proj}/compose/index.html`]) {
  let content = readFileSync(f, 'utf8');
  content = content.replace(/const RAW = \[[\s\S]*?\];/, `const RAW = ${raw};`);
  content = content.replace(/const DATA_TS = '[^']*';/, `const DATA_TS = '${date}';`);
  writeFileSync(f, content);
}
console.log('Done.');
EOF

echo "Cleaning up..."
rm "$SF_FILE"

echo "Committing and pushing..."
cd "$PROJ"
git add index.html compose/index.html
# Commit only if something actually changed
if git diff --cached --quiet; then
  echo "No changes to commit (data identical to last push)."
else
  git commit -m "Data update $DATA_DATE"
  git push
  echo "Done — live in ~30 seconds."
fi
