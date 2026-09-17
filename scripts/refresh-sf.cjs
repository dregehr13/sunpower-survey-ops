#!/usr/bin/env node
// scripts/refresh-sf.cjs — Fetch the Site Survey report via the Salesforce
// API, parse it through the same core as parse-sf.js, and write
// data.js/data.json — the API equivalent of push.sh's manual-export step.
//
// Usage: node scripts/refresh-sf.cjs [--commit]
//   (no flag)  writes data.js + data.json locally, prints a summary, exits.
//              Review the diff, then commit the way push.sh does.
//   --commit   also runs git add/commit/push, mirroring push.sh's tail.
//
// Requires env vars (see lib/sf-auth.cjs and docs/sf-api-setup.md):
//   SF_LOGIN_URL, SF_CLIENT_ID, SF_USERNAME, SF_PRIVATE_KEY, SF_REPORT_ID
//
// NOT yet exercised against a live org — this is the script to run for the
// first end-to-end smoke test once the Connected App + pre-authorized user
// exist. See lib/sf-report.cjs's note on the 2,000-row synchronous cap: the
// live report is ~4,700 rows, so this will need the async Report Instance
// API wired in before it can fully replace the manual export.

const { execSync } = require('child_process');
const { readFileSync, writeFileSync, existsSync } = require('fs');
const path = require('path');
const { getAccessToken } = require('../lib/sf-auth.cjs');
const { fetchFullReport, reportToAllData } = require('../lib/sf-report.cjs');
const { parseRows } = require('../lib/parse-sf-core.cjs');

const PROJ = path.resolve(__dirname, '..');
const shouldCommit = process.argv.includes('--commit');

async function main() {
  const reportId = process.env.SF_REPORT_ID;
  if (!reportId) throw new Error('SF_REPORT_ID env var not set');

  console.error('Authenticating...');
  const { access_token, instance_url } = await getAccessToken();

  console.error('Fetching report...');
  const reportJson = await fetchFullReport({ instanceUrl: instance_url, accessToken: access_token, reportId });
  const allData = reportToAllData(reportJson);

  let overrides = {};
  try { overrides = JSON.parse(readFileSync(path.join(PROJ, 'overrides.json'), 'utf8')).rows || {}; } catch {}

  let prevRows = null;
  const dataJsonPath = path.join(PROJ, 'data.json');
  if (existsSync(dataJsonPath)) {
    try { prevRows = JSON.parse(readFileSync(dataJsonPath, 'utf8')); } catch {}
  }

  const { rows, warnings, overrideLog } = parseRows(allData, { overrides, prevRows });
  overrideLog.forEach(l => console.error(l));
  warnings.forEach(w => console.error('WARN: ' + w));
  console.error(`${rows.length.toLocaleString()} rows, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);

  if (prevRows && JSON.stringify(rows) === JSON.stringify(prevRows)) {
    console.error('No data changes — skipping write.');
    return;
  }

  const dataDate = new Date().toLocaleString('sv-SE', { timeZone: 'America/Denver' }).slice(0, 16);
  writeFileSync(dataJsonPath, JSON.stringify(rows));
  writeFileSync(path.join(PROJ, 'data.js'),
    `const RAW = ${JSON.stringify(rows)};\nconst DATA_TS = '${dataDate}';\n`);
  console.error('Wrote data.js and data.json.');

  if (shouldCommit) {
    execSync('git add data.js data.json', { cwd: PROJ, stdio: 'inherit' });
    execSync(`git commit -m "Data update ${dataDate} (Salesforce API)"`, { cwd: PROJ, stdio: 'inherit' });
    execSync('git push', { cwd: PROJ, stdio: 'inherit' });
    console.error('Committed and pushed — live in ~30 seconds.');
  } else {
    console.error('Review the diff, then commit (or re-run with --commit).');
  }
}

main().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
