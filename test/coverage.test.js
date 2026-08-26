// test/coverage.test.js — geography and capacity definitions.
//
// Same discipline as metrics.test.js: every function gets hand-written cases,
// and the cases that exist because something was once wrong say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../lib/coverage.cjs');

const PDX = [45.482, -122.6445];      // Portland SE
const SILVERTON = [44.9395, -122.7207];
const DETROIT = [42.4975, -83.2306];

test('milesBetween: known separations', () => {
  // Portland to Silverton is about 40 miles as the crow flies.
  assert.ok(Math.abs(C.milesBetween(PDX, SILVERTON) - 39) < 3);
  // Coast to coast sanity: Portland to Detroit is roughly 1,950 miles.
  assert.ok(Math.abs(C.milesBetween(PDX, DETROIT) - 1954) < 40);
  assert.equal(C.milesBetween(PDX, PDX), 0);
  assert.equal(C.milesBetween(null, PDX), null);
  assert.equal(C.milesBetween(PDX, null), null);
});

const pt = (id, ll) => ({ id, ll });

test('clusterByRadius: every point lands in exactly one cluster', () => {
  const pts = [pt('a', [45.5, -122.6]), pt('b', [45.52, -122.62]), pt('c', [45.48, -122.58]),
               pt('d', [44.0, -121.3]), pt('e', [44.02, -121.32]), pt('f', [40.0, -75.0])];
  const cl = C.clusterByRadius(pts, 25);
  const seen = cl.flatMap(c => c.members.map(m => m.id)).sort();
  assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(new Set(seen).size, 6, 'no point may appear in two clusters');
});

test('clusterByRadius: no member sits further than the radius from its seed', () => {
  // The reason this is not DBSCAN. Chaining would run a continuous suburb
  // corridor into one cluster wider than a day of driving, which is not a
  // market however connected it is.
  const pts = [];
  for (let i = 0; i < 12; i++) pts.push(pt('p' + i, [45.0 + i * 0.15, -122.6]));  // a 10mi-spaced chain
  const cl = C.clusterByRadius(pts, 25);
  cl.forEach(c => {
    const seed = c.members.find(m => m === pts[c.seedIndex]) || c.members[0];
    c.members.forEach(m => {
      assert.ok(C.milesBetween(seed.ll, m.ll) <= 25 + 1e-9,
        `${m.id} is ${C.milesBetween(seed.ll, m.ll).toFixed(1)}mi from its seed`);
    });
  });
  assert.ok(cl.length > 1, 'a 110-mile chain must not collapse into one market');
});

test('clusterByRadius: densest seed wins, and the result is deterministic', () => {
  // Three tight points plus one loner. The tight group must be the first
  // cluster regardless of input order, or the map renames its markets between
  // renders and reads as a bug.
  const tight = [pt('t1', [45.50, -122.60]), pt('t2', [45.51, -122.61]), pt('t3', [45.49, -122.59])];
  const loner = pt('far', [43.0, -120.0]);
  const a = C.clusterByRadius([...tight, loner], 25);
  const b = C.clusterByRadius([loner, ...tight], 25);
  assert.equal(a[0].members.length, 3);
  assert.equal(b[0].members.length, 3);
  assert.deepEqual(a.map(c => c.members.length), b.map(c => c.members.length));
});

test('clusterByRadius: a wider radius never makes more clusters', () => {
  const pts = [];
  for (let i = 0; i < 30; i++) pts.push(pt('p' + i, [45 + (i % 6) * 0.2, -122 - Math.floor(i / 6) * 0.2]));
  const counts = C.RADIUS_CHOICES.map(r => C.clusterByRadius(pts, r).length);
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] <= counts[i - 1]);
});

test('clusterByRadius: ignores points with no location', () => {
  const cl = C.clusterByRadius([pt('a', PDX), { id: 'nowhere', ll: null }, null], 25);
  assert.deepEqual(cl.flatMap(c => c.members.map(m => m.id)), ['a']);
});

