#!/usr/bin/env node
// Builds test/fixtures/rows.json — a small, deterministic slice of real data
// covering every edge case the metrics have tripped over. Regenerate with:
//   node scripts/build-fixture.js
//
// Selection is deterministic (sorted, first N per bucket) so the fixture only
// changes when this script changes — never because data.js moved underneath it.
// Contact PII is replaced with synthetic values; no metric depends on it.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// data.json is the same rows as data.js, written by push.sh — parse it rather
// than eval'ing the 2.8MB script.
const RAW = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const DATA_TS = (fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8')
  .match(/const DATA_TS\s*=\s*'([^']+)'/) || [])[1];
if (!DATA_TS) throw new Error('could not read DATA_TS from data.js');

const M = require(path.join(ROOT, 'lib/metrics.cjs'));
const asOf = DATA_TS.slice(0, 10);

// Every bucket is an edge case some metric has gotten wrong at least once.
const isoAddG = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

const BUCKETS = {
  // isComplete requires date AND list==='Complete' — these are the rows the
  // Trends ratio line silently counted as finished.
  holding:        r => r.complete && r.list === 'Holding',
  reopened:       r => r.complete && r.list === 'Reopened',
  // inScope: a finished survey counts even on an At-Risk/Canceled project
  atRiskComplete: r => r.project_status === 'At-Risk' && M.isComplete(r),
  atRiskOpen:     r => r.project_status === 'At-Risk' && !M.isComplete(r),
  // the upload parser used to drop these
  blankRegion:    r => !r.region,
  // rep grace: blank resource counts as rep; straight-to-field does not
  blankResource:  r => !r.resource && M.isWIP(r),
  repWip:         r => r.resource === 'Sales Rep' && M.isWIP(r),
  straightToField:r => (r.resource === 'Radicl Services' || r.resource === 'SunPower Surveyor') && !r.requested,
  handedOff:      r => r.resource === 'Radicl Services' && r.requested,
  // resurveys get no grace, and anchor on resurvey_requested
  openResurvey:   r => r.resurvey_requested && !r.resurvey_complete,
  doneResurvey:   r => r.resurvey_requested && r.resurvey_complete && M.isComplete(r),
  reopenedByDesign: r => r.reopened_by_design === '1',
  // the grace-day boundary itself
  startedOnAsOf:  r => r.start === asOf && M.isWIP(r),
  // ordinary completions — the bulk of any real calculation
  plainComplete:  r => M.isComplete(r) && r.ct_total != null && !r.resurvey_requested,
  // Weekly/ratio metrics divide by completions in a trailing window. Without a
  // dense recent slice the fixture's denominators collapse toward zero and those
  // metrics stop exercising real arithmetic.
  recentComplete: r => M.isComplete(r) && r.complete >= isoAddG(asOf, -28),
  recentStart:    r => r.start >= isoAddG(asOf, -28),
  // mixed-case rep names (normalizeName)
  upperRep:       r => r.sales_rep && r.sales_rep === r.sales_rep.toUpperCase() && /[A-Z]/.test(r.sales_rep),
};

const PER_BUCKET = { plainComplete: 40, recentComplete: 60, recentStart: 30 };
const DEFAULT_N = 6;

const picked = new Map();
const coverage = {};
for (const [name, pred] of Object.entries(BUCKETS)) {
  const matches = RAW.filter(pred).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const take = matches.slice(0, PER_BUCKET[name] || DEFAULT_N);
  coverage[name] = { available: matches.length, taken: take.length };
  take.forEach(r => picked.set(r.id, r));
}

// Scrub PII — nothing downstream reads these, and the fixture is committed.
const rows = [...picked.values()]
  .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  .map((r, i) => ({
    ...r,
    contact: `Contact ${i + 1}`,
    contact_phone: '555-0100',
    contact_email: `contact${i + 1}@example.test`,
    address: `${100 + i} Example St`,
    sales_rep_phone: '555-0101',
    sales_rep_email: 'rep@example.test',
    last_comment: r.last_comment ? '[comment redacted]' : '',
    resurvey_details: r.resurvey_details ? '[details redacted]' : '',
  }));

// Synthetic rows for boundaries real data doesn't always contain. Without these
// the fixture's coverage would depend on what happened to be in the day's export.
const isoAdd = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};
const base = {
  ct_s2r: null, ct_r2s: null, ct_total: null, project_status: 'In Progress',
  contact_phone: '555-0100', contact_email: 'contact@example.test', region: 'ZZ Fixture',
  type: 'Ambia', sales_rep_phone: '555-0101', sales_rep_email: 'rep@example.test',
  requested: '', scheduled: '', complete: '', reviewed_by: '', last_reviewed_date: '',
  last_reviewed_subject: '', survey_type: '', last_comment: '', list: 'Open',
  task_id: '', owner: '', reopened_by_design: '0', resurvey_reason: '',
  resurvey_attributed: '', resurvey_requested: '', resurvey_scheduled: '',
  resurvey_complete: '', resurvey_details: '', field_survey_scheduled: '',
  field_survey_complete: '', ct_resurvey: null, ct_full: null,
};
const synthetic = [
  // rep still inside the grace day — ssDaysOpen 0, inRepGrace true
  { ...base, id: 'fx-grace-day0', project: 'FXGRACE0', address: '1 Fixture Way',
    contact: 'Fixture Grace0', sales_rep: 'Fixture Rep', resource: 'Sales Rep', start: asOf },
  // grace just expired — ssDaysOpen 0, inRepGrace false
  { ...base, id: 'fx-grace-day1', project: 'FXGRACE1', address: '2 Fixture Way',
    contact: 'Fixture Grace1', sales_rep: 'Fixture Rep', resource: 'Sales Rep', start: isoAdd(asOf, -1) },
  // no rep phase — no grace, full elapsed
  { ...base, id: 'fx-nograce', project: 'FXNOGRC', address: '3 Fixture Way',
    contact: 'Fixture NoGrace', sales_rep: 'Fixture Rep', resource: 'Radicl Services', start: isoAdd(asOf, -3) },
  // normalizeName: fully-uppercase rep with a roman numeral to preserve
  { ...base, id: 'fx-upper-rep', project: 'FXUPPER', address: '4 Fixture Way',
    contact: 'Fixture Upper', sales_rep: 'ROBERT DAVIS III', resource: 'Sales Rep', start: isoAdd(asOf, -5) },
];
rows.push(...synthetic);
coverage.synthetic = { available: synthetic.length, taken: synthetic.length };

const out = { asOf, generatedFrom: DATA_TS, rowCount: rows.length, coverage, rows };
fs.mkdirSync(path.join(ROOT, 'test/fixtures'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'test/fixtures/rows.json'), JSON.stringify(out, null, 1) + '\n');

console.log(`fixture: ${rows.length} rows, asOf ${asOf}`);
Object.entries(coverage).forEach(([k, v]) => {
  const flag = v.taken === 0 ? '  <-- EMPTY' : '';
  console.log(`  ${k.padEnd(18)} ${String(v.taken).padStart(3)} of ${v.available}${flag}`);
});
