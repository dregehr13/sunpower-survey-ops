// test/metrics.test.js — locks down the metric definitions in lib/metrics.cjs.
// These are the numbers Spencer reads; a definition change should fail here first.
// Run: npm test (node:test, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpsMetrics from '../lib/metrics.cjs';

const {
  DATA_CUTOFF, inScope, filterRows, normalizeName, isComplete, isWIP,
  wipAgeFrom, hasResurveySig, avg, med, pct,
  businessDays, buildSegmentAvgs, lookupSegmentAvg, projectWeekTotal,
  bandFor, TREND_BAND_AVG, TREND_BAND_MED, trendLabel,
} = OpsMetrics;

// ── isComplete: requires BOTH a completion date AND List status 'Complete' ──
test('isComplete requires both complete date and list status', () => {
  assert.equal(isComplete({ complete: '2026-07-01', list: 'Complete' }), true);
  assert.equal(isComplete({ complete: '2026-07-01', list: 'In Progress' }), false);
  assert.equal(isComplete({ complete: '2026-07-01', list: '' }), false);
  assert.equal(isComplete({ complete: '', list: 'Complete' }), false);
  assert.equal(isComplete({ complete: '', list: '' }), false);
});

// ── isWIP: started but not complete ──
test('isWIP is started-and-not-complete', () => {
  assert.equal(isWIP({ start: '2026-06-01', complete: '', list: '' }), true);
  assert.equal(isWIP({ start: '2026-06-01', complete: '2026-06-05', list: 'Complete' }), false);
  // complete date without list status: still WIP (matches isComplete)
  assert.equal(isWIP({ start: '2026-06-01', complete: '2026-06-05', list: 'In Progress' }), true);
  assert.equal(isWIP({ start: '', complete: '', list: '' }), false);
});

// ── wipAgeFrom: resurvey request → completion +2 days → project start ──
test('wipAgeFrom fallback chain', () => {
  assert.equal(wipAgeFrom({ resurvey_requested: '2026-07-01', complete: '2026-06-20', start: '2026-06-01' }), '2026-07-01');
  assert.equal(wipAgeFrom({ resurvey_requested: '', complete: '2026-06-20', start: '2026-06-01' }), '2026-06-22');
  assert.equal(wipAgeFrom({ resurvey_requested: '', complete: '', start: '2026-06-01' }), '2026-06-01');
});

test('wipAgeFrom completion +2 rolls over month boundaries', () => {
  assert.equal(wipAgeFrom({ resurvey_requested: '', complete: '2026-06-30', start: '2026-06-01' }), '2026-07-02');
  assert.equal(wipAgeFrom({ resurvey_requested: '', complete: '2026-12-31', start: '2026-12-01' }), '2027-01-02');
});

// ── hasResurveySig: reopened_by_design is a STRING flag '0'/'1' ──
test('hasResurveySig detects any resurvey signal', () => {
  assert.equal(hasResurveySig({ resurvey_requested: '2026-07-01' }), true);
  assert.equal(hasResurveySig({ resurvey_complete: '2026-07-05' }), true);
  assert.equal(hasResurveySig({ resurvey_reason: 'Shading' }), true);
  assert.equal(hasResurveySig({ reopened_by_design: '1' }), true);
  assert.equal(hasResurveySig({ reopened_by_design: '0' }), false);
  assert.equal(hasResurveySig({}), false);
});

// ── avg / med / pct: null and negative handling ──
test('avg ignores null, negative, and NaN; empty → null', () => {
  assert.equal(avg([2, 4]), 3);
  assert.equal(avg([2, null, -5, NaN, 4]), 3);
  assert.equal(avg([]), null);
  assert.equal(avg([null, -1]), null);
  assert.equal(avg([1, 2]), 1.5); // rounded to 2 decimals
});

test('med ignores null and negative; even-length averages middle pair', () => {
  assert.equal(med([1, 3, 2]), 2);
  assert.equal(med([1, 2, 3, 4]), 2.5);
  assert.equal(med([5, null, -2]), 5);
  assert.equal(med([]), null);
  assert.equal(med([null]), null);
});

test('pct percentile with null handling', () => {
  const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(pct(vals, 50), 5);
  assert.equal(pct(vals, 90), 9);
  assert.equal(pct([7, null, -1], 75), 7);
  assert.equal(pct([], 75), null);
});

// ── normalizeName ──
test('normalizeName title-cases fully-uppercase names', () => {
  assert.equal(normalizeName('JULES LYUSYA'), 'Jules Lyusya');
  assert.equal(normalizeName('JOHN SMITH JR'), 'John Smith JR');
});

test('normalizeName preserves roman numerals III/IV', () => {
  assert.equal(normalizeName('ROBERT DAVIS III'), 'Robert Davis III');
  assert.equal(normalizeName('HENRY FORD IV'), 'Henry Ford IV');
});

test('normalizeName leaves mixed-case and empty names untouched', () => {
  assert.equal(normalizeName('Jules Lyusya'), 'Jules Lyusya');
  assert.equal(normalizeName('McDonald ANNE'), 'McDonald ANNE'); // not fully uppercase
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName(undefined), undefined);
});

// ── filterRows / inScope ──
test('filterRows keeps active projects started on/after the cutoff', () => {
  const rows = [
    { project_status: 'In Progress',  start: DATA_CUTOFF,  sales_rep: 'A B' },
    { project_status: 'Change Order', start: '2026-06-01', sales_rep: 'C D' },
    { project_status: 'In Progress',  start: '2025-12-28', sales_rep: 'E F' }, // before cutoff
    { project_status: 'Cancelled',    start: '2026-06-01', sales_rep: 'G H' }, // wrong status
  ];
  const out = filterRows(rows);
  assert.deepEqual(out.map(r => r.sales_rep), ['A B', 'C D']);
});