test('centroid and spreadMi describe the market, not its outliers', () => {
  const pts = [pt('a', [45.0, -122.0]), pt('b', [45.0, -122.0]), pt('c', [45.0, -122.0]),
               pt('d', [45.0, -122.0]), pt('e', [46.0, -122.0])];
  const c = C.centroid(pts);
  assert.ok(Math.abs(c[0] - 45.2) < 0.01, 'centroid follows the weight of the work');
  const s = C.spreadMi(pts, [45.0, -122.0]);
  assert.equal(s.p50, 0);
  assert.ok(s.max > 60, 'the far job still counts toward max');
  assert.equal(C.centroid([]), null);
});

test('jobsPerDay: three close in, fewer as the drive grows', () => {
  // Calibrated against Doug's own ceiling — three a day when the work is tight.
  assert.equal(C.jobsPerDay(2), 3);
  assert.equal(C.jobsPerDay(5), 3);
  assert.equal(C.jobsPerDay(60), 1);
  // Monotonic: a longer drive can never yield more work.
  let prev = Infinity;
  for (let mi = 0; mi <= 80; mi += 5) {
    const j = C.jobsPerDayExact(mi);
    assert.ok(j <= prev + 1e-9, `capacity rose between ${mi - 5} and ${mi} miles`);
    prev = j;
  }
});

test('weeklyCapacity multiplies the exact rate, not the floored one', () => {
  // The regression this exists for: flooring per day and then multiplying
  // charged a 2.9 job/day market as 10 a week when it runs about 14.5. The
  // leftover 0.9 is a real survey that lands every other day.
  const exact = C.jobsPerDayExact(10);
  assert.ok(exact > 2.8 && exact < 3.0);
  assert.equal(C.jobsPerDay(10), 2);
  assert.ok(C.weeklyCapacity(10) > 14, 'a week must not inherit the daily rounding');
  assert.equal(C.weeklyCapacity(10), Math.round(exact * 5 * 10) / 10);
});

test('weeklyCapacity scales with the days a surveyor actually works', () => {
  // Harry is off Sunday and Tuesday, Sam off Sunday and Monday — both 5 days,
  // but the roster is where that number comes from, not an assumption.
  const five = C.weeklyCapacity(15, { daysAvailable: 5 });
  const four = C.weeklyCapacity(15, { daysAvailable: 4 });
  assert.ok(Math.abs(four - five * 0.8) < 0.05);
});

test('dayBudget itemises to the whole day and never overruns it', () => {
  for (const mi of [2, 10, 25, 45, 60]) {
    const b = C.dayBudget(mi);
    const spent = b.overheadMinutes + b.commuteMinutes + b.hopMinutes
      + b.onSiteMinutes + b.adminMinutes + b.idleMinutes;
    assert.ok(Math.abs(spent - b.totalMinutes) < 1e-6, `day does not reconcile at ${mi}mi`);
    assert.ok(b.idleMinutes >= -1e-9, `day overruns at ${mi}mi`);
  }
});

test('surveyorConfig overrides only what it is given', () => {
  const c = C.surveyorConfig({ onSiteMinutes: 45 });
  assert.equal(c.onSiteMinutes, 45);
  assert.equal(c.avgSpeedMph, C.DEFAULT_SURVEYOR.avgSpeedMph);
  assert.deepEqual(C.surveyorConfig(), C.DEFAULT_SURVEYOR);
  assert.deepEqual(C.surveyorConfig(null), C.DEFAULT_SURVEYOR);
});

test('reachable respects a per-surveyor limit', () => {
  assert.equal(C.reachable(40), true);
  assert.equal(C.reachable(90), false);
  assert.equal(C.reachable(90, { maxOneWayMi: 120 }), true);
  assert.equal(C.reachable(null), false);
});

test('a tuned config moves capacity in the direction you would expect', () => {
  const faster = { onSiteMinutes: 60, adminMinutesPerJob: 15 };
  assert.ok(C.weeklyCapacity(25, faster) > C.weeklyCapacity(25));
  const slower = { fieldHoursPerDay: 6 };
  assert.ok(C.weeklyCapacity(25, slower) < C.weeklyCapacity(25));
});

