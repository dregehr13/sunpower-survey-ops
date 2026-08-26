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

// Radicl's 08.24.26 statement renamed two columns and inserted a third.
// The old labels are still accepted, so re-importing an older statement
// keeps working — both header shapes must parse to the same line.
test('parseWorkbookLines reads a renamed column and an inserted one', () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Name', 'Organization', 'Address', 'Mission Date', 'Type', 'Sub Type', 'Total Credits', 'Running Balance'],
    ['Jane Smith', 'SunPower', '123 Main St, Springfield', '2026-08-01', 'Survey', 'Base', -14.2, 500],
  ]);
  const lines = SI.parseWorkbookLines({ SheetNames: ['Sheet1'], Sheets: { Sheet1: sheet } }, 'radicl');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].name, 'Jane Smith', 'a column inserted before the mapped ones must not shift the read');
  assert.equal(lines[0].address, '123 Main St, Springfield');
  assert.equal(lines[0].units, -14.2, '"Total Credits" is the same column "Credits" was');
  assert.equal(lines[0].balance, 500, '"Running Balance" is the same column "Running Credit Balance" was');
  assert.equal(lines[0].subtype, 'Base');
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

test('a charge another statement already carried is stored once', () => {
  // Radicl's statements overlap: the 08.24.26 one re-reports everything from
  // Aug 1-8 that the 07.01.26-08.08.26 one already billed. 118 lines in the
  // live data. Doug's call 2026-08-26 — keep one copy.
  const l = o => ({ vendor: 'radicl', name: 'Jane Smith', address: '123 Main St, Springfield',
    date: '2026-08-04', type: 'Survey', subtype: 'Base', units: -14.2, ...o });
  // Periods as they really arrive: July's statement runs into August, so it is
  // the one that reported the Aug 4 charge first.
  const july = SI.mergeStatement({ statements: [], lines: [] }, 'radicl', 'july.xlsx',
    [l({ date: '2026-07-01', name: 'Early Bird', address: '1 Elm St, Springfield' }), l()]);
  const aug = SI.mergeStatement(july.history, 'radicl', 'aug.xlsx', [l(), l({ name: 'New Guy', address: '9 Oak St, Springfield' })]);

  assert.equal(aug.history.lines.length, 3, 'the repeated charge is stored once, the new one is added');
  assert.equal(aug.deduped, 1);
  assert.equal(aug.history.statements.find(s => s.id === 'radicl/aug').dupes, 1);
  assert.equal(aug.history.statements.find(s => s.id === 'radicl/aug').lines, 2,
    "a statement's own line count still describes the statement as invoiced");

  const kept = aug.history.lines.find(x => x.name === 'Jane Smith');
  assert.equal(kept.statement, 'radicl/july', 'the earlier statement keeps the charge it reported first');
  assert.deepEqual(kept.alsoOn, ['radicl/aug'], 'nothing is lost — the other statement is recorded on the line');
});

test('dedupe is count-aware: a statement may legitimately repeat a line', () => {
  // 10 groups in the live data, up to 3 travel adders for one account on one
  // day. Dropping every repeat would delete money that was really billed.
  const t = () => ({ vendor: 'radicl', name: 'Jane Smith', address: '123 Main St, Springfield',
    date: '2026-08-04', type: 'Survey', subtype: 'Travel', units: -9 });
  const july = SI.mergeStatement({ statements: [], lines: [] }, 'radicl', 'july.xlsx', [t()]);
  const aug = SI.mergeStatement(july.history, 'radicl', 'aug.xlsx', [t(), t(), t()]);
  assert.equal(aug.history.lines.length, 3, 'the statement reporting the most copies sets the count');
  assert.ok(aug.history.lines.every(x => x.statement === 'radicl/aug'));
});

test('dedupe is idempotent and survives a re-import', () => {
  const l = o => ({ vendor: 'radicl', name: 'Jane Smith', address: '123 Main St, Springfield',
    date: '2026-08-04', type: 'Survey', subtype: 'Base', units: -14.2, ...o });
  const july = SI.mergeStatement({ statements: [], lines: [] }, 'radicl', 'july.xlsx',
    [l({ date: '2026-07-01', name: 'Early Bird', address: '1 Elm St, Springfield' }), l()]);
  const aug = SI.mergeStatement(july.history, 'radicl', 'aug.xlsx', [l()]);
  const again = SI.dedupeHistory(aug.history);
  assert.equal(again.dropped, 0, 'a second pass has nothing left to drop');
  assert.equal(again.lines.length, aug.history.lines.length);

  // Re-importing aug without that line must clear it from july's alsoOn,
  // otherwise the record says a charge is on a statement that no longer has it.
  const redone = SI.mergeStatement(aug.history, 'radicl', 'aug.xlsx', [l({ name: 'Someone Else', address: '9 Oak St, Springfield' })]);
  assert.equal(redone.history.lines.length, 3);
  assert.equal(redone.history.lines.find(x => x.name === 'Jane Smith').alsoOn, undefined);
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
