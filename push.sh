#!/bin/bash
# Morning deploy script — run after clicking Export Dashboard in the browser
# Usage: ~/Projects/survey-ops/push.sh

PROJ=~/Projects/survey-ops
DL=~/Downloads

echo "Copying exported files..."

if [ -f "$DL/survey-dashboard.html" ]; then
  cp "$DL/survey-dashboard.html" "$PROJ/index.html"
  rm "$DL/survey-dashboard.html"
  echo "  dashboard updated"
else
  echo "  WARNING: survey-dashboard.html not found in Downloads — skipping"
fi

if [ -f "$DL/survey-compose.html" ]; then
  cp "$DL/survey-compose.html" "$PROJ/compose/index.html"
  rm "$DL/survey-compose.html"
  echo "  email generator updated"
else
  echo "  WARNING: survey-compose.html not found in Downloads — skipping"
fi

echo "Deploying..."
cd "$PROJ" && vercel --prod