test('clusterByRadius: the grid index returns exactly what all-pairs would', () => {
  // clusterByRadius buckets points into a lat/lon grid so it only measures
  // nearby pairs — 110ms of haversines down to 17ms on the live dataset. The
  // grid decides which pairs to MEASURE, never which are neighbours, so its
  // output has to match a brute-force run exactly. A cell sizing mistake would
  // silently drop neighbours near a cell edge and split a market in two.
  const bruteForce = (pts, R) => {
    const n = pts.length;
    const nbr = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        if (C.milesBetween(pts[i].ll, pts[j].ll) <= R) { nbr[i].push(j); nbr[j].push(i); }
    const taken = new Array(n).fill(false);
    const deg = nbr.map(a => a.length);
    const out = [];
    let left = n;
    while (left > 0) {
      let seed = -1, best = -1;
      for (let i = 0; i < n; i++) { if (!taken[i] && deg[i] > best) { best = deg[i]; seed = i; } }
      if (seed < 0) break;
      const members = [seed, ...nbr[seed].filter(j => !taken[j])];
      members.forEach(j => { taken[j] = true; left--; nbr[j].forEach(k => { if (!taken[k]) deg[k]--; }); });
      out.push(members.map(j => pts[j].id).sort());
    }
    return out;
  };

  // A spread that crosses cell boundaries at several latitudes, plus pairs
  // deliberately placed just inside and just outside the radius.
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pts = [];
  for (let i = 0; i < 400; i++) {
    pts.push({ id: 'p' + i, ll: [32 + rand() * 16, -124 + rand() * 50] });
  }
  // Dense knots so seeds have real competition.
  for (let k = 0; k < 6; k++) {
    const base = [34 + k * 2.5, -118 + k * 8];
    for (let i = 0; i < 20; i++) pts.push({ id: `k${k}_${i}`, ll: [base[0] + rand() * 0.4, base[1] + rand() * 0.4] });
  }
  for (const R of C.RADIUS_CHOICES) {
    const fast = C.clusterByRadius(pts, R).map(c => c.members.map(m => m.id).sort());
    assert.deepEqual(fast, bruteForce(pts, R), `grid and all-pairs disagree at radius ${R}`);
  }
});

// ── Roster and reach ───────────────────────────────────────────────────────
test('daysAvailable reads the roster, it does not assume five', () => {
  assert.equal(C.daysAvailable({ off: ['Sun', 'Sat'] }), 5);
  assert.equal(C.daysAvailable({ off: ['Sun', 'Tue'] }), 5);   // Harry: midweek, still five
  assert.equal(C.daysAvailable({ off: [] }), 7);
  assert.equal(C.daysAvailable({}), 7);
  assert.equal(C.daysAvailable(null), 7);
});

test('reach is three classes, because a posting is a real option', () => {
  assert.equal(C.reachClass(30), C.REACH.DAY);
  assert.equal(C.reachClass(200), C.REACH.DEPLOY);
  assert.equal(C.reachClass(900), C.REACH.FAR);
  assert.equal(C.reachClass(null), C.REACH.FAR);
  // A surveyor with a wider day radius pulls a market back into day range.
  assert.equal(C.reachClass(90, { maxOneWayMi: 120 }), C.REACH.DAY);
});

test('nearestBase picks the closest base and classifies the trip', () => {
  const bases = [{ id: 'pdx', ll: [45.482, -122.6445] }, { id: 'det', ll: [42.4975, -83.2306] }];
  const n = C.nearestBase([45.52, -122.68], bases);
  assert.equal(n.base.id, 'pdx');
  assert.ok(n.miles < 5);
  assert.equal(n.reach, C.REACH.DAY);
  assert.equal(C.nearestBase([45.5, -122.6], []), null);
});

