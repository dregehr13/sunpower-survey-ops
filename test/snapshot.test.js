// test/snapshot.test.js — golden snapshot over every metric in lib/metrics.cjs.
//
// metrics.test.js proves each function against hand-written cases. This proves
// the whole surface against a frozen slice of REAL data (test/fixtures/rows.json),
// which is where the interesting bugs have actually lived: a definition that is
// individually defensible but disagrees with its neighbour, or a filter that
// silently drops a row shape nobody wrote a unit test for.
//
// Any change to any metric fails this test with a value diff. That is the point —
// review the diff, and if the change is intended, regenerate:
//   UPDATE_SNAPSHOT=1 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpsMetrics from '../lib/metrics.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/rows.json'), 'utf8'));
const SNAP_PATH = path.join(HERE, 'fixtures/snapshot.json');

const {
  filterRows, isComplete, isWIP, wipAgeFrom, hasRepGrace, ssDaysOpen, inRepGrace,
  hasResurveySig, rsCategories, avg, med, pct, normalizeName,
  wipOn, meanWipForWeek, avgWeeklyCompletions, lastCompleteWeekEnd, weeklyFloor,
  ssRatioForWeek, ssRatioLive, ssRatioBand, rollingClearance, clearanceAlarm,
  businessDays, weekDaysRemaining, buildShowRates, buildExpectedCt,
  buildSegmentAvgs, lookupSegmentAvg, projectWeekTotal, bandFor, trendLabel,
} = OpsMetrics;

const asOf = FIXTURE.asOf;
const isoAdd = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};
// Sunday that closed the last complete week — the anchor the weekly metrics use.
const weekEnd = lastCompleteWeekEnd(asOf);
const round = v => (v == null ? null : Math.round(v * 1000) / 1000);

function computeAll() {
  const raw = FIXTURE.rows;
  const rows = filterRows(raw);
  const complete = rows.filter(isComplete);
  const wip = rows.filter(isWIP);
  const cts = complete.map(r => r.ct_total).filter(x => x != null && x >= 0);

  // ── scope & classification ──
  const scope = {
    rawRows: raw.length,
    inScope: rows.length,
    droppedByScope: raw.length - rows.length,
    complete: complete.length,
    wip: wip.length,
    // rows carrying a completion date that are NOT complete — the Holding/Reopened
    // shape the Trends ratio line used to count as finished
    dateButNotComplete: rows.filter(r => r.complete && !isComplete(r)).length,
    withResurveySig: rows.filter(hasResurveySig).length,
    blankRegion: rows.filter(r => !r.region).length,
  };

  // ── cycle time (Spec 12744) ──
  const cycle = { count: cts.length, avg: avg(cts), med: med(cts), p75: pct(cts, 75), p90: pct(cts, 90) };

  // ── the two age metrics, which must never converge ──
  const graceRows = rows.filter(hasRepGrace).length;
  const ssDays = wip.map(r => ssDaysOpen(r, asOf)).filter(x => x != null);
  const projAges = wip.filter(r => r.start).map(r => {
    const [fy, fm, fd] = r.start.split('-').map(Number);
    const [ty, tm, td] = asOf.split('-').map(Number);
    return Math.round((new Date(ty, tm - 1, td) - new Date(fy, fm - 1, fd)) / 86400000);
  }).filter(x => x >= 0);
  const age = {
    hasRepGrace: graceRows,
    noRepGrace: rows.length - graceRows,
    inGraceNow: wip.filter(r => inRepGrace(r, asOf)).length,
    ssDaysOpen: { avg: avg(ssDays), med: med(ssDays), max: Math.max(...ssDays, 0) },
    projectAge: { avg: avg(projAges), med: med(projAges), max: Math.max(...projAges, 0) },
    // the grace day must not move the cycle-time anchor
    anchorsUnmovedByGrace: rows.filter(r => r.start && !r.resurvey_requested && !r.complete)
      .every(r => wipAgeFrom(r) === r.start),
  };

  // ── SS ratio: both variants, plus the inputs each is built from ──
  const ratio = {
    weekEnd,
    wipOnWeekEnd: wipOn(rows, weekEnd),
    meanWipForWeek: round(meanWipForWeek(rows, weekEnd)),
    avgWeeklyCompletions: round(avgWeeklyCompletions(rows, weekEnd)),
    forWeek: ssRatioForWeek(rows, weekEnd),
    live: ssRatioLive(rows, asOf),
    lastCompleteWeekEnd: weekEnd,
    bands: [0.5, 1.0, 1.04, 1.6, 1.99, 2.0, 3.0].map(v => `${v}:${ssRatioBand(v)}`),
  };

  // ── flow & alarms ──
  const floors = [3, 2, 1, 0].map(i => weeklyFloor(rows, isoAdd(weekEnd, -7 * i)));
  const clearSeries = [3, 2, 1, 0].map(i => round(rollingClearance(rows, isoAdd(weekEnd, -7 * i), 4)));
  const flow = {
    rollingClearance4wk: clearSeries[clearSeries.length - 1],
    clearSeries,
    weeklyFloors: floors,
    clearanceAlarm: clearanceAlarm(clearSeries),
  };

  // ── projection inputs ──
  const sixWeeksAgo = isoAdd(asOf, -42);
  const recent = complete.filter(r => r.complete >= sixWeeksAgo && r.ct_total != null && r.ct_total >= 1);
  const showRates = buildShowRates(rows, asOf);
  const expectedCt = buildExpectedCt(recent);
  const segAvgs = buildSegmentAvgs(recent, ['region', 'resource']);
  const projection = {
    recentCompletions: recent.length,
    showRateGlobal: round(showRates.global),
    showRateResources: Object.keys(showRates.byResource).sort(),
    segmentKeys: Object.keys(segAvgs).length,
    expectedCtSample: round(expectedCt({ resource: 'Sales Rep', sales_rep: 'nobody', region: 'ZZ Fixture' })),
    lookupFallback: round(lookupSegmentAvg({ region: 'nowhere', resource: 'nothing' }, ['region', 'resource'], segAvgs, 4)),
    businessDays: businessDays(asOf),
    weekDaysRemaining: weekDaysRemaining(asOf),
    projectWeekTotal: projectWeekTotal(10, wip.slice(0, 5), wip.slice(5, 12), {
      daysRemaining: 2.5, showRates, expectedCt,
    }),
  };

  // ── resurvey categories are NOT snapshotted, deliberately ──
  // rsCategories() reads the request details free text, and build-fixture.cjs
  // replaces that field with "[details redacted]" — it is customer-written prose
  // and does not belong in a committed fixture. A distribution taken here would
  // be eight zeros, which guards nothing and reads like a broken classifier.
  // The regression guard for those patterns is the frozen corpus of synthesised
  // request sentences in metrics.test.js. Keep it that way: if this fixture ever
  // starts carrying real details text, that is the bug.
  const withDetails = rows.filter(r => (r.resurvey_details || '').trim());
  assert.ok(withDetails.length > 0, 'fixture carries no resurvey_details rows at all');
  assert.deepEqual(
    [...new Set(withDetails.map(r => r.resurvey_details))], ['[details redacted]'],
    'fixture details are no longer redacted — build-fixture.cjs must not commit customer prose',
  );
  assert.deepEqual(withDetails.flatMap(rsCategories), [], 'a category pattern matches the redaction marker');

  // ── pure helpers whose bands have burned us before ──
  const helpers = {
    bandFor: [3.9, 4.0, 4.04, 4.05, 6.0, 6.05].map(v => `${v}:${bandFor(v, 4)}`),
    trendLabel: [trendLabel(3, 3.5, 0.1), trendLabel(3.5, 3, 0.1), trendLabel(3, 3.05, 0.1)],
    normalizeName: ['ROBERT DAVIS III', 'JULES LYUSYA', 'Jules Lyusya', 'McDonald ANNE'].map(normalizeName),
  };

  return { fixture: { rows: raw.length, asOf }, scope, cycle, age, ratio, flow, projection, helpers };
}

