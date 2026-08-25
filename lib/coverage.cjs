// lib/coverage.cjs — geography and capacity definitions.
//
// Separate from metrics.cjs on purpose. That file answers "how is the survey
// work going"; this one answers "who should be doing it and can they reach it".
// The two never share a definition, so keeping them apart costs nothing and
// keeps metrics.cjs about surveys.
//
// Loaded by index.html (Map + Resource pages) the same UMD way metrics.cjs is.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpsCoverage = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // ── Distance ─────────────────────────────────────────────────────────────
  // Great-circle miles. Every distance in this file is straight-line, never
  // road miles: the app has no routing service and inventing one from a
  // detour factor would dress a guess as a measurement. The capacity model
  // applies ROAD_FACTOR once, in the open, where it can be read and argued
  // with — see driveMinutes().
  const EARTH_MI = 3958.8;
  const toRad = d => d * Math.PI / 180;
  function milesBetween(a, b) {
    if (!a || !b) return null;
    const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_MI * Math.asin(Math.sqrt(h));
  }

  // ── Market clustering ────────────────────────────────────────────────────
  // Grouping by town made 833 places out of 2,446 jobs, 470 of them a single
  // job — a map of postal names, not of markets. A market here is instead
  // "everything one surveyor could reach from one base", which is a radius.
  //
  // Greedy densest-seed: repeatedly take the unassigned point with the most
  // unassigned neighbours within RADIUS, claim its neighbourhood, remove it.
  // Deterministic given a stable input order (ties break on first-seen), which
  // matters because the map re-clusters on every filter change and a cluster
  // that renamed itself between renders would read as a bug.
  //
  // It is not k-means: k-means needs k up front, and the question here has no
  // k — it is "how many bases would it take", which is the ANSWER. Nor is it
  // DBSCAN: chaining would run Philadelphia into Pottstown into Allentown
  // along a continuous suburb corridor, and a cluster wider than a day's
  // driving is not a market no matter how connected it is.
  const DEFAULT_RADIUS_MI = 25;
  const RADIUS_CHOICES = [15, 25, 35];

  function clusterByRadius(points, radiusMi) {
    const R = radiusMi || DEFAULT_RADIUS_MI;
    const pts = points.filter(p => p && p.ll);
    const n = pts.length;
    if (!n) return [];

    // Neighbour lists, built through a lat/lon grid rather than by comparing
    // every pair. The naive version was 3M haversines and 110ms on the live
    // dataset, which the map cannot afford when it re-clusters on every filter
    // change. The grid only decides WHICH pairs to measure — membership is
    // still settled by exact haversine below, so the output is identical to
    // the all-pairs version.
    //
    // Cell height is R miles of latitude. Cell width uses the highest latitude
    // present, where a degree of longitude is shortest: that makes every cell
    // at least R miles wide everywhere in the data, so a point's neighbours
    // are always inside the 3x3 block around it and none are missed.
    const MI_PER_DEG_LAT = 69;
    let maxAbsLat = 0;
    for (const p of pts) maxAbsLat = Math.max(maxAbsLat, Math.abs(p.ll[0]));
    const cosMin = Math.max(Math.cos(toRad(Math.min(maxAbsLat, 89))), 0.01);
    const cellLat = R / MI_PER_DEG_LAT;
    const cellLon = R / (MI_PER_DEG_LAT * cosMin);
    const grid = new Map();
    const cellOf = p => (Math.floor(p.ll[0] / cellLat)) + ':' + (Math.floor(p.ll[1] / cellLon));
    for (let i = 0; i < n; i++) {
      const k = cellOf(pts[i]);
      let b = grid.get(k); if (!b) { b = []; grid.set(k, b); }
      b.push(i);
    }
    const nbr = new Array(n);
    for (let i = 0; i < n; i++) nbr[i] = [];
    for (let i = 0; i < n; i++) {
      const gy = Math.floor(pts[i].ll[0] / cellLat), gx = Math.floor(pts[i].ll[1] / cellLon);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const b = grid.get((gy + dy) + ':' + (gx + dx));
          if (!b) continue;
          for (const j of b) {
            if (j <= i) continue;   // each pair once
            if (milesBetween(pts[i].ll, pts[j].ll) <= R) { nbr[i].push(j); nbr[j].push(i); }
          }
        }
      }
    }

    const taken = new Array(n).fill(false);
    const deg = nbr.map(a => a.length);
    const out = [];
    let left = n;
    while (left > 0) {
      let seed = -1, best = -1;
      for (let i = 0; i < n; i++) {
        if (taken[i]) continue;
        if (deg[i] > best) { best = deg[i]; seed = i; }
      }
      if (seed < 0) break;
      const members = [seed, ...nbr[seed].filter(j => !taken[j])];
      members.forEach(j => {
        taken[j] = true; left--;
        nbr[j].forEach(k => { if (!taken[k]) deg[k]--; });
      });
      out.push({ seed: pts[seed], seedIndex: seed, members: members.map(j => pts[j]) });
    }
    return out;
  }

  // A cluster's centre of gravity — where a base would sit to minimise travel.
  // Job-weighted, so a market's centre follows the work rather than the
  // geographic midpoint of its outline.
  function centroid(points) {
    const p = points.filter(x => x && x.ll);
    if (!p.length) return null;
    return [p.reduce((s, x) => s + x.ll[0], 0) / p.length,
            p.reduce((s, x) => s + x.ll[1], 0) / p.length];
  }

  // How far the market actually reaches from its own centre. p90 rather than
  // max: one job three hours out should not describe the market, but it
  // should not be silently dropped from the drive math either.
  function spreadMi(points, center) {
    const c = center || centroid(points);
    if (!c) return null;
    const ds = points.filter(p => p && p.ll).map(p => milesBetween(p.ll, c)).sort((a, b) => a - b);
    if (!ds.length) return null;
    return { p50: ds[Math.floor(ds.length * 0.5)], p90: ds[Math.floor(ds.length * 0.9)], max: ds[ds.length - 1] };
  }

  // ── Capacity ─────────────────────────────────────────────────────────────
  // "Three a day if they are close, fewer with travel" as an explicit budget.
  // The point of writing it as a budget rather than a lookup is that every
  // capacity number the page prints decomposes back into named minutes, so a
  // number you disagree with can be argued with knob by knob instead of
  // wholesale.
  //
  // The day, in order:
  //   dailyOverheadMinutes   staging, dispatch, end-of-day close-out
  //   drive out + drive back  once each, to and from the market
  //   per job: onSiteMinutes + adminMinutesPerJob, and a hop between jobs
  //
  // Defaults are calibrated so a tight market lands on 3 jobs/day, which is
  // the observed ceiling, not a theoretical one. They are defaults, not
  // findings — every one is overridable per surveyor.
  //
  // ROAD_FACTOR converts straight-line miles to road miles; 1.3 is the usual
  // US metro planning figure. It is a stated assumption, not a measurement,
  // and it lives in one named place so it can be challenged once rather than
  // being buried in four multiplications.
  const ROAD_FACTOR = 1.3;
  const DEFAULT_SURVEYOR = {
    fieldHoursPerDay: 8,
    dailyOverheadMinutes: 60,   // staging, dispatch, close-out
    onSiteMinutes: 90,          // measure, photograph, verify
    adminMinutesPerJob: 30,     // write-up, upload, QA
    avgSpeedMph: 38,            // door-to-door metro average, not highway cruise
    hopMi: 8,                   // typical distance between jobs inside a market
    maxOneWayMi: 60,            // past this it stops being a day trip
    daysAvailable: 5,
  };

  function surveyorConfig(partial) { return { ...DEFAULT_SURVEYOR, ...(partial || {}) }; }

  // Minutes to drive `mi` straight-line miles, one way.
  function driveMinutes(mi, cfg) {
    const c = surveyorConfig(cfg);
    if (mi == null) return null;
    return (mi * ROAD_FACTOR) / Math.max(c.avgSpeedMph, 1) * 60;
  }

  // How many jobs fit in a day, unrounded. `oneWayMi` is the distance from
  // base to the market being worked.
  function jobsPerDayExact(oneWayMi, cfg) {
    const c = surveyorConfig(cfg);
    if (oneWayMi == null) return null;
    const budget = c.fieldHoursPerDay * 60 - c.dailyOverheadMinutes;
    const commute = driveMinutes(oneWayMi, c) * 2;          // out and back, once
    const hop = driveMinutes(c.hopMi, c);                   // between jobs
    const perJob = c.onSiteMinutes + c.adminMinutesPerJob + hop;
    // The first job carries no hop before it, so credit one hop back.
    return Math.max((budget - commute + hop) / perJob, 0);
  }

  // What a single day looks like: a whole number, because a half survey is not
  // a thing you can schedule.
  //
  // The fraction is NOT discarded — weeklyCapacity() multiplies the exact rate
  // instead of this one. Flooring per day and then multiplying charged a 2.9
  // job/day market as 10 a week when it really runs about 14.5: the leftover
  // 0.9 is a real survey that lands every other day, and rounding it away
  // understated close-in markets by a third.
  function jobsPerDay(oneWayMi, cfg) {
    const x = jobsPerDayExact(oneWayMi, cfg);
    return x == null ? null : Math.floor(x);
  }

  // The same day, itemised — what the page shows when you ask why a market
  // costs what it does.
  function dayBudget(oneWayMi, cfg) {
    const c = surveyorConfig(cfg);
    const jobs = jobsPerDay(oneWayMi, c);
    const commute = driveMinutes(oneWayMi, c) * 2;
    const hop = driveMinutes(c.hopMi, c);
    const hops = Math.max(jobs - 1, 0) * hop;
    return {
      jobs,
      totalMinutes: c.fieldHoursPerDay * 60,
      overheadMinutes: c.dailyOverheadMinutes,
      commuteMinutes: commute,
      hopMinutes: hops,
      onSiteMinutes: jobs * c.onSiteMinutes,
      adminMinutes: jobs * c.adminMinutesPerJob,
      get idleMinutes() {
        return this.totalMinutes - this.overheadMinutes - this.commuteMinutes
          - this.hopMinutes - this.onSiteMinutes - this.adminMinutes;
      },
    };
  }

  // Weekly capacity for one surveyor working a market at `oneWayMi`. Built on
  // the exact daily rate, then rounded once at the end — see jobsPerDay().
  function weeklyCapacity(oneWayMi, cfg) {
    const c = surveyorConfig(cfg);
    const perDay = jobsPerDayExact(oneWayMi, c);
    return perDay == null ? null : Math.round(perDay * c.daysAvailable * 10) / 10;
  }

  // Can this surveyor reach this market as day trips at all?
  function reachable(mi, cfg) {
    const c = surveyorConfig(cfg);
    return mi != null && mi <= c.maxOneWayMi;
  }

  return { EARTH_MI, milesBetween, DEFAULT_RADIUS_MI, RADIUS_CHOICES, clusterByRadius,
    centroid, spreadMi, ROAD_FACTOR, DEFAULT_SURVEYOR, surveyorConfig,
    driveMinutes, jobsPerDayExact, jobsPerDay, dayBudget, weeklyCapacity, reachable };
});