// ── Mobility ───────────────────────────────────────────────────────────────
const wkOf = d => d;  // the test data is already keyed by week
const spray = (wk, center, spreadDeg, n, office) =>
  Array.from({ length: n }, (_, i) => ({
    office, date: wk,
    ll: [center[0] + ((i % 5) - 2) * spreadDeg, center[1] + ((i % 3) - 1) * spreadDeg],
  }));

test('mobility: a wide territory worked in place is NOT mobile', () => {
  // The false positive that killed mean-weekly-drift. An office selling across
  // 200 miles of one valley every week jitters its centroid enormously and has
  // not gone anywhere. Live case: Movement - Summit (OR), 213mi net across a
  // 297mi-wide footprint.
  const pts = [];
  ['2026-01-04', '2026-01-11', '2026-01-18', '2026-01-25', '2026-02-01', '2026-02-08'].forEach((wk, i) => {
    pts.push(...spray(wk, i % 2 ? [45.5, -122.6] : [42.3, -122.9], 0.3, 6, 'wide'));
  });
  const m = C.officeMobility(pts, wkOf);
  assert.equal(m.wide.mobile, false, 'jittering inside a fixed footprint is dispersion, not relocation');
});

test('mobility: a footprint that relocates IS mobile', () => {
  // The false negative that killed straightness. This office wanders widely at
  // each end, so its path is long relative to its net move — but the early and
  // late footprints do not overlap. Live case: "Solar's Dead" - CTRL, which
  // went Pennsylvania to Virginia and scored 0.26 on straightness.
  const pts = [];
  ['2026-05-03', '2026-05-10', '2026-05-17', '2026-05-24'].forEach((wk, i) => {
    pts.push(...spray(wk, [39.9 + (i % 2) * 0.4, -76.7 - (i % 2) * 0.5], 0.25, 6, 'movers'));
  });
  ['2026-07-12', '2026-07-19', '2026-07-26', '2026-08-02'].forEach((wk, i) => {
    pts.push(...spray(wk, [37.5 + (i % 2) * 0.4, -78.5 - (i % 2) * 0.5], 0.25, 6, 'movers'));
  });
  const m = C.officeMobility(pts, wkOf);
  assert.equal(m.movers.mobile, true);
  assert.ok(m.movers.reloc >= C.MOBILITY_RELOC);
  assert.ok(m.movers.net >= C.MOBILITY_MIN_NET_MI);
});

test('mobility: a scattered national book is not a moving crew', () => {
  // Live case: Virtual Region - Virtual Closers, 56mi net across a 1,673mi
  // width. Enormous spread, no relocation.
  const pts = [];
  ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].forEach(wk => {
    pts.push(...spray(wk, [40, -100], 8, 8, 'national'));
  });
  const m = C.officeMobility(pts, wkOf);
  assert.equal(m.national.mobile, false);
});

test('mobility: too little history answers "do not know", not "settled"', () => {
  const pts = [...spray('w1', [40, -75], 0.2, 6, 'new'), ...spray('w2', [40, -75], 0.2, 6, 'new')];
  const m = C.officeMobility(pts, wkOf);
  assert.equal(m.new.mobile, false);
  assert.equal(m.new.reloc, null, 'a null reading is not the same as a settled one');
  // Thin weeks never contribute a centroid at all.
  const thin = C.officeMobility(spray('w1', [40, -75], 0.2, 2, 'thin'), wkOf);
  assert.equal(thin.thin.weeks, 0);
});

test('mobileShare ignores rows with no office rather than assuming settled', () => {
  const mob = { movers: { mobile: true }, settled: { mobile: false } };
  const pts = [{ office: 'movers' }, { office: 'movers' }, { office: 'settled' }, { office: '' }];
  assert.ok(Math.abs(C.mobileShare(pts, mob) - 2 / 3) < 1e-9);
  assert.equal(C.mobileShare([{ office: '' }], mob), 0);
});

