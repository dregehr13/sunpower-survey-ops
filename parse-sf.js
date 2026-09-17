#!/usr/bin/env node
// parse-sf.js — Parse Salesforce XLS/XLSX export → RAW data array
// Usage: node parse-sf.js <path-to-report.xls>
// Outputs: JSON array to stdout
//
// This is a thin wrapper over lib/parse-sf-core.cjs, which holds the field
// extraction, cycle math and import sanity report. The API refresh path
// (lib/sf-report.cjs + api/refresh-sf.js) converts a fetched report into the
// same allData shape and calls the identical core, so the two ingestion
// paths can never drift into producing different data.json shapes.

import XLSX from 'xlsx';
import { readFileSync } from 'fs';
import parseSfCore from './lib/parse-sf-core.cjs';

const { parseRows } = parseSfCore;

const file = process.argv[2];
if (!file) { console.error('Usage: node parse-sf.js <report.xls>'); process.exit(1); }

// Manual cycle-time anchor overrides, keyed by TaskRay Task ID — see
// overrides.json and applyOverrides() in index.html. Missing file is normal.
let OVERRIDES = {};
try {
  OVERRIDES = JSON.parse(readFileSync(new URL('./overrides.json', import.meta.url), 'utf8')).rows || {};
} catch { /* no overrides.json — nothing to apply */ }

let prevRows = null;
try {
  prevRows = JSON.parse(readFileSync(new URL('./data.json', import.meta.url), 'utf8'));
} catch { /* no existing data.json — first import, nothing to compare */ }

const workbook = XLSX.readFile(file);
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const allData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

let result;
try {
  result = parseRows(allData, { overrides: OVERRIDES, prevRows });
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exit(1);
}

const { rows, warnings, overrideLog } = result;
overrideLog.forEach(l => console.error(l));
warnings.forEach(w => console.error('WARN: ' + w));
console.error(`${rows.length.toLocaleString()} rows, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);

process.stdout.write(JSON.stringify(rows));