const actual = computeAll();

if (process.env.UPDATE_SNAPSHOT) {
  fs.writeFileSync(SNAP_PATH, JSON.stringify(actual, null, 1) + '\n');
  console.log(`snapshot updated: ${SNAP_PATH}`);
}

test('golden snapshot: every metric against the frozen fixture', () => {
  assert.ok(fs.existsSync(SNAP_PATH), 'no snapshot — run UPDATE_SNAPSHOT=1 npm test');
  const expected = JSON.parse(fs.readFileSync(SNAP_PATH, 'utf8'));
  // Compare section by section so a failure names the metric group that moved.
  for (const key of Object.keys(expected)) {
    assert.deepEqual(actual[key], expected[key], `snapshot drift in "${key}"`);
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), 'snapshot sections changed');
});

// Invariants that must hold on ANY data, not just this fixture — these catch a
// definition change the snapshot would otherwise let you rubber-stamp.
test('invariant: complete and WIP partition the scoped rows', () => {
  const rows = filterRows(FIXTURE.rows);
  assert.equal(rows.filter(isComplete).length + rows.filter(isWIP).length, rows.length);
});

test('invariant: a completion date alone never counts as complete', () => {
  const rows = filterRows(FIXTURE.rows);
  const holding = rows.filter(r => r.complete && r.list !== 'Complete');
  assert.ok(holding.length > 0, 'fixture lost its Holding/Reopened coverage');
  assert.ok(holding.every(r => isWIP(r)), 'a Holding row is being treated as finished');
});

test('invariant: ssDaysOpen never exceeds the raw elapsed age', () => {
  const rows = filterRows(FIXTURE.rows).filter(isWIP);
  for (const r of rows) {
    const anchor = wipAgeFrom(r);
    if (!anchor) continue;
    const [fy, fm, fd] = anchor.split('-').map(Number);
    const [ty, tm, td] = asOf.split('-').map(Number);
    const raw = Math.round((new Date(ty, tm - 1, td) - new Date(fy, fm - 1, fd)) / 86400000);
    if (raw < 0) continue;
    assert.ok(ssDaysOpen(r, asOf) <= raw, `${r.project}: ssDaysOpen exceeds elapsed age`);
  }
});

test('invariant: the two SS ratio variants stay distinct functions', () => {
  const rows = filterRows(FIXTURE.rows);
  // Not asserting a specific relationship — only that the live variant reads
  // "now" and the weekly one reads a closed week, so they answer different
  // questions and must not be collapsed into one.
  assert.equal(ssRatioLive(rows, asOf) != null || ssRatioForWeek(rows, weekEnd) != null, true);
  assert.equal(typeof ssRatioLive, 'function');
  assert.equal(typeof ssRatioForWeek, 'function');
});