// ── Advice ─────────────────────────────────────────────────────────────────
const mkt = (o = {}) => ({ n: 40, recentPerWeek: 5, outsourcedPerWeek: 3, reach: C.REACH.DAY,
  mobileShare: 0, repShare: 0.3, repDefectRate: 0.1, repDone: 30,
  baseName: 'Portland', baseMiles: 20, ...o });

test('advice: reachable work going outside the team is absorbed', () => {
  const a = C.marketAdvice(mkt());
  assert.equal(a.k, 'absorb');
  assert.ok(a.reasons.some(r => /Portland/.test(r)));
});

test('advice: a market built on a moving crew is never a local hire', () => {
  // The whole point of measuring mobility. Volume alone would say "hire".
  const a = C.marketAdvice(mkt({ mobileShare: 0.95, outsourcedPerWeek: 20, recentPerWeek: 25, reach: C.REACH.DEPLOY }));
  assert.equal(a.k, 'deploy');
  assert.ok(a.reasons.some(r => /footprint moves/.test(r)));
  // And if the moving crew is not producing much, it is not even worth a posting.
  assert.equal(C.marketAdvice(mkt({ mobileShare: 0.95, recentPerWeek: 1, outsourcedPerWeek: 1 })).k, 'vendor');
});

test('advice: a market with no recent work gets no recommendation at all', () => {
  // The flaw this exists for: rates averaged over eight months kept PA York
  // recommended for a posting on volume whose sales crew had already left the
  // state in July. A market with nothing in the window is its own answer —
  // "gone quiet" — not a staffing call made on history.
  const a = C.marketAdvice(mkt({ recentPerWeek: 0, outsourcedPerWeek: 0, n: 215 }));
  assert.equal(a.k, 'dormant');
  assert.ok(a.reasons[0].includes('215 historically'));
  // Dormancy outranks every other signal, including a big mobile book.
  assert.equal(C.marketAdvice(mkt({ recentPerWeek: 0, outsourcedPerWeek: 30, mobileShare: 1 })).k, 'dormant');
});

test('advice: a thin sample never carries a coaching call', () => {
  // At 5 completions one defect is 20% and would name an office off noise.
  const thin = mkt({ reach: C.REACH.FAR, outsourcedPerWeek: 0.5, recentPerWeek: 3,
    repShare: 0.9, repDefectRate: 0.4, repDone: 5 });
  assert.equal(C.marketAdvice(thin).k, 'vendor');
  assert.equal(C.marketAdvice({ ...thin, repDone: C.COACH_MIN_N }).k, 'coach');
});

test('advice: durable out-of-reach volume justifies a local hire', () => {
  const a = C.marketAdvice(mkt({ reach: C.REACH.FAR, outsourcedPerWeek: 12, recentPerWeek: 14 }));
  assert.equal(a.k, 'hire');
});

test('advice: a rep quality problem is coaching, not headcount', () => {
  const a = C.marketAdvice(mkt({ reach: C.REACH.FAR, outsourcedPerWeek: 0.5, recentPerWeek: 8,
    repShare: 0.9, repDefectRate: 0.23, repDone: 40 }));
  assert.equal(a.k, 'coach');
  assert.ok(a.reasons.some(r => /training, not headcount/.test(r)));
});

test('advice: thin markets stay with the vendor', () => {
  assert.equal(C.marketAdvice(mkt({ reach: C.REACH.FAR, recentPerWeek: 0.4, outsourcedPerWeek: 0.4, repShare: 0 })).k, 'vendor');
});

test('advice always returns a labelled recommendation with at least one reason', () => {
  const cases = [mkt(), mkt({ mobileShare: 1 }), mkt({ reach: C.REACH.FAR }), mkt({ reach: C.REACH.DEPLOY }),
    mkt({ outsourcedPerWeek: 0, repShare: 1, repDefectRate: 0.5 }), mkt({ recentPerWeek: 0, outsourcedPerWeek: 0 })];
  cases.forEach(c => {
    const a = C.marketAdvice(c);
    assert.ok(a.label && a.k && a.rank, 'every recommendation is labelled and ranked');
    assert.ok(a.reasons.length >= 1, 'a recommendation with no reason is not actionable');
  });
});

