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

  // ── Roster ───────────────────────────────────────────────────────────────
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // Days worked comes off the roster's `off` list rather than being assumed at
  // five. All four surveyors happen to work five days, but two of them are off
  // midweek rather than at the weekend, which matters the moment a market
  // needs covering on a particular day.
  function daysAvailable(surveyor) {
    const off = (surveyor && surveyor.off) || [];
    return DAYS.filter(d => !off.includes(d)).length;
  }
  function surveyorCfg(surveyor) {
    return surveyorConfig({ ...(surveyor && surveyor.capacity), daysAvailable: daysAvailable(surveyor) });
  }

  // ── Reach ────────────────────────────────────────────────────────────────
  // Three classes, not a yes/no. Doug can post a surveyor into a market for a
  // week or two, so "too far to drive daily" and "unreachable" are different
  // answers with different actions behind them.
  const REACH = { DAY: 'day', DEPLOY: 'deploy', FAR: 'far' };
  const DEPLOY_MAX_MI = 600;   // beyond this a temporary posting is a relocation
  function reachClass(mi, cfg) {
    if (mi == null) return REACH.FAR;
    if (reachable(mi, cfg)) return REACH.DAY;
    return mi <= DEPLOY_MAX_MI ? REACH.DEPLOY : REACH.FAR;
  }
  function nearestBase(ll, bases, cfgFor) {
    let best = null, bd = Infinity;
    (bases || []).forEach(b => {
      if (!b.ll) return;
      const d = milesBetween(ll, b.ll);
      if (d != null && d < bd) { bd = d; best = b; }
    });
    if (!best) return null;
    return { base: best, miles: bd, reach: reachClass(bd, cfgFor ? cfgFor(best) : null) };
  }

  // ── Volume mobility ──────────────────────────────────────────────────────
  // Does a sales office's footprint MOVE, or is it just wide? A market built
  // on a crew that relocates is not a market you hire into — it is one you
  // post someone into for a fortnight. Derived from the data, never a named
  // list of offices.
  //
  // Two measures were tried and rejected, both instructive:
  //
  //   Mean weekly centroid drift measures DISPERSION, not movement. An Oregon
  //   office selling Portland to Medford every week jitters its centroid
  //   153mi and never goes anywhere, while the org that genuinely moved from
  //   Pennsylvania to Virginia scored 78 because its weekly hops average out.
  //
  //   Straightness (net displacement over path walked) fixes the false
  //   positives and introduces a false negative on the one case that matters:
  //   that same PA-to-VA org reads 0.26, because it worked a wide territory at
  //   each end and the wandering swamps the move.
  //
  // What actually separates them is whether the EARLY and LATE footprints
  // overlap. Split the weeks in half, take each half's centroid and its own
  // radius, and ask whether the two centres are further apart than the halves
  // are wide. Above 1 the office was somewhere else by the end; below it, the
  // office worked one territory the whole time however large that territory is.
  const MOBILITY_MIN_WEEK = 4;     // jobs in a week before its centroid counts
  const MOBILITY_MIN_WEEKS = 4;    // weeks before the halves mean anything
  const MOBILITY_RELOC = 1.0;      // half-separation over half-width
  const MOBILITY_MIN_NET_MI = 40;  // and it has to be a real distance, not a tight cluster drifting

  function officeMobility(points, weekOf) {
    const byOffice = new Map();
    points.forEach(p => {
      if (!p.ll || !p.office || !p.date) return;
      const wk = weekOf(p.date);
      let o = byOffice.get(p.office); if (!o) { o = new Map(); byOffice.set(p.office, o); }
      let w = o.get(wk); if (!w) { w = []; o.set(wk, w); }
      w.push(p);
    });
    const out = {};
    byOffice.forEach((weeks, office) => {
      const ordered = [...weeks.entries()]
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .filter(([, pts]) => pts.length >= MOBILITY_MIN_WEEK);
      if (ordered.length < MOBILITY_MIN_WEEKS) {
        out[office] = { reloc: null, net: null, width: null, weeks: ordered.length, mobile: false };
        return;
      }
      const mid = Math.floor(ordered.length / 2);
      const early = ordered.slice(0, mid).flatMap(([, pts]) => pts);
      const late = ordered.slice(mid).flatMap(([, pts]) => pts);
      const ec = centroid(early), lc = centroid(late);
      const net = milesBetween(ec, lc);
      // Each half's own radius: p50 distance from its centre. Median rather
      // than mean so one outlying sale cannot widen a half into "settled".
      const es = spreadMi(early, ec), ls = spreadMi(late, lc);
      const width = ((es ? es.p50 : 0) + (ls ? ls.p50 : 0)) || 1;
      const reloc = net / width;
      out[office] = {
        reloc, net, width, weeks: ordered.length,
        from: ordered[0][0], to: ordered[ordered.length - 1][0],
        mobile: reloc >= MOBILITY_RELOC && net >= MOBILITY_MIN_NET_MI,
      };
    });
    return out;
  }

  // What share of a market's volume comes from sales offices whose footprint
  // is moving. Rows with no office are excluded rather than assumed settled.
  function mobileShare(points, mobility) {
    const withOffice = points.filter(p => p.office);
    if (!withOffice.length) return 0;
    return withOffice.filter(p => mobility[p.office] && mobility[p.office].mobile).length / withOffice.length;
  }

  // ── What to do about a market ────────────────────────────────────────────
  // One recommendation per market, from five facts: is the market still live,
  // can we reach it, is there enough work to be worth a body, is that work
  // durable, and who is doing it badly today. Deliberately a small set of named
  // recommendations — a page that emits a paragraph per market is read once.
  //
  // Called RECOMMENDATIONS, not ACTIONS (renamed 2026-08-26, Doug's ask). The
  // page never takes an action; it makes a case and the manager decides. The
  // old name had the table promising more certainty than the rules behind it
  // carry — the same reason the Billing page words every exception as a prompt
  // to check rather than as a verdict.
  const RECOMMENDATIONS = {
    ABSORB:  { k: 'absorb',  label: 'Absorb now',        rank: 1 },
    DEPLOY:  { k: 'deploy',  label: 'Deploy 1–2 weeks',  rank: 2 },
    HIRE:    { k: 'hire',    label: 'Hire locally',      rank: 3 },
    COACH:   { k: 'coach',   label: 'Coach the reps',    rank: 4 },
    VENDOR:  { k: 'vendor',  label: 'Leave with vendor', rank: 5 },
    DORMANT: { k: 'dormant', label: 'Gone quiet',        rank: 6 },
  };
  // Thresholds. HIRE_WEEKLY sits near a full week's capacity: a fixed hire has
  // to be justified by work that arrives every week, not by a good month.
  // DEPLOY_WEEKLY is lower because a posting is reversible.
  const HIRE_WEEKLY = 10;
  const DEPLOY_WEEKLY = 4;
  const VOLATILE_SHARE = 0.6;    // above this, the market is somebody else's crew
  const COACH_DEFECT = 0.18;     // rep defect rate that outruns the staffing case
  const COACH_MIN_N = 10;        // completions before a rate is worth acting on
  const RECENT_WEEKS = 8;        // the window every per-week rate is measured over

  // Rates MUST come from a recent window, not the whole dataset. Averaged over
  // eight months, a market that ran 90 jobs a week for two months and then went
  // to zero still reads several a week — PA York recommended a posting on
  // volume whose crew had already left the state. The same averaging buries a
  // market that only started last month. `dormant` is therefore its own answer:
  // recommending anything at all for a market with no current work is wrong.
  function marketAdvice(m) {
    const { recentPerWeek, outsourcedPerWeek, reach, mobileShare: vol,
      repShare, repDefectRate, repDone } = m;
    const reasons = [];

    if (!(recentPerWeek > 0)) {
      return { ...RECOMMENDATIONS.DORMANT, reasons: ['no jobs in the last ' + RECENT_WEEKS + ' weeks'
        + (m.n ? ' — ' + m.n + ' historically' : '')] };
    }
    if (vol >= VOLATILE_SHARE) {
      reasons.push(Math.round(vol * 100) + '% of the volume is from a sales org whose footprint moves');
      if (recentPerWeek >= DEPLOY_WEEKLY) {
        reasons.push('enough work to post someone, not enough certainty to hire');
        return { ...RECOMMENDATIONS.DEPLOY, reasons };
      }
      return { ...RECOMMENDATIONS.VENDOR, reasons };
    }
    if (reach === REACH.DAY && outsourcedPerWeek > 0) {
      reasons.push('inside day-trip range of ' + m.baseName);
      reasons.push(outsourcedPerWeek.toFixed(1) + ' surveys a week going outside the team');
      return { ...RECOMMENDATIONS.ABSORB, reasons };
    }
    if (outsourcedPerWeek >= HIRE_WEEKLY) {
      reasons.push(outsourcedPerWeek.toFixed(1) + ' outsourced surveys a week, and the volume is settled');
      reasons.push('no base within day-trip range');
      return { ...RECOMMENDATIONS.HIRE, reasons };
    }
    if (outsourcedPerWeek >= DEPLOY_WEEKLY && reach === REACH.DEPLOY) {
      reasons.push(outsourcedPerWeek.toFixed(1) + ' outsourced surveys a week, ' + Math.round(m.baseMiles) + 'mi out');
      return { ...RECOMMENDATIONS.DEPLOY, reasons };
    }
    // A thin sample cannot carry a coaching call: at 5 completions one defect
    // is 20% and would name an office off noise.
    if (repShare >= 0.5 && repDefectRate != null && repDone >= COACH_MIN_N && repDefectRate >= COACH_DEFECT) {
      reasons.push(Math.round(repShare * 100) + '% self-surveyed at a ' + Math.round(repDefectRate * 100)
        + '% defect rate over ' + repDone + ' completions');
      reasons.push('the fix is training, not headcount');
      return { ...RECOMMENDATIONS.COACH, reasons };
    }
    reasons.push(recentPerWeek < 1 ? 'under a survey a week' : 'too little outsourced work to staff against');
    return { ...RECOMMENDATIONS.VENDOR, reasons };
  }

  // ── Is more work coming from here? ───────────────────────────────────────
  // The staffing question the survey data CAN answer. Every other figure on
  // the Resource page is backward-looking — it says what a market has been,
  // not whether it will still be there when a hire starts. Intake direction is
  // the one leading indicator already in the export: a project start IS a sale
  // landing, so counting starts per window says whether an area is filling up
  // or emptying out.
  //
  // Three equal windows rather than two, because two cannot tell a market that
  // is arriving from one that is leaving. Live data, by state: Virginia reads
  // 6 → 201 → 179 (a crew arrived and is holding), Pennsylvania 220 → 39 → 23
  // (a crew left and it is collapsing), Texas 0 → 2 → 18 (opening). Two windows
  // would score Virginia and Pennsylvania about the same.
  //
  // Anchored on the export date, not the wall clock — the same rule the WIP,
  // Map and market-recency figures use, so a stale upload does not report every
  // market as quiet.
  const TREND_WINDOW_DAYS = 28;
  // Below this many jobs across the two live windows, no direction is named.
  // Ohio at 4 → 2 is a 50% fall on six jobs, which is noise wearing a verdict;
  // the bars still render, so the reader sees the shape and the thinness at
  // once. Same principle as RS_MIN_CELL on the Quality page.
  const TREND_MIN_N = 10;
  // ±25% between the two live windows. Wide on purpose: intake is lumpy week
  // to week, and a band that fires on ordinary variation trains you to ignore
  // it — the lesson the dropped floorAlarm left behind in metrics.cjs.
  const TREND_BAND = 0.25;
  const TRENDS = {
    GROWING: { k: 'growing', label: 'Growing' },
    STEADY:  { k: 'steady',  label: 'Steady' },
    SLOWING: { k: 'slowing', label: 'Slowing' },
    NEW:     { k: 'new',     label: 'Just opened' },
    QUIET:   { k: 'quiet',   label: 'Gone quiet' },
    THIN:    { k: 'thin',    label: '' },   // too few jobs to name a direction
  };

  // `dates` is every project-start date in the area; `asOf` the export date.
  // Returns the three window counts oldest-first plus a named direction, so a
  // caller can draw the shape and print the word from one call.
  function intakeTrend(dates, asOf) {
    if (!asOf) return { windows: [0, 0, 0], ...TRENDS.THIN, pct: null };
    const [y, m, d] = String(asOf).slice(0, 10).split('-').map(Number);
    const edge = k => {
      const dt = new Date(y, m - 1, d - TREND_WINDOW_DAYS * k);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    };
    const e1 = edge(1), e2 = edge(2), e3 = edge(3);
    let a = 0, b = 0, c = 0;
    (dates || []).forEach(ds => {
      if (!ds) return;
      const s = String(ds).slice(0, 10);
      if (s > asOf) return;
      if (s >= e1) a++; else if (s >= e2) b++; else if (s >= e3) c++;
    });
    const windows = [c, b, a];
    // Order matters. "Nothing arrived" is knowable at any sample size, so it is
    // tested before the thinness guard; "just opened" is not, so it is tested
    // after — one job against an empty prior window is not a market opening.
    if (a === 0) return { windows, ...TRENDS.QUIET, pct: null };
    if (a + b < TREND_MIN_N) return { windows, ...TRENDS.THIN, pct: null };
    if (b === 0) return { windows, ...TRENDS.NEW, pct: null };
    const pct = (a - b) / b;
    if (pct >= TREND_BAND) return { windows, ...TRENDS.GROWING, pct };
    if (pct <= -TREND_BAND) return { windows, ...TRENDS.SLOWING, pct };
    return { windows, ...TRENDS.STEADY, pct };
  }

  return { EARTH_MI, milesBetween, DEFAULT_RADIUS_MI, RADIUS_CHOICES, clusterByRadius,
    DAYS, daysAvailable, surveyorCfg, REACH, DEPLOY_MAX_MI, reachClass, nearestBase,
    MOBILITY_MIN_WEEK, MOBILITY_MIN_WEEKS, MOBILITY_RELOC, MOBILITY_MIN_NET_MI, officeMobility, mobileShare,
    TREND_WINDOW_DAYS, TREND_MIN_N, TREND_BAND, TRENDS, intakeTrend,
    RECOMMENDATIONS, HIRE_WEEKLY, DEPLOY_WEEKLY, VOLATILE_SHARE, COACH_DEFECT, COACH_MIN_N, RECENT_WEEKS, marketAdvice,
    centroid, spreadMi, ROAD_FACTOR, DEFAULT_SURVEYOR, surveyorConfig,
    driveMinutes, jobsPerDayExact, jobsPerDay, dayBudget, weeklyCapacity, reachable };
});
