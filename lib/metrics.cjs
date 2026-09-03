// lib/metrics.cjs — Single source of truth for metric definitions.
// Loaded three ways:
//   browser (classic script): <script src="/lib/metrics.cjs"> → window.OpsMetrics
//   Node (ESM api functions): import OpsMetrics from '../lib/metrics.cjs'
// Definitions documented in README.md → "Metric definitions".
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpsMetrics = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const DATA_CUTOFF = '2025-12-29';

  // Row scope: started on/after the cutoff, and either the survey is complete
  // (counts regardless of project status — an At-Risk or Canceled project's
  // finished survey still happened) or the project is active. Non-complete
  // At-Risk/Canceled rows stay out so they never appear as open WIP.
  function inScope(r, cutoff) {
    cutoff = cutoff || DATA_CUTOFF;
    if (!(r.start >= cutoff)) return false;
    if (r.complete && r.list === 'Complete') return true;
    return r.project_status === 'In Progress' || r.project_status === 'Change Order';
  }
  // SF exports the same rep in mixed casings ("Jules Lyusya" / "JULES LYUSYA"),
  // splitting their stats. Normalize fully-uppercase names; roman numerals stay.
  const NAME_KEEP = /^(II|III|IV|V|VI|JR|SR)\.?$/;
  function normalizeName(n) {
    if (!n || n !== n.toUpperCase() || !/[A-Z]/.test(n)) return n;
    return n.split(' ').map(t => NAME_KEEP.test(t) ? t : t.charAt(0) + t.slice(1).toLowerCase()).join(' ');
  }

  function filterRows(raw, cutoff) {
    const rows = raw.filter(r => inScope(r, cutoff));
    rows.forEach(r => { r.sales_rep = normalizeName(r.sales_rep); });
    return rows;
  }

  // Complete requires BOTH a completion date AND List status 'Complete'
  function isComplete(r) { return !!(r.complete && r.list === 'Complete'); }
  function isWIP(r) { return !!(r.start && !isComplete(r)); }

  // First-time completion: the survey has ever recorded a completion date,
  // regardless of current List status. isComplete() deliberately flips false
  // the moment a completed survey is reopened for resurvey (List moves off
  // 'Complete') — right for WIP/backlog math, wrong for "how many closed out
  // in week X": that count must not shrink retroactively as resurveys land.
  // The completion date itself (Site Survey Complete) is a separate SF field
  // from the resurvey dates and is not touched by a later resurvey.
  function everCompleted(r) { return !!r.complete; }

  // The completion date to measure cycle time against. Normally the survey's
  // own date, but a survey can predate the agreement: an account is cancelled,
  // re-signed months later, and the original survey is still recent enough to
  // reuse. Those rows carry a real completion date from the previous deal —
  // 175 to 231 days before the new agreement — which is not a data error and
  // must not be "corrected" in Salesforce. For cycle purposes the survey was
  // already in hand the moment the job entered the queue, so the agreement
  // date is the effective completion and the cycle is zero.
  //
  // Fires on 5 rows. It is a no-op for the 42 rep self-surveys completed one
  // day before Project Start, because there the agreement was signed the same
  // day the rep surveyed — complete equals agreement_signed, not before it.
  // Those 42 were previously landing on zero only because ct_total clamps
  // negatives; this makes the answer intentional rather than accidental.
  function effectiveComplete(r) {
    if (r.complete && r.agreement_signed && r.complete < r.agreement_signed) return r.agreement_signed;
    return r.complete;
  }

  // WIP age anchor: resurvey request → completion +2 days → project start
  function wipAgeFrom(r) {
    if (r.resurvey_requested) return r.resurvey_requested;
    if (r.complete) {
      const [y, m, d] = r.complete.split('-').map(Number);
      const dt = new Date(y, m - 1, d + 2);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    }
    return r.start;
  }

  // ── Rep grace day ────────────────────────────────────────────────────────
  // When a rep elects to do the survey they have until the next calendar day
  // before Site Survey starts working it (chasing the rep, or arranging Radicl
  // / a SunPower surveyor). That first day is the rep's, not the queue's.
  //
  // A blank resource defaults to rep — it gets corrected in SF when untrue.
  // Only surveys that went straight to field/Radicl with no rep phase skip the
  // grace, and `requested` is what marks a rep handoff (it is populated only
  // when a rep declines). Resurveys get no grace at all.
  function hasRepGrace(r) {
    if (r.resurvey_requested && !r.resurvey_complete) return false;
    const wentStraightToField = (r.resource === 'Radicl Services' || r.resource === 'SunPower Surveyor') && !r.requested;
    return !wentStraightToField;
  }

  function _dayDiff(fromISO, toISO) {
    if (!fromISO || !toISO) return null;
    const [fy, fm, fd] = fromISO.split('-').map(Number);
    const [ty, tm, td] = toISO.split('-').map(Number);
    return Math.round((new Date(ty, tm - 1, td) - new Date(fy, fm - 1, fd)) / 86400000);
  }

  // Days the survey has been Site Survey's responsibility. This is the queue
  // triage metric and is deliberately NOT the cycle time: ct_total and every
  // projection stay anchored on wipAgeFrom so Spec 12744 reporting is unmoved.
  function ssDaysOpen(r, asOfISO) {
    const raw = _dayDiff(wipAgeFrom(r), asOfISO);
    if (raw == null) return null;
    return Math.max(hasRepGrace(r) ? raw - 1 : raw, 0);
  }

  // True while the rep still owns it and the SS clock has not started.
  function inRepGrace(r, asOfISO) {
    if (!hasRepGrace(r)) return false;
    const raw = _dayDiff(wipAgeFrom(r), asOfISO);
    return raw != null && raw < 1;
  }

  // Any signal that a resurvey happened. reopened_by_design is a string '0'/'1' flag.
  const hasResurveySig = r => !!(r.resurvey_requested || r.resurvey_complete || r.resurvey_reason || r.reopened_by_design === '1');

  // Does this count against first pass yield? A resurvey signal alone is not
  // enough: a request raised and then dismissed without anyone re-surveying
  // anything is not a survey failure, and charging it to yield says the survey
  // failed when it did not.
  //
  // The test is the reason picklist and nothing else. Salesforce is the source
  // of truth here by choice — an earlier version also excluded rows carrying a
  // bare reopened_by_design flag with no reason and no dates, which was right
  // about those rows (their review notes read "RESURVEY NOT NEEDED") but had
  // the code inferring intent the data should state outright. Doug is tagging
  // those in SF instead, and they fall out of this rule on their own once the
  // reason is set.
  //
  // Keep using hasResurveySig where the question is "did a resurvey happen at
  // all" — cohorts, drill segments, the open queue. Use this one for yield.
  const RS_DISMISSED = 'Unnecessary Request';
  function isResurveyDefect(r) {
    if (!hasResurveySig(r)) return false;
    return !(r.resurvey_reason || '').split(';').map(s => s.trim()).includes(RS_DISMISSED);
  }

  // A resurvey still outstanding. The `list !== 'Complete'` clause is load-
  // bearing: 18 rows carry a resurvey request with no Resurvey Complete Date
  // but have gone back to list 'Complete' — the resurvey was resolved and the
  // date field was never filled in. Testing only the dates counts those as
  // open. It happens not to matter on the WIP page (which pre-filters to
  // isWIP, so those rows never reach it), but any surface that runs this over
  // completed rows needs the stricter test.
  const isOpenResurvey = r => !!(r.resurvey_requested && !r.resurvey_complete && r.list !== 'Complete');

  // ── What was actually missing ─────────────────────────────────────────
  // The reason picklist cannot be acted on: "Survey Incomplete" carries 76% of
  // every recorded reason and says only that something was absent. The request
  // details say WHICH thing, on 96% of defects, and they are written against a
  // request template — so a keyword rule over that text recovers the category
  // the picklist never had. Coverage on live data is 95%; the rest is the 18
  // defects whose details field is empty.
  //
  // MULTI-LABEL BY DESIGN, Doug's call 2026-08-18. A request asks for 2.2 of
  // these on average ("a site map showing the utility meter, plus the pitch of
  // the rear faces"), so forcing one category per row would silently delete the
  // second ask. Shares sum past 100% — the same convention resurvey_reason
  // already uses, for the same reason.
  //
  // This is a DERIVED reading of free text, not a Salesforce field: keep the
  // raw picklist and the raw details beside it wherever this is displayed (the
  // drill drawer carries both columns) so a category can always be checked
  // against the sentence it came from. If SF ever ships a real sub-reason
  // picklist, that replaces this outright.

  // The template headers sit on 57% of requests and would match categories on
  // their own — "INTERIOR ACCESS REQUIRED: No" is not a request for anything,
  // and "RESURVEY EXPLANATION:" is not an explanation.
  const RS_CAT_BOILERPLATE = [
    /interior access( required)?\s*:?\s*(yes|no|maybe)?/gi,
    /resurvey (explanation|required|resource type)\s*:?/gi,
    /request(ed)? (details|date)\s*:?/gi,
    /expla[i]*nation\s*:?/gi,
  ];
  function rsCatText(r) {
    let t = ((r && r.resurvey_details) || '').toLowerCase();
    for (const re of RS_CAT_BOILERPLATE) t = t.replace(re, ' ');
    return t.replace(/\s+/g, ' ').trim();
  }

  // Ordered commonest-first on live data. The order is presentational only:
  // nothing here is exclusive, so there is no priority to encode and no
  // fall-through catch-all. None of these patterns may carry /g — test() is
  // stateful with a global flag and would match every other row.
  const RS_CATEGORIES = [
    { key: 'panel', label: 'Panel interior & ratings',
      hint: 'dead front off, breaker and bus ratings, labels',
      re: /\b(dead ?front|deadfront|bus ?bar|bus rating|breakers?|amperage|panel cover|cover (on|off|taken off|removed)|front (taken off|removed|off)|labels? inside|panel diagram|wires? inside|wiring|main service panel|msp\b|service panel|electrical panel)\b/ },
    { key: 'meter', label: 'Meter & service entrance',
      hint: 'the utility meter, combo panel, conduit run',
      re: /\b(utility meter|meter\b|combo panel|service entrance|line ?side|conduit|riser|main disconnect)\b/ },
    { key: 'where', label: 'Where things are',
      hint: 'a site map, or step-back photos for context',
      re: /\b(site ?map|map showing|location of|located|step ?back|context)\b/ },
    { key: 'roofMeas', label: 'Roof measurements & pitch',
      hint: 'pitch or tilt, face dimensions, obstructions',
      re: /\b(pitch|tilt|slope|degrees|deg\b|measurements?|dimensions?|square footage|setback|roof face|roof section|roof sketch|drone|overhead imagery|obstructions?)\b/ },
    { key: 'subs', label: 'Sub-panels & other loads',
      hint: 'a second panel, load center, generator or ATS',
      re: /\b(sub ?-?panels?|load ?center|second(ary)? panel|another panel|both (service )?panels|other panels|ats\b|transfer switch|junction box|generator)\b/ },
    { key: 'existing', label: 'Existing system & battery',
      hint: 'existing modules and inverters, battery clearances',
      re: /\b(existing (system|solar|panels|modules?)|micro ?inverters?|inverter|make and model|module (model|manufacturer)|panel (type|count)|ac unit|batter(y|ies)|clearance|ess\b)\b/ },
    { key: 'roofStruct', label: 'Roof material & structure',
      hint: 'attic and rafters, roof covering',
      re: /\b(attic|rafters?|trusse?s|truss\b|spacing|structural|framing|joists?|roof (material|type|condition|covering|plane)|shingle|clay|tile|metal roof|re-?roof|layers)\b/ },
    { key: 'redo', label: 'Wrong site or full redo',
      hint: 'wrong property, unusable photos, a structure never surveyed',
      re: /\b(wrong (house|property|home|photos)|different (house|property|home)|duplicate photos|photos (appear to be|are) from|inaccurate photos|blurry|illegible|cropped|too dark|re-?upload|retake|full (site )?(re)?survey|new site survey|detached (structure|garage|building)|outbuilding|secondary building|shipping container|change order)\b/ },
  ];

  // Returns the category keys a resurvey request asked for — [] when the
  // details field is empty or says nothing matchable. Never guesses from the
  // reason picklist: "Survey Incomplete" with no details is genuinely unknown,
  // and filling that in from the coarse field is how the 76% got here.
  function rsCategories(r) {
    const t = rsCatText(r);
    if (!t) return [];
    return RS_CATEGORIES.filter(c => c.re.test(t)).map(c => c.key);
  }
  const rsCatLabel = key => (RS_CATEGORIES.find(c => c.key === key) || {}).label || key;

  // First Pass Yield, per Spec 12744: completions that never came back, over
  // total completions. Takes the completions already scoped by the caller —
  // it does not filter, so the caller owns the population (date range, region,
  // resource, whichever cut is being measured) and this owns only the ratio.
  //
  // Returns null on an empty set rather than 0 or 100: "no completions" is not
  // "perfect yield", and every surface renders that case as an em-dash.
  //
  // Weighted, never a mean of rates — a 4-week rolling figure must sum the
  // numerators and denominators across the window, because averaging four
  // weekly percentages lets a 6-completion week pull as hard as a 130-one.
  // Pass the whole window's rows and this does the right thing by construction.
  function fpy(completions) {
    if (!completions || !completions.length) return null;
    const defects = completions.filter(isResurveyDefect).length;
    return (completions.length - defects) / completions.length * 100;
  }

  // Stats — all ignore null/negative/NaN values
  function avg(a) { const v = a.filter(x => x != null && x >= 0 && !isNaN(x)); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length * 100) / 100 : null; }
  function med(a) { const v = [...a.filter(x => x != null && x >= 0)].sort((x, y) => x - y); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2 * 100) / 100; }
  function pct(a, p) { const v = [...a.filter(x => x != null && x >= 0)].sort((x, y) => x - y); if (!v.length) return null; return v[Math.min(v.length - 1, Math.ceil(v.length * p / 100) - 1)]; }

  // ── Derived analytics (shared by index.html and compose/index.html) ──

  // Business-day position in the week, anchored on "yesterday" (data reflects
  // yesterday's export). yesterday=Sunday → Monday morning: new week, 0 elapsed.
  // yesterday=Saturday → Sunday: business week done, 5 elapsed / 0 remaining.
  function businessDays(yesterdayISO) {
    const dow = new Date(yesterdayISO + 'T12:00:00').getDay();
    const elapsed = dow === 0 ? 0 : dow === 6 ? 5 : dow;
    return { elapsed, remaining: Math.max(5 - elapsed, 0) };
  }

  // Segment key → avg cycle time from a set of completions. dims order matters
  // for fallback: most specific first; lookup drops trailing dims until a
  // segment with data is found, else returns globalAvg.
  function buildSegmentAvgs(completions, dims) {
    const m = {};
    completions.forEach(r => {
      const key = dims.map(d => r[d] || '').join('|');
      if (!m[key]) m[key] = [];
      m[key].push(r.ct_total);
    });
    const out = {};
    Object.entries(m).forEach(([k, vals]) => { const a = avg(vals); if (a != null) out[k] = a; });
    return out;
  }
  function lookupSegmentAvg(r, dims, segAvgs, globalAvg) {
    for (let len = dims.length; len >= 1; len--) {
      const key = dims.slice(0, len).map(d => r[d] || '').join('|');
      if (segAvgs[key] != null) return segAvgs[key];
    }
    return globalAvg;
  }

  // Fractional calendar days left in the Mon–Sun week containing the export
  // date. The export day itself counts as half remaining (the export captures
  // completions only up to the moment it was run). Fri → 2.5, Sun → 0.5.
  // Whether the *displayed* week is over is the caller's call (export date past
  // the week's Sunday), not this function's.
  function weekDaysRemaining(dataThroughISO) {
    const dow = new Date(dataThroughISO + 'T12:00:00').getDay();
    const mon1 = dow === 0 ? 7 : dow; // Mon=1 … Sun=7
    return (7 - mon1) + 0.5;
  }

  const _isoAddDays = (iso, n) => {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d + n);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  };

  // Measured show-rate per resource: of surveys scheduled in the trailing
  // window, the fraction that completed within 1 day of the scheduled date.
  // Resources with <5 scheduled surveys fall back to the global rate; no data
  // at all falls back to 0.9 (the old hardcoded assumption).
  function buildShowRates(rows, asOfISO, windowDays) {
    const from = _isoAddDays(asOfISO, -(windowDays || 42));
    const by = {};
    let hitAll = 0, nAll = 0;
    rows.forEach(r => {
      const s = r.scheduled;
      if (!s || s < from || s >= asOfISO) return;
      const hit = r.complete && r.complete <= _isoAddDays(s, 1) ? 1 : 0;
      const k = r.resource || '';
      if (!by[k]) by[k] = { hit: 0, n: 0 };
      by[k].hit += hit; by[k].n += 1;
      hitAll += hit; nAll += 1;
    });
    const global = nAll ? hitAll / nAll : 0.9;
    const byResource = {};
    Object.entries(by).forEach(([k, v]) => { if (v.n >= 5) byResource[k] = v.hit / v.n; });
    return { byResource, global };
  }

  // Per-row expected cycle time: the surveying rep's own average when there's
  // enough history (≥3 completions), else region|resource segment average,
  // else the global average.
  function buildExpectedCt(recentCompletions) {
    const dims = ['region', 'resource'];
    const segAvgs = buildSegmentAvgs(recentCompletions, dims);
    const repVals = {};
    recentCompletions.forEach(r => {
      if (r.resource === 'Sales Rep' && r.sales_rep) (repVals[r.sales_rep] = repVals[r.sales_rep] || []).push(r.ct_total);
    });
    const repAvgs = {};
    Object.entries(repVals).forEach(([k, v]) => { if (v.length >= 3) { const a = avg(v); if (a != null) repAvgs[k] = a; } });
    const globalAvg = avg(recentCompletions.map(r => r.ct_total)) || 4;
    return r => (r.resource === 'Sales Rep' && repAvgs[r.sales_rep] != null)
      ? repAvgs[r.sales_rep]
      : lookupSegmentAvg(r, dims, segAvgs, globalAvg);
  }

  // ── Weekly completion projection (v2) ────────────────────────────────────
  //
  // Completions in a week = work already in the queue that clears + NEW work
  // that arrives and clears in the same week ("walk-in"). The old model saw
  // only the first half and read ~40% low every Monday, because ~40% of a
  // week's completions are walk-in — overwhelmingly Sales Rep self-surveys
  // done the day the agreement signs. As the mix shifts to Radicl / SunPower
  // surveyors that walk-in share falls (57% same-week for a rep booking vs
  // 15% for Radicl), so the two halves are modelled separately and each is
  // resource-resolved:
  //
  //   pipeline — every open WIP row contributes a completion probability.
  //     A row with an appointment this week uses its resource's measured
  //     show-rate (buildShowRates). An unscheduled row uses an empirical
  //     conversion curve: P(complete within d more days | open now at age a),
  //     keyed by resource, adjusted by a per-region speed factor. Open
  //     resurveys use their own pooled curve.
  //   intake  — for each day still to come, expected new bookings that day
  //     (trailing booking rate × that weekday's intake factor), split by the
  //     recent resource mix, each leg × that resource's measured same-week
  //     completion rate for that weekday.
  //
  // CANCELLATION IS ALREADY INSIDE THESE RATES and must never be applied a
  // second time as a separate multiplier. The conversion curve and the
  // same-week rate both put every booking in the denominator, cancelled ones
  // included — a Radicl booking that cancels before anyone surveys it is an
  // "open at age a" that never becomes an event, which is exactly what pulls
  // its curve down. The curb on a drifting cancellation regime is the
  // TRAILING WINDOW (rateWeeks), not an extra factor: recompute the rates and
  // they track the current regime. `cancelNoSurvey` per resource is returned
  // as a diagnostic only.

  // Weekday completion shape: share of a week's completions landing on each
  // weekday, over the trailing `weeks`. Sun≈0. Used to spread the projected
  // remaining completions across the remaining days.
  function buildWeekdayShape(rows, asOfISO, weeks) {
    weeks = weeks || 8;
    const from = _isoAddDays(lastCompleteWeekEnd(asOfISO), -(weeks * 7 - 1));
    const to = lastCompleteWeekEnd(asOfISO);
    const by = [0, 0, 0, 0, 0, 0, 0];
    let tot = 0;
    rows.forEach(r => {
      if (!everCompleted(r) || r.complete < from || r.complete > to) return;
      by[new Date(r.complete + 'T12:00:00').getDay()]++; tot++;
    });
    if (!tot) return { share: [0, 0.2, 0.14, 0.17, 0.23, 0.18, 0.08], n: 0 };
    return { share: by.map(x => x / tot), n: tot };
  }

  // Fits every rate the projection needs from a trailing window of bookings.
  // `allRows` must be the FULL row set (cancelled rows included) — see the
  // cancellation note above.
  function buildProjectionModel(allRows, asOfISO, opts) {
    opts = opts || {};
    const rateWeeks = opts.rateWeeks || 8;
    const levelWeeks = opts.levelWeeks || 3;
    const RES = ['Sales Rep', 'Radicl Services', 'SunPower Surveyor'];

    // ── Pipeline hazard table ──
    // For a row still open at the START of a week, P(it records a completion by
    // that Sunday), measured over every Mon–Sun boundary in the trailing
    // window — every open row contributes at every week it is open, so the
    // cells are dense. Keyed by resource × age band × whether it has an
    // appointment that week, because the shapes are completely different: an
    // unscheduled Radicl row clears at ~10%/wk (it is waiting to be booked),
    // the same row once booked clears at ~92%. Aged-open rows (31+ days) clear
    // at ~0–5%/wk regardless — they are stuck on a utility bill or a rep, not
    // moving through a queue — which is the correction that keeps the model
    // from counting a stale pile as imminent completions.
    const WIP_BANDS = [[0, 3], [4, 7], [8, 14], [15, 30], [31, 1e9]];
    const bandOf = a => { for (let i = 0; i < WIP_BANDS.length; i++) if (a >= WIP_BANDS[i][0] && a <= WIP_BANDS[i][1]) return i; return WIP_BANDS.length - 1; };
    const hzWeeks = [];
    for (let i = 0; i < rateWeeks; i++) {
      const we = _isoAddDays(lastCompleteWeekEnd(asOfISO), -7 * i);
      hzWeeks.push([_isoAddDays(we, -6), we]);
    }
    // acc[key] = [hits, atRisk]; keys: `${res}|${band}|open`, `${res}|sched`, ALL variants, `rs`
    const acc = {};
    const bump = (k, hit) => { (acc[k] = acc[k] || [0, 0])[1]++; if (hit) acc[k][0]++; };
    allRows.forEach(r => {
      if (!r.start) return;
      const openResur = !!(r.resurvey_requested && !r.resurvey_complete) || isOpenResurvey(r);
      hzWeeks.forEach(([mon, sun]) => {
        // resurvey leg
        if (r.resurvey_requested && r.resurvey_requested <= mon && _dayDiff(r.resurvey_requested, mon) <= 60) {
          const doneBefore = r.resurvey_complete && r.resurvey_complete < mon;
          if (!doneBefore) bump('rs', r.resurvey_complete && r.resurvey_complete >= mon && r.resurvey_complete <= sun);
        }
        // initial leg
        if (openResur || r.start > mon) return;
        const doneBefore = r.complete && r.complete < mon && r.list === 'Complete';
        if (doneBefore) return;
        const age = _dayDiff(r.start, mon); if (age == null || age < 0) return;
        // A booking that never became a survey (cancelled before anyone
        // surveyed it) stays in the risk set — from a Monday viewpoint it is
        // indistinguishable from a slow one, and dropping it inflates the
        // hazard, most of all for Radicl where ~22% cancel unsurveyed. Capped
        // at 90 days so an ancient dead row does not pad every week forever.
        if (!r.complete && age > 90) return;
        const b = bandOf(age);
        const sched = r.scheduled && r.scheduled >= mon && r.scheduled <= sun;
        const hit = r.complete && r.list === 'Complete' && r.complete >= mon && r.complete <= sun;
        const res = r.resource || 'ALL';
        if (sched) { bump(res + '|sched', hit); bump('ALL|sched', hit); }
        else { bump(res + '|' + b + '|open', hit); bump('ALL|' + b + '|open', hit); }
      });
    });
    const rate = (k, fb) => { const a = acc[k]; return (a && a[1] >= 12) ? a[0] / a[1] : fb; };
    const hazSched = res => rate(res + '|sched', rate('ALL|sched', 0.9));
    const hazOpen = (res, band) => rate(res + '|' + band + '|open', rate('ALL|' + band + '|open', band >= 3 ? 0.05 : 0.5));
    const hazRs = () => rate('rs', 0.25);

    // Per-region speed factor: gentle multiplier on the open hazard from region
    // median cycle vs global, so a fast region's queue clears a little quicker.
    const gCyc = allRows.filter(r => r.start >= _isoAddDays(asOfISO, -(rateWeeks * 7 + 28)) && r.start < asOfISO)
      .map(r => (r.complete && r.list === 'Complete') ? _dayDiff(r.start, r.complete) : null).filter(x => x != null && x >= 0);
    const gMed = med(gCyc) || 4;
    const regBuckets = {};
    allRows.forEach(r => {
      if (!r.region || !r.complete || r.list !== 'Complete') return;
      if (r.start < _isoAddDays(asOfISO, -(rateWeeks * 7 + 28)) || r.start >= asOfISO) return;
      const c = _dayDiff(r.start, r.complete); if (c != null && c >= 0) (regBuckets[r.region] = regBuckets[r.region] || []).push(c);
    });
    const regFactor = {};
    Object.entries(regBuckets).forEach(([k, v]) => {
      if (v.length < 20) return;
      regFactor[k] = Math.max(0.75, Math.min(1.35, gMed / (med(v) || gMed)));
    });

    // P(an open WIP row completes before the week ends). `remainShare` is the
    // fraction of a typical week's completions still to come after asOf (1.0
    // Monday morning, ~0.5 Wednesday, ~0.1 Friday) — it scales only the
    // unscheduled leg; a booked appointment is a fixed future day, not a
    // fraction of the week.
    const pConv = (r, asOf, remainShare, schedThisWk) => {
      if (schedThisWk) return hazSched(r.resource || 'ALL');
      if (isOpenResurvey(r)) return Math.min(0.95, hazRs() * Math.max(remainShare, 0.15));
      const age = Math.max(0, _dayDiff(r.start, asOf) || 0);
      return Math.min(0.98, hazOpen(r.resource || 'ALL', bandOf(age)) * remainShare * (regFactor[r.region] || 1));
    };

    // ── Intake side ──
    const lvlTo = lastCompleteWeekEnd(asOfISO);
    const lvlFrom = _isoAddDays(lvlTo, -(levelWeeks * 7 - 1));
    const lvlStarts = allRows.filter(r => r.start && r.start >= lvlFrom && r.start <= lvlTo);
    const intakePerWeek = lvlStarts.length / levelWeeks;
    const mix = {};
    RES.forEach(res => { mix[res] = lvlStarts.length ? lvlStarts.filter(r => r.resource === res).length / lvlStarts.length : 0; });

    // WALK-IN: completions of surveys that both started AND finished inside the
    // same Mon–Sun week — the throughput a Monday pipeline snapshot is blind
    // to. Modelled directly as a run rate rather than (expected bookings ×
    // same-week rate): the booking count is far too volatile week to week to
    // multiply through (a 3-week trailing rate overshot the next week's real
    // intake by up to 2×), and the run rate folds the cancellation drag, the
    // resource mix and the conversion odds into one measured number. Counted
    // per weekday-of-completion over `levelWeeks`, so a Monday-morning
    // projection expects the full weekly figure and a Thursday one only the
    // Fri/Sat tail.
    const wiFrom = _isoAddDays(lvlTo, -(levelWeeks * 7 - 1));
    const wiDow = [0, 0, 0, 0, 0, 0, 0];
    const wiRes = {}; RES.forEach(res => wiRes[res] = 0);
    let wiTot = 0;
    allRows.forEach(r => {
      if (!everCompleted(r) || r.complete < wiFrom || r.complete > lvlTo) return;
      const wkMon = _isoAddDays(r.complete, -((new Date(r.complete + 'T12:00:00').getDay() + 6) % 7));
      if (r.start < wkMon) return; // not a walk-in — it was already in the queue
      wiDow[new Date(r.complete + 'T12:00:00').getDay()]++; wiTot++;
      if (wiRes[r.resource] != null) wiRes[r.resource]++;
    });
    const walkInPerDay = wiDow.map(x => x / levelWeeks);
    const walkInPerWeek = wiTot / levelWeeks;
    const walkInMix = {}; RES.forEach(res => { walkInMix[res] = wiTot ? wiRes[res] / wiTot : 0; });

    // Diagnostic: share of recent bookings that cancelled without ever being
    // surveyed, by resource. Not used in the maths — see the note above.
    const cxFrom = _isoAddDays(asOfISO, -(rateWeeks * 7 + 28));
    const cxCoh = allRows.filter(r => r.start && r.start >= cxFrom && r.start < _isoAddDays(asOfISO, -14));
    const cancelNoSurvey = {};
    RES.forEach(res => {
      const b = cxCoh.filter(r => r.resource === res);
      cancelNoSurvey[res] = b.length ? b.filter(r => !r.complete && r.project_status === 'Canceled').length / b.length : null;
    });

    // SunPower-surveyor weekly ceiling: the team is four people and tops out
    // near its trailing max, so the pipeline+intake maths can over-count it.
    let spwrCap = null;
    {
      const wc = [];
      for (let i = 1; i <= rateWeeks; i++) {
        const we = _isoAddDays(lastCompleteWeekEnd(asOfISO), -7 * (i - 1));
        const wf = _isoAddDays(we, -6);
        wc.push(allRows.filter(r => r.resource === 'SunPower Surveyor' && everCompleted(r) && r.complete >= wf && r.complete <= we).length);
      }
      if (wc.length) spwrCap = Math.max(12, Math.round(Math.max(...wc) * 1.15));
    }

    return { pConv, walkInPerDay, walkInPerWeek, walkInMix, intakePerWeek, mix,
      regFactor, spwrCap, cancelNoSurvey, RES, hazOpen, hazSched, bandOf, WIP_BANDS,
      _meta: { rateWeeks, levelWeeks, gMed } };
  }

  // Project total completions for the Mon–Sun week containing `weekStartISO`,
  // as of `asOfISO` (the export date). Returns the point estimate plus the
  // pieces the breakdown drawer renders and a prediction band from a rolling
  // self-backtest at the same day-of-week. `allRows` = the full set.
  const _projCache = {};
  function projectWeek(allRows, weekStartISO, asOfISO, opts) {
    opts = opts || {};
    const z = opts.z != null ? opts.z : 1;
    // A full projection with the self-backtest is ~150ms; callers that render
    // it once per page paint pass opts.cacheKey (e.g. the export timestamp)
    // so a filter change does not recompute a number filters never touch.
    const ck = opts.cacheKey && !opts._noBacktest
      ? opts.cacheKey + '|' + weekStartISO + '|' + asOfISO + '|' + z : null;
    if (ck && _projCache[ck]) return _projCache[ck];
    const model = opts._model || buildProjectionModel(allRows, asOfISO, opts);
    const weekEndISO = _isoAddDays(weekStartISO, 6);

    const doneRows = allRows.filter(r => everCompleted(r) && r.complete >= weekStartISO && r.complete <= (asOfISO < weekEndISO ? asOfISO : weekEndISO));
    const completedSoFar = doneRows.length;

    let daysLeft;
    if (asOfISO >= weekEndISO) daysLeft = 0;
    else if (asOfISO < weekStartISO) daysLeft = 6.5;
    else daysLeft = weekDaysRemaining(asOfISO);

    // remainShare — the fraction of a typical week's completions still ahead of
    // asOf, from the weekday completion shape. Scales the pipeline hazard and
    // the walk-in rate for the days STRICTLY after asOf (a full week ahead →
    // 1.0; Friday → the Sat/Sun tail). The export runs in the morning, so
    // asOf's own day is mostly still to come — that is `restOfToday` below, a
    // separate term, so this share deliberately excludes today.
    const shape = opts._shape || buildWeekdayShape(allRows, asOfISO, opts.rateWeeks || 8);
    let remainShare = 0, totShare = 0;
    for (let i = 0; i < 7; i++) {
      const d = _isoAddDays(weekStartISO, i);
      totShare += shape.share[new Date(d + 'T12:00:00').getDay()];
      if (d > asOfISO) remainShare += shape.share[new Date(d + 'T12:00:00').getDay()];
    }
    remainShare = totShare > 0 ? Math.min(1, remainShare / totShare) : (daysLeft > 0 ? Math.min(1, daysLeft / 6.5) : 0);

    // Rest of today. The export is a moment inside a working day — a handful of
    // completions logged by mid-morning does not mean the day is done. Expected
    // today = today's weekday share × the trailing 3-week completion rate; what
    // is not yet banked is added once here (remainShare covers only the days
    // strictly after). Scaled by how much of the working day is still ahead:
    // `asOfHour` (the export hour, 0–24) → ~0.9 before 9am, ~0.05 after 5pm.
    let restOfToday = 0, expectedToday = 0, todayActual = 0;
    if (asOfISO >= weekStartISO && asOfISO <= weekEndISO) {
      const todayShare = shape.share[new Date(asOfISO + 'T12:00:00').getDay()] || 0;
      let wkBase = 0;
      for (let k = 1; k <= 3; k++) {
        const we = _isoAddDays(lastCompleteWeekEnd(asOfISO), -7 * (k - 1));
        const wf = _isoAddDays(we, -6);
        wkBase += allRows.reduce((n, r) => n + (everCompleted(r) && r.complete >= wf && r.complete <= we ? 1 : 0), 0);
      }
      wkBase /= 3;
      todayActual = allRows.reduce((n, r) => n + (everCompleted(r) && r.complete === asOfISO ? 1 : 0), 0);
      expectedToday = todayShare * wkBase;
      const h = opts.asOfHour;
      const dayAhead = h == null ? 0.9
        : h <= 9 ? 0.9 : h >= 17 ? 0.05 : 0.9 - (h - 9) * (0.85 / 8);
      restOfToday = Math.max(0, expectedToday - todayActual) * dayAhead;
    }

    // Pipeline: open WIP rows as of asOf. A row counts as open then if it is in
    // an active status now, or completed after asOf, or has an open resurvey —
    // and had started and not yet completed by asOf.
    const _active = r => r.project_status === 'In Progress' || r.project_status === 'Change Order';
    const wip = allRows.filter(r =>
      (_active(r) || (r.complete && r.list === 'Complete' && r.complete > asOfISO) || (r.resurvey_requested && !r.resurvey_complete))
      && r.start && r.start <= asOfISO
      && !(r.complete && r.complete <= asOfISO && r.list === 'Complete'));
    let pipeline = 0, pipelineSched = 0;
    const byRes = {}; model.RES.forEach(x => byRes[x] = { pipeline: 0, intake: 0, soFar: 0 });
    model.RES.forEach(x => { byRes[x].soFar = doneRows.filter(r => r.resource === x).length; });
    wip.forEach(r => {
      const schedThisWk = !!((r.scheduled && r.scheduled >= asOfISO && r.scheduled <= weekEndISO) ||
        (r.resurvey_scheduled && r.resurvey_scheduled >= asOfISO && r.resurvey_scheduled <= weekEndISO));
      const p = daysLeft > 0 ? model.pConv(r, asOfISO, remainShare, schedThisWk) : 0;
      pipeline += p;
      if (schedThisWk) pipelineSched += p;
      if (byRes[r.resource]) byRes[r.resource].pipeline += p;
    });

    // Intake: walk-in completions still to come. The trailing weekly walk-in
    // run rate, tapered by remainShare — the same completion-shape fraction the
    // pipeline uses, so a Monday projection expects the whole week's walk-in
    // and a Friday one only its tail. Summed by weekday it double-counts the
    // rows that arrived earlier this week and are already in the WIP set.
    const intake = model.walkInPerWeek * remainShare;
    const byDayIntake = {};
    const remDays = [];
    for (let i = 0; i < 7; i++) {
      const day = _isoAddDays(weekStartISO, i);
      if (day > weekEndISO || day <= asOfISO) continue;
      remDays.push([day, model.walkInPerDay[new Date(day + 'T12:00:00').getDay()] || 0]);
    }
    const remSum = remDays.reduce((a, [, w]) => a + w, 0) || 1;
    remDays.forEach(([day, w]) => { byDayIntake[day] = Math.round(intake * (w / remSum) * 10) / 10; });
    model.RES.forEach(res => { byRes[res].intake = intake * (model.walkInMix[res] || 0); });

    // Attribute today's remainder across resources the way the rest of the
    // week's work splits, so the by-resource column still sums to the point.
    {
      const base = {};
      let tot = 0;
      model.RES.forEach(res => { base[res] = byRes[res].soFar + byRes[res].pipeline + byRes[res].intake; tot += base[res]; });
      model.RES.forEach(res => { byRes[res].today = restOfToday * (tot > 0 ? base[res] / tot : (model.walkInMix[res] || 0)); });
    }

    // SunPower-surveyor ceiling.
    let capAdj = 0;
    if (model.spwrCap != null) {
      const s = byRes['SunPower Surveyor'];
      const spwrTotal = s.soFar + s.pipeline + s.intake + (s.today || 0);
      if (spwrTotal > model.spwrCap) capAdj = -(spwrTotal - model.spwrCap);
    }

    const raw = completedSoFar + restOfToday + pipeline + intake + capAdj;

    // Prediction band: rolling self-backtest at the same day-of-week offset.
    const offset = _dayDiff(weekStartISO, asOfISO);
    const resid = [];
    const backtest = [];
    if (!opts._noBacktest) {
      const btWeeks = Math.min(opts.backtestWeeks || 8, opts.rateWeeks || 8);
      for (let wkBack = 1; wkBack <= btWeeks; wkBack++) {
        const ws = _isoAddDays(weekStartISO, -7 * wkBack);
        const we = _isoAddDays(ws, 6);
        if (we >= asOfISO) continue;
        const ao = _isoAddDays(ws, offset);
        const pr = projectWeek(allRows, ws, ao, { ...opts, _noBacktest: true, _shape: shape, z: 0 }).raw;
        const act = allRows.filter(r => everCompleted(r) && r.complete >= ws && r.complete <= we).length;
        resid.push(pr - act); // error, positive = the model over-projected
        backtest.push({ weekStart: ws, predicted: Math.round(pr), actual: act });
      }
      backtest.reverse();
    }
    const recentBias = resid.length ? resid.reduce((a, b) => a + b, 0) / resid.length : null;
    const sd = resid.length > 1
      ? Math.sqrt(resid.reduce((a, e) => a + (e - recentBias) ** 2, 0) / (resid.length - 1)) : null;
    const recentMae = resid.length ? resid.reduce((a, e) => a + Math.abs(e), 0) / resid.length : null;

    // Bias-correct the point by the recent mean residual. The pipeline hazard
    // is fit on resolved history, where a slipped appointment has already had
    // its scheduled date rewritten to the week it landed — so forward it reads
    // a few completions optimistic every week, most of all on a Monday run.
    // The correction is measured at the SAME day-of-week offset over the
    // trailing window, so it tracks that structural slippage rather than noise.
    // Only trust the correction with a few weeks behind it, and never let it
    // swing the number more than 30% — a wild residual on one sparse early
    // week should not throw the estimate.
    const corr = (recentBias != null && resid.length >= 3)
      ? Math.max(-0.3 * raw, Math.min(0.3 * raw, recentBias)) : 0;
    const adj = raw - corr; // subtract the recent over-projection
    const point = Math.max(completedSoFar, Math.round(adj));
    // Band from the residual spread, but capped by ~1.5× the mean error so one
    // freak week does not blow the range out. Floor of 4.
    const band = sd != null
      ? Math.max(4, z * Math.min(sd, (recentMae != null ? recentMae * 1.3 : sd)))
      : null;

    // Per-day view: actual on days that are done, a projection on the rest.
    // Today (the export day) gets what it has banked plus its own remainder;
    // the days strictly after get the leftover, spread by the weekday shape.
    // One definition, read by both the breakdown modal and the Current chart.
    const byDay = [];
    {
      const remFuture = Math.max(0, point - completedSoFar - restOfToday);
      const fut = [];
      let futW = 0;
      for (let i = 0; i < 7; i++) {
        const d = _isoAddDays(weekStartISO, i);
        const isFuture = d > asOfISO && d <= weekEndISO;
        const w = isFuture ? (shape.share[new Date(d + 'T12:00:00').getDay()] || 0) : 0;
        futW += w;
        fut.push({ date: d, isFuture, isToday: d === asOfISO, w,
          actual: allRows.reduce((n, r) => n + (everCompleted(r) && r.complete === d ? 1 : 0), 0) });
      }
      fut.forEach(x => {
        let projected = null;
        if (x.isToday && restOfToday >= 0.5) projected = x.actual + Math.round(restOfToday);
        else if (x.isFuture) projected = Math.round(remFuture * (futW > 0 ? x.w / futW : 0));
        byDay.push({ date: x.date, actual: x.actual, projected });
      });
    }

    const out = {
      point,
      lo: band != null ? Math.max(completedSoFar, Math.round(adj - band)) : null,
      hi: band != null ? Math.round(adj + band) : null,
      raw: Math.round(raw * 10) / 10,
      adj: Math.round(adj * 10) / 10,
      completedSoFar, pipeline: Math.round(pipeline * 10) / 10,
      pipelineScheduled: Math.round(pipelineSched * 10) / 10,
      pipelineUnscheduled: Math.round((pipeline - pipelineSched) * 10) / 10,
      intake: Math.round(intake * 10) / 10,
      restOfToday: Math.round(restOfToday * 10) / 10,
      todayActual, expectedToday: Math.round(expectedToday * 10) / 10,
      capAdj: Math.round(capAdj * 10) / 10,
      slippageAdj: Math.round(-corr * 10) / 10, // what was added to raw (≤0 when correcting a high model)
      wipOpen: wip.length, remainShare: Math.round(remainShare * 100) / 100,
      daysLeft, byResource: byRes, byDayIntake, byDay,
      recentBias: recentBias != null ? Math.round(recentBias * 10) / 10 : null,
      recentMae: recentMae != null ? Math.round(recentMae * 10) / 10 : null,
      nBacktest: resid.length, backtest,
      model,
    };
    if (ck) _projCache[ck] = out;
    return out;
  }

  // ── SS Ratio (Spencer's model) ───────────────────────────────────────────
  // WIP ÷ avg weekly completions = weeks of backlog if nothing new arrived.
  //
  // Two variants exist ON PURPOSE — they answer different questions. Do not
  // merge them:
  //   ssRatioForWeek — the reported weekly number (Trends line, Monday recap)
  //   ssRatioLive    — "what is on my desk right now" (WIP page card)
  //
  // Both take the denominator from the 3 most recent COMPLETE weeks, which is
  // the same rule expressed from two anchors: for a finished week that includes
  // the reporting week itself; measured live mid-week it does not, because a
  // part-finished week would deflate the average and inflate the ratio.

  // Open WIP as of a date. Uses isComplete (date AND list==='Complete') — a
  // Holding or Reopened row still carries a completion date but is not done.
  function wipOn(rows, asOfISO) {
    let n = 0;
    for (const r of rows) {
      if (!r.start || r.start > asOfISO) continue;
      if (isComplete(r) && r.complete <= asOfISO) continue;
      n++;
    }
    return n;
  }

  // Mean WIP across the 7 days of a week, NOT the Sunday close. Intake spikes
  // Friday/Saturday while completions stop, so a week-close snapshot samples
  // the weekly maximum every time and overstates backlog by roughly a third.
  function meanWipForWeek(rows, weekEndISO) {
    let total = 0;
    for (let i = 0; i < 7; i++) total += wipOn(rows, _isoAddDays(weekEndISO, -i));
    return total / 7;
  }

  function avgWeeklyCompletions(rows, weekEndISO, weeks) {
    weeks = weeks || 3;
    let total = 0;
    for (let i = 0; i < weeks; i++) {
      const end = _isoAddDays(weekEndISO, -7 * i);
      const from = _isoAddDays(end, -6);
      total += rows.filter(r => isComplete(r) && r.complete >= from && r.complete <= end).length;
    }
    return total / weeks;
  }

  // The Sunday that closed the last COMPLETE week before asOfISO. The week
  // containing asOfISO is treated as partial, including when asOfISO is itself
  // a Sunday — the export runs during that day.
  function lastCompleteWeekEnd(asOfISO) {
    const dow = new Date(asOfISO + 'T12:00:00').getDay();
    return _isoAddDays(asOfISO, -(dow === 0 ? 7 : dow));
  }

  function ssRatioForWeek(rows, weekEndISO, weeks) {
    const avgC = avgWeeklyCompletions(rows, weekEndISO, weeks);
    if (!(avgC > 0)) return null;
    return Math.round(meanWipForWeek(rows, weekEndISO) / avgC * 100) / 100;
  }

  function ssRatioLive(rows, asOfISO, weeks) {
    const avgC = avgWeeklyCompletions(rows, lastCompleteWeekEnd(asOfISO), weeks);
    if (!(avgC > 0)) return null;
    return Math.round(wipOn(rows, asOfISO) / avgC * 100) / 100;
  }

  // The value as the UI actually renders it. Every card displays 1dp via
  // toFixed(1), so banding must use the SAME rounding — Math.round(v*10)/10
  // disagrees with toFixed on float half-cases (4.05 renders "4.0" but rounds
  // to 4.1; 1.95 renders "1.9" but rounds to 2.0), which put a card's colour
  // back out of step with its number.
  const _shown = v => Number(v.toFixed(1));

  // SS ratio bands. Under a week of backlog is healthy; 1–2 weeks is the normal
  // operating range and is deliberately NOT coloured — intake keeps arriving
  // over the weekend while the team is off, so an elevated reading is usually
  // the rhythm rather than a problem. Two weeks of backlog is the real alarm.
  function ssRatioBand(v) {
    if (v == null) return '';
    const shown = _shown(v);
    return shown <= 1 ? 'good' : shown < 2 ? 'normal' : 'bad';
  }

  // ── Backlog alarms ───────────────────────────────────────────────────────
  // Both thresholds are fit to 20 weeks of this team's own history, so they
  // encode "unusual for us", not an industry standard — revisit after a
  // quarter of real use. The SS ratio is deliberately NOT an alarm: across
  // those 20 weeks it never exceeded 1.16, so any useful threshold on it
  // either never fires or fires constantly.
  const ALARM_CLEARANCE = 0.90;  // 4-week rolling completions ÷ starts
  const ALARM_FLOOR_MULT = 1.5;  // Weekly floor vs its own trailing median

  // Completions ÷ starts over the trailing `weeks` weeks ending at weekEndISO.
  // Volume-normalised: above 1 backlog shrinks, below 1 it grows, no matter how
  // much comes in. The single-week version is far too noisy to alarm on (under
  // 100% in 12 of 20 weeks); the 4-week version held 89–103% for five months.
  function rollingClearance(rows, weekEndISO, weeks) {
    weeks = weeks || 4;
    let inn = 0, out = 0;
    for (let i = 0; i < weeks; i++) {
      const end = _isoAddDays(weekEndISO, -7 * i);
      const from = _isoAddDays(end, -6);
      for (const r of rows) {
        if (r.start && r.start >= from && r.start <= end) inn++;
        if (isComplete(r) && r.complete >= from && r.complete <= end) out++;
      }
    }
    return inn ? out / inn : null;
  }

  // The actual low point of the week: the minimum daily WIP across the 7 days
  // ending at weekEndISO (Mon–Sun, same week convention as rollingClearance).
  // Used to assume Monday — the day after the weekend buildup drains — was
  // always that low point, but a sustained backlog climb breaks that: WIP now
  // often keeps rising Mon→Sun rather than draining, so Monday's count can sit
  // well above the week's real minimum (and above days that come later).
  function weeklyFloor(rows, weekEndISO) {
    let min = Infinity;
    for (let i = 0; i < 7; i++) {
      const v = wipOn(rows, _isoAddDays(weekEndISO, -i));
      if (v < min) min = v;
    }
    return min === Infinity ? null : min;
  }

  // Confirmation alarm: 4-week clearance under 90% two readings running.
  // Series is chronological, most recent last.
  function clearanceAlarm(series) {
    const n = series.length;
    if (n < 2) return false;
    const a = series[n - 1], b = series[n - 2];
    return a != null && b != null && a < ALARM_CLEARANCE && b < ALARM_CLEARANCE;
  }

  // Baseline the floor alarm compares against: the median of the prior
  // `lookback` weeks. The window is deliberately long (16wk default). A short
  // window absorbs a regime shift within a month or two and the alarm silences
  // itself while the problem is still there — it becomes a change detector
  // rather than a state one. Long window = it stays lit until the floor
  // genuinely comes back down.
  function floorBaseline(series, lookback) {
    lookback = lookback || 16;
    const n = series.length;
    if (n < 2) return null;
    const prior = series.slice(Math.max(0, n - 1 - lookback), n - 1).filter(v => v != null);
    if (prior.length < 4) return null;
    return med(prior);
  }

  // Early alarm: the weekly floor sitting above 1.5x its baseline. This moved a
  // month before the SS ratio did the last time backlog built.
  function floorAlarm(series, lookback) {
    const n = series.length;
    if (n < 2) return false;
    const cur = series[n - 1];
    if (cur == null) return false;
    const m = floorBaseline(series, lookback);
    return m != null && m > 0 && cur > m * ALARM_FLOOR_MULT;
  }

  // Status band vs target: ≤target good, ≤target+2 mid, else bad. null → ''.
  // Compares the value as it is *displayed* (1dp everywhere these bands are
  // used). avg() keeps 2dp, so an untrimmed 4.04 would render "4.0d" against a
  // 4d target and still colour amber — a miss the reader cannot reconcile.
  function bandFor(v, target) {
    if (v == null) return '';
    const shown = _shown(v);
    return shown <= target ? 'good' : shown <= target + 2 ? 'mid' : 'bad';
  }

  // Queue-age band — how long a survey has been OPEN, not how long it took.
  // Distinct from bandFor(), which bands a finished cycle time at target+2;
  // an open queue gets target+3 before it goes red. Bands the raw day count,
  // since ssDaysOpen() returns whole days already.
  //
  // This exists because the two sites that used it had drifted apart in a way
  // that only stayed hidden while targetAvg was 4: the WIP table's Open-in-SS
  // pill hardcoded its amber cutoff as `d<=7`, while Current's still-open
  // buckets derived theirs as `targetAvg+3`. Identical at 4, divergent the
  // moment the target moves. Don't reintroduce a literal here.
  function queueAgeBand(d, targetAvg) {
    if (d == null) return '';
    return d <= targetAvg ? 'good' : d <= targetAvg + 3 ? 'mid' : 'bad';
  }

  // Trend label dead bands. The dashboard trend compares 3-wk avg cycle deltas
  // (±0.1d); compose compares weekly medians (±0.3d). The two calculations
  // differ on purpose — only the labels and thresholds are shared.
  const TREND_BAND_AVG = 0.1;
  const TREND_BAND_MED = 0.3;
  function trendLabel(current, previous, band) {
    if (current == null || previous == null) return null;
    return current < previous - band ? 'Improving' : current > previous + band ? 'Slowing' : 'Stable';
  }

  return { DATA_CUTOFF, inScope, filterRows, normalizeName, isComplete, isWIP, everCompleted, effectiveComplete, wipAgeFrom,
    hasRepGrace, ssDaysOpen, inRepGrace, hasResurveySig, isResurveyDefect, isOpenResurvey,
    RS_CATEGORIES, rsCategories, rsCatLabel, fpy, avg, med, pct,
    wipOn, meanWipForWeek, avgWeeklyCompletions, lastCompleteWeekEnd, ssRatioForWeek, ssRatioLive, ssRatioBand,
    rollingClearance, weeklyFloor, clearanceAlarm, floorAlarm, floorBaseline, ALARM_CLEARANCE, ALARM_FLOOR_MULT,
    businessDays, weekDaysRemaining, buildShowRates, buildExpectedCt,
    buildSegmentAvgs, lookupSegmentAvg, buildWeekdayShape, buildProjectionModel, projectWeek,
    bandFor, queueAgeBand, TREND_BAND_AVG, TREND_BAND_MED, trendLabel };
});