test('filterRows honors a custom cutoff and normalizes rep names', () => {
  const rows = [
    { project_status: 'In Progress', start: '2026-03-01', sales_rep: 'JULES LYUSYA' },
    { project_status: 'In Progress', start: '2026-01-15', sales_rep: 'X Y' },
  ];
  const out = filterRows(rows, '2026-02-01');
  assert.equal(out.length, 1);
  assert.equal(out[0].sales_rep, 'Jules Lyusya');
});

// ── businessDays: anchored on "yesterday" (the export date) ──
test('businessDays Monday morning (yesterday=Sunday): new week, 0 elapsed', () => {
  // 2026-07-12 is a Sunday
  assert.deepEqual(businessDays('2026-07-12'), { elapsed: 0, remaining: 5 });
});

test('businessDays Sunday (yesterday=Saturday): week done, 5 elapsed', () => {
  // 2026-07-11 is a Saturday
  assert.deepEqual(businessDays('2026-07-11'), { elapsed: 5, remaining: 0 });
});

test('businessDays midweek', () => {
  assert.deepEqual(businessDays('2026-07-06'), { elapsed: 1, remaining: 4 }); // Monday
  assert.deepEqual(businessDays('2026-07-08'), { elapsed: 3, remaining: 2 }); // Wednesday
  assert.deepEqual(businessDays('2026-07-10'), { elapsed: 5, remaining: 0 }); // Friday
});

// ── projectWeekTotal ──
test('projectWeekTotal formula: completed + scheduled*0.9 + unscheduled/avgCt*daysLeft', () => {
  // 10 done + round(4*0.9 + 20/5*3) = 10 + round(3.6+12) = 10 + 16 = 26
  assert.equal(projectWeekTotal(10, 4, 20, 5, 3), 26);
});

test('projectWeekTotal Monday morning uses the full 5 remaining days', () => {
  const { remaining } = businessDays('2026-07-12'); // yesterday=Sunday
  // 0 done + round(2*0.9 + 10/4*5) = round(1.8+12.5) = 14
  assert.equal(projectWeekTotal(0, 2, 10, 4, remaining), 14);
});

test('projectWeekTotal with the week done returns completions only', () => {
  const { remaining } = businessDays('2026-07-11'); // yesterday=Saturday
  assert.equal(remaining, 0);
  assert.equal(projectWeekTotal(37, 4, 20, 5, remaining), 37);
});

// ── buildSegmentAvgs / lookupSegmentAvg ──
test('segment avgs: exact match, prefix fallback, global fallback', () => {
  const completions = [
    { region: 'UT Salt Lake', resource: 'Sales Rep', ct_total: 2 },
    { region: 'UT Salt Lake', resource: 'Sales Rep', ct_total: 4 },
    { region: 'UT Salt Lake', resource: 'Radicl Services', ct_total: 8 },
  ];
  const dims = ['region', 'resource'];
  const segs = buildSegmentAvgs(completions, dims);
  assert.equal(segs['UT Salt Lake|Sales Rep'], 3);
  assert.equal(segs['UT Salt Lake|Radicl Services'], 8);
  // Exact segment hit
  assert.equal(lookupSegmentAvg({ region: 'UT Salt Lake', resource: 'Sales Rep' }, dims, segs, 99), 3);
  // Unknown resource in a known region → falls back to region prefix? No region-only
  // segment exists here, so it falls through to the global avg.
  assert.equal(lookupSegmentAvg({ region: 'AZ Phoenix', resource: 'Sales Rep' }, dims, segs, 99), 99);
});

test('segment avgs skip segments with no usable cycle times', () => {
  const segs = buildSegmentAvgs([{ region: 'TX', resource: 'Sales Rep', ct_total: null }], ['region', 'resource']);
  assert.deepEqual(segs, {});
});

// ── bandFor ──
test('bandFor bands: ≤target good, ≤target+2 mid, else bad, null → empty', () => {
  assert.equal(bandFor(4, 4), 'good');
  assert.equal(bandFor(4.1, 4), 'mid');
  assert.equal(bandFor(6, 4), 'mid');
  assert.equal(bandFor(6.1, 4), 'bad');
  assert.equal(bandFor(null, 4), '');
  assert.equal(bandFor(0, 3), 'good');
});

// ── trendLabel ──
test('trendLabel with the avg dead band (dashboard)', () => {
  assert.equal(TREND_BAND_AVG, 0.1);
  assert.equal(trendLabel(-0.2, 0, TREND_BAND_AVG), 'Improving');
  assert.equal(trendLabel(0.2, 0, TREND_BAND_AVG), 'Slowing');
  assert.equal(trendLabel(0.1, 0, TREND_BAND_AVG), 'Stable');   // boundary is inclusive
  assert.equal(trendLabel(-0.1, 0, TREND_BAND_AVG), 'Stable');
});

test('trendLabel with the median dead band (compose)', () => {
  assert.equal(TREND_BAND_MED, 0.3);
  assert.equal(trendLabel(3, 3.5, TREND_BAND_MED), 'Improving');
  assert.equal(trendLabel(4, 3.5, TREND_BAND_MED), 'Slowing');
  assert.equal(trendLabel(3.5, 3.5, TREND_BAND_MED), 'Stable');
});

test('trendLabel returns null when either side is missing', () => {
  assert.equal(trendLabel(null, 3, TREND_BAND_MED), null);
  assert.equal(trendLabel(3, null, TREND_BAND_MED), null);
});
