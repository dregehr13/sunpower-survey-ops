// test/statement-import.test.js — the parser and merge rule shared by
// parse-radicl.js (terminal) and api/update-billing.js (in-app import).
// Same code path, so one test file covers both entry points.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const SI = require('../lib/statement-import.cjs');

// Radicl's column labels, matched case-insensitively against a trimmed
// header — see VENDORS.radicl.columns in lib/billing.cjs.
const HEADER = ['Name', 'Address', 'Mission Date', 'Type', 'Sub Type', 'Credits', 'Running Credit Balance'];
function workbook(rows) {
  const sheet = XLSX.utils.aoa_to_sheet([HEADER, ...rows]);
  return { SheetNames: ['Sheet1'], Sheets: { Sheet1: sheet } };
}

test('parseWorkbookLines finds the header row and reads billable lines', () => {
  const wb = workbook([
    ['Jane Smith', '123 Main St, Springfield', '2026-07-01', 'Survey', 'Base', -14.2, 500],
    ['', '', '', '', '', '', ''], // a blank trailing row should not become a line
  ]);
  const lines = SI.parseWorkbookLines(wb, 'radicl');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].name, 'Jane Smith');
  assert.equal(lines[0].date, '2026-07-01');
  assert.equal(lines[0].units, -14.2);
  assert.equal(lines[0].balance, 500);
});

test('parseWorkbookLines throws with the vendor name when no header matches', () => {
  const wb = { SheetNames: ['Sheet1'], Sheets: { Sheet1: XLSX.utils.aoa_to_sheet([['not', 'a', 'statement']]) } };
  assert.throws(() => SI.parseWorkbookLines(wb, 'radicl'), /Radicl/);
});

test('mergeStatement replaces a re-imported statement\'s own lines and keeps every other one', () => {
  const history = {
    statements: [{ id: 'radicl/other', vendor: 'radicl', file: 'other.xlsx', from: '2026-06-01', to: '2026-06-07', lines: 1, imported: '2026-06-08' }],
    lines: [{ vendor: 'radicl', name: 'Old Row', address: '', date: '2026-06-01', type: 'Survey', subtype: 'Base', units: -14.2, statement: 'radicl/other', line: 1 }],
  };
  const first = SI.mergeStatement(history, 'radicl', 'stmt-a.xlsx', [
    { vendor: 'radicl', name: 'A', address: '', date: '2026-07-01', type: 'Survey', subtype: 'Base', units: -14.2 },
  ]);
  assert.equal(first.replaced, 0);
  assert.equal(first.history.lines.length, 2, 'the other statement\'s line survives untouched');

  const second = SI.mergeStatement(first.history, 'radicl', 'stmt-a.xlsx', [
    { vendor: 'radicl', name: 'A', address: '', date: '2026-07-01', type: 'Survey', subtype: 'Base', units: -14.2 },
    { vendor: 'radicl', name: 'B', address: '', date: '2026-07-02', type: 'Survey', subtype: 'Go Back', units: -14.2 },
  ]);
  assert.equal(second.replaced, 1, 'the prior import of the same statement id was replaced, not appended');
  assert.equal(second.history.lines.length, 3, 'other.xlsx\'s line plus stmt-a\'s two current lines');
  assert.equal(second.history.statements.length, 2, 'one statement entry per id, not one per import');
});

test('statementId combines vendor and filename, stripping the extension', () => {
  assert.equal(SI.statementId('radicl', '/Users/doug/Downloads/Sunpower 07.01.26-08.08.26.xlsx'),
    'radicl/Sunpower 07.01.26-08.08.26');
});

test('overlapWarnings fires only on the same vendor with intersecting periods', () => {
  const history = { statements: [
    { id: 'radicl/a', vendor: 'radicl', from: '2026-06-01', to: '2026-06-30' },
    { id: 'radicl/b', vendor: 'radicl', from: '2026-06-15', to: '2026-07-15' },
  ] };
  const warnings = SI.overlapWarnings(history);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /radicl\/b overlaps radicl\/a/);
});
