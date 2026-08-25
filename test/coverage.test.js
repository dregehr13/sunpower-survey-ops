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
