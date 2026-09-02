// test/metrics.test.js — locks down the metric definitions in lib/metrics.cjs.
// These are the numbers Spencer reads; a definition change should fail here first.
// Run: npm test (node:test, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpsMetrics from '../lib/metrics.cjs';

const {
  DATA_CUTOFF, inScope, filterRows, normalizeName, isComplete, isWIP,
  effectiveComplete, wipAgeFrom, hasRepGrace, ssDaysOpen, inRepGrace, hasResurveySig, isResurveyDefect, isOpenResurvey, RS_CATEGORIES, rsCategories, rsCatLabel, fpy, avg, med, pct,
  businessDays, weekDaysRemaining, buildShowRates, buildExpectedCt,
  wipOn, meanWipForWeek, avgWeeklyCompletions, lastCompleteWeekEnd, ssRatioForWeek, ssRatioLive, ssRatioBand, clearanceAlarm, floorAlarm,
  buildSegmentAvgs, lookupSegmentAvg, buildWeekdayShape, buildProjectionModel, projectWeek,
  bandFor, queueAgeBand, TREND_BAND_AVG, TREND_BAND_MED, trendLabel,
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

test('effectiveComplete reuses the agreement date when the survey predates it', () => {
  // Cancelled account re-signed months later, old survey still good.
  assert.equal(effectiveComplete({ complete: '2025-08-18', agreement_signed: '2026-04-06' }), '2026-04-06');
  // Rep signed and surveyed the same day — nothing to shift.
  assert.equal(effectiveComplete({ complete: '2026-07-11', agreement_signed: '2026-07-11' }), '2026-07-11');
  // The normal case is untouched.
  assert.equal(effectiveComplete({ complete: '2026-07-15', agreement_signed: '2026-07-10' }), '2026-07-15');
  // Degrades safely where the field is absent, as in already-deployed data.
  assert.equal(effectiveComplete({ complete: '2026-07-15', agreement_signed: '' }), '2026-07-15');
  assert.equal(effectiveComplete({ complete: '', agreement_signed: '2026-07-10' }), '');
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

// ── Rep grace day: the SS clock starts the day after the rep takes it ──
test('hasRepGrace: blank resource defaults to rep, straight-to-field does not', () => {
  assert.equal(hasRepGrace({ resource: 'Sales Rep', start: '2026-07-01' }), true);
  assert.equal(hasRepGrace({ resource: '', start: '2026-07-01' }), true);
  // handed off from a rep (requested populated) — the rep phase still happened
  assert.equal(hasRepGrace({ resource: 'Radicl Services', requested: '2026-07-03', start: '2026-07-01' }), true);
  assert.equal(hasRepGrace({ resource: 'SunPower Surveyor', requested: '2026-07-03', start: '2026-07-01' }), true);
  // never had a rep phase
  assert.equal(hasRepGrace({ resource: 'Radicl Services', requested: '', start: '2026-07-01' }), false);
  assert.equal(hasRepGrace({ resource: 'SunPower Surveyor', requested: '', start: '2026-07-01' }), false);
});

test('hasRepGrace: open resurveys get no grace', () => {
  assert.equal(hasRepGrace({ resource: 'Sales Rep', resurvey_requested: '2026-07-05', resurvey_complete: '' }), false);
  // a closed resurvey is back to normal rules
  assert.equal(hasRepGrace({ resource: 'Sales Rep', resurvey_requested: '2026-07-05', resurvey_complete: '2026-07-08', start: '2026-07-01' }), true);
});

test('ssDaysOpen subtracts the grace day and floors at zero', () => {
  const rep = { resource: 'Sales Rep', start: '2026-07-01' };
  assert.equal(ssDaysOpen(rep, '2026-07-01'), 0); // rep's day — SS clock not started
  assert.equal(ssDaysOpen(rep, '2026-07-02'), 0); // grace just expired
  assert.equal(ssDaysOpen(rep, '2026-07-05'), 3);
  const field = { resource: 'Radicl Services', requested: '', start: '2026-07-01' };
  assert.equal(ssDaysOpen(field, '2026-07-05'), 4); // no grace, full elapsed
});

test('ssDaysOpen leaves open resurveys on the full clock', () => {
  const rs = { resource: 'Sales Rep', start: '2026-06-01', resurvey_requested: '2026-07-01', resurvey_complete: '' };
  assert.equal(ssDaysOpen(rs, '2026-07-04'), 3); // anchored at resurvey request, no grace
});

test('inRepGrace only while the rep still owns the day', () => {
  const rep = { resource: 'Sales Rep', start: '2026-07-01' };
  assert.equal(inRepGrace(rep, '2026-07-01'), true);
  assert.equal(inRepGrace(rep, '2026-07-02'), false);
  assert.equal(inRepGrace({ resource: 'Radicl Services', requested: '', start: '2026-07-01' }, '2026-07-01'), false);
});

test('grace day never moves the cycle-time anchor', () => {
  // wipAgeFrom drives ct_total, projCt and estComplete — Spec 12744 must not shift
  const rep = { resource: 'Sales Rep', start: '2026-07-01', resurvey_requested: '', complete: '' };
  assert.equal(wipAgeFrom(rep), '2026-07-01');
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

test('isResurveyDefect excludes requests dismissed as unnecessary', () => {
  const real = { resurvey_requested: '2026-07-01', resurvey_reason: 'Survey Incomplete' };
  assert.equal(isResurveyDefect(real), true);
  // Nothing was re-surveyed, so the survey did not fail.
  assert.equal(isResurveyDefect({ ...real, resurvey_reason: 'Unnecessary Request' }), false);
  // Multi-select: dismissed wins even alongside a real-sounding reason, because
  // the picklist is the team's own verdict on the request.
  assert.equal(isResurveyDefect({ ...real, resurvey_reason: 'Survey Incomplete; Unnecessary Request' }), false);
  // A row with no resurvey signal at all is not a defect either way.
  assert.equal(isResurveyDefect({}), false);
  // Every defect is still a resurvey signal; the reverse no longer holds.
  assert.equal(hasResurveySig({ resurvey_reason: 'Unnecessary Request' }), true);
});

// ── rsCategories: what the request actually asked for, read from free text ──
test('rsCategories reads the ask out of the request details', () => {
  const cat = d => rsCategories({ resurvey_details: d });
  // The commonest shape in the data by a wide margin.
  assert.deepEqual(cat('We need photos of the MSP with the dead front removed showing all breaker ratings.'), ['panel']);
  // Multi-label: one request, three asks — all three are kept.
  assert.deepEqual(
    cat('- site map showing location of utility meter\n- exact pitch measurements of all roof faces'),
    ['meter', 'where', 'roofMeas'],
  );
  assert.deepEqual(cat('Need attic photos. Dimensions of rafters and spacing.'), ['roofMeas', 'roofStruct']);
  assert.deepEqual(cat('Need existing module model and manufacturer'), ['existing']);
  assert.deepEqual(cat('Duplicate photos with another project. New site survey needed with Radicl.'), ['redo']);
  // Order follows RS_CATEGORIES, never the order the words appear in the text,
  // so two requests asking for the same things read the same way.
  assert.deepEqual(cat('roof pitch, and the dead front off'), cat('dead front off, and the roof pitch'));
});

test('rsCategories ignores the request template boilerplate', () => {
  // "INTERIOR ACCESS REQUIRED: No" is on 57% of requests and asks for nothing.
  // Left in, "access"/"required" and the header words classify every row.
  assert.deepEqual(rsCategories({
    resurvey_details: 'RESURVEY EXPLANATION:\nINTERIOR ACCESS REQUIRED: No\nREQUEST DETAILS:',
  }), []);
  // Blank and missing fields are unclassified, not guessed at from the picklist:
  // "Survey Incomplete" with no details is genuinely unknown.
  assert.deepEqual(rsCategories({ resurvey_details: '', resurvey_reason: 'Survey Incomplete' }), []);
  assert.deepEqual(rsCategories({}), []);
  assert.deepEqual(rsCategories(null), []);
});

test('rsCategories patterns are stateless and every key has a label', () => {
  // A /g flag makes test() stateful: the second row through would skip matches
  // from wherever the first left off, so a category would drop rows at random.
  RS_CATEGORIES.forEach(c => {
    assert.equal(c.re.global, false, `${c.key} pattern carries /g`);
    assert.ok(c.label && c.hint, `${c.key} is missing a label or hint`);
    assert.equal(rsCatLabel(c.key), c.label);
  });
  // Keys are unique — two categories sharing one would merge in every count.
  assert.equal(new Set(RS_CATEGORIES.map(c => c.key)).size, RS_CATEGORIES.length);
  // Repeat calls agree, which a stateful pattern would break on the second pass.
  const row = { resurvey_details: 'dead front off, plus the roof pitch' };
  assert.deepEqual(rsCategories(row), rsCategories(row));
  // Unknown key falls back to itself rather than rendering "undefined".
  assert.equal(rsCatLabel('nope'), 'nope');
});

// The real regression guard for the category patterns. The snapshot fixture
// cannot do this job: build-fixture.cjs redacts resurvey_details, because it is
// customer-written prose that should not be committed. So the corpus lives here
// instead — sentences written in the shape of real requests, no real addresses,
// names or account references, one per category plus the multi-ask cases that
// are the whole reason this is multi-label.
//
// Widening a pattern to catch a new phrasing is fine and expected. Widening one
// until it also claims a line that belongs to another category is the failure
// mode this catches, so add the new phrasing here at the same time.
const RS_CORPUS = [
  ['We need photos of the MSP with the dead front removed showing all breaker ratings and the max bus rating.', ['panel']],
  ['Photos of the meter/main combo with the deadfront off.', ['panel', 'meter']],
  ['Step back photos (10-15ft) of the utility meter, and a site map highlighting the main service panel location.', ['panel', 'meter', 'where']],
  ['There is a subpanel for the home that was not documented. Take photos of the breakers and their ratings.', ['panel', 'subs']],
  ['Need exact pitch measurements of all roof faces with a physical pitch tool, verify no face is under 10 or over 45.', ['roofMeas']],
  ['Need attic photos. Dimensions of rafters and spacing.', ['roofMeas', 'roofStruct']],
  ['Design needs confirmation of clay vs concrete tile on the rear roof plane.', ['roofStruct']],
  ['Need existing module model and manufacturer, plus the inverter count.', ['existing']],
  ['We also need clearance measurements of the battery location.', ['roofMeas', 'existing']],
  ['Photos of the generator panel with the dead front off to determine the interconnection method.', ['panel', 'subs']],
  ['Duplicate photos with another project. New site survey needed with Radicl.', ['redo']],
  ['The layout shows a different house and the survey photos appear to be from a different property.', ['redo']],
  ['We need structural photos of the outbuilding, including truss size and spacing.', ['roofStruct', 'redo']],
  ['Site map requested', ['where']],
];

test('rsCategories holds its reading of a frozen corpus of real request shapes', () => {
  const wrong = [];
  RS_CORPUS.forEach(([text, want]) => {
    const got = rsCategories({ resurvey_details: text });
    if (got.join(',') !== want.join(',')) wrong.push(`  "${text.slice(0, 58)}…"\n    want [${want}]\n    got  [${got}]`);
  });
  assert.deepEqual(wrong, [], `category rule drifted on ${wrong.length} case(s):\n${wrong.join('\n')}`);
});

test('every category is exercised by the corpus', () => {
  // A category with no case is a pattern nobody is checking — and one that has
  // silently stopped matching anything looks identical to one that is rare.
  const seen = new Set(RS_CORPUS.flatMap(([, want]) => want));
  const untested = RS_CATEGORIES.map(c => c.key).filter(k => !seen.has(k));
  assert.deepEqual(untested, [], `no corpus case for: ${untested.join(', ')}`);
});

test('fpy is completions-minus-defects over completions', () => {
  const clean = { complete: '2026-07-01', list: 'Complete' };
  const bad = { ...clean, resurvey_requested: '2026-07-05', resurvey_reason: 'Survey Incomplete' };
  assert.equal(fpy([clean, clean, clean, bad]), 75);
  assert.equal(fpy([clean]), 100);
  assert.equal(fpy([bad]), 0);
  // A dismissed request is not a defect, so it must not move yield.
  const dismissed = { ...bad, resurvey_reason: 'Unnecessary Request' };
  assert.equal(fpy([clean, dismissed]), 100);
});

test('fpy returns null on an empty set, never 0 or 100', () => {
  // "No completions in this range" is not "perfect yield" — every surface
  // renders null as an em-dash, and 0 would colour the card red.
  assert.equal(fpy([]), null);
  assert.equal(fpy(null), null);
  assert.equal(fpy(undefined), null);
});

test('fpy over a window is weighted, not a mean of weekly rates', () => {
  const clean = { complete: '2026-07-01', list: 'Complete' };
  const bad = { ...clean, resurvey_requested: '2026-07-05', resurvey_reason: 'Survey Incomplete' };
  // Two weeks: a 2-row week at 50% and a 98-row week at 100%.
  const thin = [clean, bad];
  const fat = Array.from({ length: 98 }, () => clean);
  // Averaging the two rates would say 75%. Pooling the rows says 99%, which is
  // what the rolling line on the Resurveys page must show.
  assert.equal((fpy(thin) + fpy(fat)) / 2, 75);
  assert.equal(fpy([...thin, ...fat]), 99);
});

test('isOpenResurvey needs list to have left Complete, not just a blank date', () => {
  const open = { resurvey_requested: '2026-07-01', resurvey_complete: '', list: 'Holding' };
  assert.equal(isOpenResurvey(open), true);
  // Resolved the normal way.
  assert.equal(isOpenResurvey({ ...open, resurvey_complete: '2026-07-05' }), false);
  // Resolved but the Resurvey Complete Date was never filled in — 18 real rows
  // look like this. Testing only the dates would count them as still open.
  assert.equal(isOpenResurvey({ ...open, list: 'Complete' }), false);
  // A resurvey that was never requested is not an open one.
  assert.equal(isOpenResurvey({ resurvey_requested: '', list: 'Holding' }), false);
  assert.equal(isOpenResurvey({}), false);
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
    { project_status: 'Cancelled',    start: '2026-06-01', sales_rep: 'G H' }, // inactive, not complete
  ];
  const out = filterRows(rows);
  assert.deepEqual(out.map(r => r.sales_rep), ['A B', 'C D']);
});

test('inScope keeps completed surveys regardless of project status, but not as WIP', () => {
  const atRiskDone = { project_status: 'At-Risk', start: '2026-07-15', complete: '2026-07-16', list: 'Complete' };
  const cancelledDone = { project_status: 'Cancelled', start: '2026-07-10', complete: '2026-07-12', list: 'Complete' };
  const atRiskOpen = { project_status: 'At-Risk', start: '2026-07-15', complete: '', list: 'Open' };
  assert.equal(inScope(atRiskDone), true);
  assert.equal(cancelledDone && inScope(cancelledDone), true);
  assert.equal(inScope(atRiskOpen), false); // never shows up as open WIP
  assert.equal(isWIP(atRiskDone), false);
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

// ── weekDaysRemaining: fractional days through Sunday, export day = half ──
test('weekDaysRemaining: export day counts as half, week runs through Sunday', () => {
  assert.equal(weekDaysRemaining('2026-07-13'), 6.5); // Monday
  assert.equal(weekDaysRemaining('2026-07-15'), 4.5); // Wednesday
  assert.equal(weekDaysRemaining('2026-07-17'), 2.5); // Friday
  assert.equal(weekDaysRemaining('2026-07-18'), 1.5); // Saturday
  assert.equal(weekDaysRemaining('2026-07-19'), 0.5); // Sunday — still projecting
});

// ── buildShowRates: measured per-resource, ≥5 sample floor, 0.9 fallback ──
test('buildShowRates measures completion within 1 day of scheduled date', () => {
  const mk = (sched, complete, resource) => ({ scheduled: sched, complete, resource });
  const rows = [
    // 6 Sales Rep rows: 4 hit (complete ≤ sched+1), 2 miss
    ...Array.from({ length: 4 }, () => mk('2026-07-01', '2026-07-01', 'Sales Rep')),
    mk('2026-07-01', '2026-07-05', 'Sales Rep'),
    mk('2026-07-01', '', 'Sales Rep'),
    // 2 Radicl rows — below the 5-sample floor, excluded from byResource
    mk('2026-07-02', '2026-07-02', 'Radicl Services'),
    mk('2026-07-02', '', 'Radicl Services'),
  ];
  const sr = buildShowRates(rows, '2026-07-16');
  assert.equal(Math.round(sr.byResource['Sales Rep'] * 100), 67); // 4/6
  assert.equal(sr.byResource['Radicl Services'], undefined);
  assert.equal(Math.round(sr.global * 100), 63); // 5/8
});

test('buildShowRates with no scheduled history falls back to 0.9 global', () => {
  const sr = buildShowRates([], '2026-07-16');
  assert.equal(sr.global, 0.9);
});

test('buildShowRates ignores schedules outside the trailing window', () => {
  const rows = [
    { scheduled: '2026-01-01', complete: '2026-01-01', resource: 'Sales Rep' }, // too old
    { scheduled: '2026-07-20', complete: '', resource: 'Sales Rep' },           // future
  ];
  const sr = buildShowRates(rows, '2026-07-16');
  assert.equal(sr.global, 0.9);
});

// ── buildExpectedCt: rep avg (≥3) → region|resource segment → global ──
test('buildExpectedCt prefers rep history for Sales Rep surveys', () => {
  const comps = [
    { resource: 'Sales Rep', sales_rep: 'Fast Rep', region: 'VA', ct_total: 1 },
    { resource: 'Sales Rep', sales_rep: 'Fast Rep', region: 'VA', ct_total: 1 },
    { resource: 'Sales Rep', sales_rep: 'Fast Rep', region: 'VA', ct_total: 1 },
    { resource: 'Radicl Services', region: 'VA', ct_total: 8 },
  ];
  const ct = buildExpectedCt(comps);
  assert.equal(ct({ resource: 'Sales Rep', sales_rep: 'Fast Rep', region: 'VA' }), 1);
  // Rep with <3 completions falls back to region|resource segment
  assert.equal(ct({ resource: 'Radicl Services', region: 'VA' }), 8);
  // Unknown segment falls back to global avg
  assert.equal(ct({ resource: 'SunPower Surveyor', region: 'ZZ' }), avg([1, 1, 1, 8]));
});

// ── Weekly projection (v2) — buildWeekdayShape / buildProjectionModel / projectWeek ──
// A synthetic book: 10 weeks of history, every survey a rep self-survey that
// starts Monday and completes Wednesday (cycle 2), plus one open row.
const _iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function _synthBook() {
  const rows = [];
  let id = 0;
  // Mondays 2026-06-01 … 2026-08-03 (Mon), each week 8 completed surveys
  const mondays = ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29',
    '2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03'];
  for (const mon of mondays) {
    const [y, m, d] = mon.split('-').map(Number);
    const wed = new Date(y, m - 1, d + 2);
    const wedISO = _iso(wed.getFullYear(), wed.getMonth() + 1, wed.getDate());
    for (let i = 0; i < 8; i++) {
      rows.push({ id: id++, start: mon, complete: wedISO, list: 'Complete',
        project_status: 'In Progress', resource: 'Sales Rep', region: 'VA Test' });
    }
  }
  return rows;
}

test('buildWeekdayShape: completions land on the modelled weekday', () => {
  const shape = buildWeekdayShape(_synthBook(), '2026-08-12', 8);
  assert.ok(shape.share[3] > 0.9, 'almost all completions are on Wednesday (getDay 3)');
  assert.equal(shape.share.reduce((a, b) => a + b, 0).toFixed(4), '1.0000');
});

test('buildProjectionModel: hazard is high for a fresh scheduled row, ~0 for a stale one', () => {
  const m = buildProjectionModel(_synthBook(), '2026-08-12', {});
  // synthetic rows all cleared inside their week at age 2 → the 0-3 open band
  // should carry a high weekly hazard, the 31+ band essentially none.
  assert.ok(m.hazOpen('Sales Rep', 0) > 0.5);
  assert.ok(m.hazOpen('Sales Rep', 4) < 0.2);
});

test('projectWeek: a finished week returns exactly its completions', () => {
  const book = _synthBook();
  // week of 2026-07-06 is fully in the past relative to 2026-08-12
  const r = projectWeek(book, '2026-07-06', '2026-08-12', { _noBacktest: true });
  assert.equal(r.point, 8);
  assert.equal(r.completedSoFar, 8);
  assert.equal(r.intake, 0);
});

test('projectWeek: mid-week point sits between done-so-far and a full week', () => {
  const book = _synthBook();
  book.push({ id: 999, start: '2026-08-10', list: 'In Progress', project_status: 'In Progress', resource: 'Sales Rep', region: 'VA Test' });
  // Wednesday 2026-08-12 of an in-progress week: nothing completed yet in it
  const r = projectWeek(book, '2026-08-10', '2026-08-12', { _noBacktest: true });
  assert.ok(r.point >= r.completedSoFar);
  assert.ok(r.lo == null || r.lo <= r.point);
  assert.ok(r.hi == null || r.hi >= r.point);
});

test('projectWeek: cacheKey memoises the result', () => {
  const book = _synthBook();
  const a = projectWeek(book, '2026-07-06', '2026-08-12', { cacheKey: 'k1' });
  const b = projectWeek(book, '2026-07-06', '2026-08-12', { cacheKey: 'k1' });
  assert.equal(a, b); // same object reference
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

// ── SS Ratio ──
test('wipOn counts Holding/Reopened rows as still open', () => {
  // a completion date alone is not done — list must be 'Complete' too
  const rows = [
    { start: '2026-07-01', complete: '2026-07-03', list: 'Complete' }, // done
    { start: '2026-07-01', complete: '2026-07-03', list: 'Holding' },  // still open
    { start: '2026-07-01', complete: '2026-07-03', list: 'Reopened' }, // still open
    { start: '2026-07-01', complete: '', list: 'Open' },               // still open
  ];
  assert.equal(wipOn(rows, '2026-07-05'), 3);
  assert.equal(wipOn(rows, '2026-07-02'), 4); // nothing finished yet
  assert.equal(wipOn(rows, '2026-06-30'), 0); // nothing started yet
});

test('meanWipForWeek averages the week, not the Sunday close', () => {
  // one row starts each day Mon-Sun, none complete: WIP runs 1..7, mean 4
  const rows = [];
  for (let d = 27; d <= 31; d++) rows.push({ start: `2026-07-${d}`, complete: '', list: 'Open' });
  rows.push({ start: '2026-08-01', complete: '', list: 'Open' });
  rows.push({ start: '2026-08-02', complete: '', list: 'Open' });
  assert.equal(wipOn(rows, '2026-08-02'), 7);      // Sunday close
  assert.equal(meanWipForWeek(rows, '2026-08-02'), 4); // (1+2+..+7)/7
});

test('avgWeeklyCompletions averages the 3 weeks ending at the anchor', () => {
  const mk = (iso) => ({ start: '2026-01-01', complete: iso, list: 'Complete' });
  const rows = [
    mk('2026-07-27'), mk('2026-07-29'), mk('2026-08-02'), // wk ending Aug 2 -> 3
    mk('2026-07-21'), mk('2026-07-26'),                   // wk ending Jul 26 -> 2
    mk('2026-07-15'),                                     // wk ending Jul 19 -> 1
    mk('2026-07-08'),                                     // 4 weeks back — excluded
  ];
  assert.equal(avgWeeklyCompletions(rows, '2026-08-02', 3), 2); // (3+2+1)/3
});

test('lastCompleteWeekEnd treats the containing week as partial', () => {
  assert.equal(lastCompleteWeekEnd('2026-08-03'), '2026-08-02'); // Mon -> prior Sun
  assert.equal(lastCompleteWeekEnd('2026-08-05'), '2026-08-02'); // Wed -> prior Sun
  assert.equal(lastCompleteWeekEnd('2026-08-02'), '2026-07-26'); // Sun itself is partial
});

test('ssRatio variants return null without completion history', () => {
  const rows = [{ start: '2026-07-01', complete: '', list: 'Open' }];
  assert.equal(ssRatioForWeek(rows, '2026-08-02'), null);
  assert.equal(ssRatioLive(rows, '2026-08-03'), null);
});

test('ssRatioBand: under a week good, 1-2 weeks uncoloured, 2+ is the alarm', () => {
  assert.equal(ssRatioBand(0.8), 'good');
  assert.equal(ssRatioBand(0.99), 'good');   // renders "1.0wk" — a week is fine
  assert.equal(ssRatioBand(1.0), 'good');
  assert.equal(ssRatioBand(1.16), 'normal'); // the Fri/Sat rhythm, not an alarm
  assert.equal(ssRatioBand(1.9), 'normal');
  assert.equal(ssRatioBand(1.95), 'normal'); // renders "1.9wk" — must match
  assert.equal(ssRatioBand(2.0), 'bad');
  assert.equal(ssRatioBand(2.5), 'bad');
  assert.equal(ssRatioBand(null), '');
});

test('clearanceAlarm needs two consecutive readings under 90%', () => {
  assert.equal(clearanceAlarm([0.99, 0.95, 0.89]), false);        // one dip
  assert.equal(clearanceAlarm([0.95, 0.89, 0.99]), false);        // recovered
  assert.equal(clearanceAlarm([0.95, 0.89, 0.83]), true);         // two running
  assert.equal(clearanceAlarm([0.89]), false);                    // too short
  assert.equal(clearanceAlarm([0.85, null]), false);              // null-safe
});

test('floorAlarm fires above 1.5x the trailing median', () => {
  const base = [40, 34, 50, 36, 46, 57, 40, 40]; // median 40
  assert.equal(floorAlarm([...base, 79], 8), true);   // 79 > 60
  assert.equal(floorAlarm([...base, 57], 8), false);  // 57 < 60
  assert.equal(floorAlarm([40, 79], 8), false);       // not enough history
  assert.equal(floorAlarm([...base, null], 8), false);// unknown current floor
});

test('bandFor bands on the displayed (1dp) value, not the raw one', () => {
  // avg() keeps 2dp: 4.04 renders "4.0d" and must not colour as a miss
  assert.equal(bandFor(4.04, 4), 'good');
  assert.equal(bandFor(4.05, 4), 'good'); // renders "4.0d" — toFixed rounds down
  assert.equal(bandFor(4.06, 4), 'mid');  // renders "4.1d" — a real miss
  assert.equal(bandFor(6.04, 4), 'mid');
  assert.equal(bandFor(6.05, 4), 'mid'); // renders "6.0d" — exactly target+2
  assert.equal(bandFor(6.06, 4), 'bad'); // renders "6.1d" — over the band
});

// ── queueAgeBand ──
test('queueAgeBand gives an open queue target+3 before it goes red', () => {
  // Distinct from bandFor's target+2: this bands how long something has been
  // OPEN, not how long a finished survey took.
  assert.equal(queueAgeBand(0, 4), 'good');
  assert.equal(queueAgeBand(4, 4), 'good');  // exactly target
  assert.equal(queueAgeBand(5, 4), 'mid');
  assert.equal(queueAgeBand(7, 4), 'mid');   // exactly target+3
  assert.equal(queueAgeBand(8, 4), 'bad');
  assert.equal(queueAgeBand(null, 4), '');
  // The bug this function exists to prevent: the amber cutoff must FOLLOW the
  // target, not sit on a literal 7. At targetAvg 3 the two old call sites gave
  // 7 and 6 respectively; both must now say 6.
  assert.equal(queueAgeBand(7, 3), 'bad');
  assert.equal(queueAgeBand(6, 3), 'mid');
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