// ── Intake trend ───────────────────────────────────────────────────────────
// The one leading indicator in the data: is more work arriving from here, or
// is this market emptying out? Three windows, because two cannot tell those
// apart — see the note on intakeTrend().

// Dates n days before the fixed "export date" every case below anchors on.
const AS_OF = '2026-08-26';
const ago = n => {
  const d = new Date(2026, 7, 26); d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// `counts` is [oldest window, middle, newest]; each job lands mid-window so no
// case rests on which side of an edge a boundary date falls.
const intake = counts => counts.flatMap((n, i) => Array.from({ length: n }, () => ago(14 + (2 - i) * 28)));

test('intakeTrend: three windows, oldest first', () => {
  const t = C.intakeTrend(intake([5, 10, 20]), AS_OF);
  assert.deepEqual(t.windows, [5, 10, 20]);
});

test('intakeTrend: a crew arriving and a crew leaving are not the same shape', () => {
  // The Virginia and Pennsylvania readings that motivated three windows.
  const va = C.intakeTrend(intake([6, 201, 179]), AS_OF);
  const pa = C.intakeTrend(intake([220, 39, 23]), AS_OF);
  assert.equal(va.k, 'steady');
  assert.equal(pa.k, 'slowing');
  // Two windows would have scored them alike; the oldest window is what separates them.
  assert.ok(va.windows[0] < va.windows[1] && pa.windows[0] > pa.windows[1]);
});

test('intakeTrend: growing and slowing sit outside the band, steady inside it', () => {
  assert.equal(C.intakeTrend(intake([0, 20, 40]), AS_OF).k, 'growing');
  assert.equal(C.intakeTrend(intake([0, 40, 20]), AS_OF).k, 'slowing');
  assert.equal(C.intakeTrend(intake([0, 20, 22]), AS_OF).k, 'steady');
  // Exactly on the band edge counts as a direction, not as steady.
  assert.equal(C.intakeTrend(intake([0, 20, 25]), AS_OF).k, 'growing');
});

test('intakeTrend: nothing arriving is quiet at any sample size', () => {
  // Tested before the thinness guard on purpose: "no work came in" is knowable
  // from one job, unlike a direction.
  assert.equal(C.intakeTrend(intake([200, 40, 0]), AS_OF).k, 'quiet');
  assert.equal(C.intakeTrend(intake([1, 0, 0]), AS_OF).k, 'quiet');
  assert.equal(C.intakeTrend([], AS_OF).k, 'quiet');
});

test('intakeTrend: a thin sample names no direction but still reports its shape', () => {
  const t = C.intakeTrend(intake([1, 4, 2]), AS_OF);   // the live Ohio reading
  assert.equal(t.k, 'thin');
  assert.equal(t.label, '');
  assert.equal(t.pct, null);
  assert.deepEqual(t.windows, [1, 4, 2], 'the bars still render — thinness is shown, not hidden');
});

test('intakeTrend: "just opened" needs a real sample, not one job against nothing', () => {
  assert.equal(C.intakeTrend(intake([0, 0, 18]), AS_OF).k, 'new');
  assert.equal(C.intakeTrend(intake([0, 0, 1]), AS_OF).k, 'thin');
});

test('intakeTrend: anchored on the export date, not the wall clock', () => {
  // The same jobs read as current against their own export and quiet against a
  // later one — the rule that stops a stale upload emptying every market.
  const jobs = intake([0, 10, 30]);
  assert.equal(C.intakeTrend(jobs, AS_OF).k, 'growing');
  assert.equal(C.intakeTrend(jobs, '2026-12-01').k, 'quiet');
});

test('intakeTrend: dates after the export date are ignored', () => {
  const t = C.intakeTrend([...intake([0, 20, 20]), '2027-01-01', '2027-02-01'], AS_OF);
  assert.deepEqual(t.windows, [0, 20, 20]);
});
