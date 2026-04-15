#!/bin/bash
# Morning deploy script
# Usage: ~/Projects/survey-ops/push.sh

PROJ=~/Projects/survey-ops
DL=~/Downloads/survey-dashboard.html

if [ ! -f "$DL" ]; then
  echo "ERROR: survey-dashboard.html not found in Downloads."
  echo "Go to the dashboard, load your SF export, then click Export Dashboard."
  exit 1
fi

echo "Updating dashboard..."
cp "$DL" "$PROJ/index.html"

echo "Updating email generator..."
node -e "
  const fs = require('fs');
  const src = fs.readFileSync('$DL', 'utf8');
  const match = src.match(/const RAW = (\[[\s\S]*?\]);/);
  if (!match) { console.error('Could not find data in export file.'); process.exit(1); }
  const compose = fs.readFileSync('$PROJ/compose/index.html', 'utf8');
  const updated = compose.replace(/const RAW = \[[\s\S]*?\];/, 'const RAW = ' + match[1] + ';');
  fs.writeFileSync('$PROJ/compose/index.html', updated);
  console.log('Done.');
"

echo "Cleaning up..."
rm "$DL"

echo "Deploying..."
cd "$PROJ" && vercel --prod
