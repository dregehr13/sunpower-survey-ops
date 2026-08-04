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

  // A resurvey still outstanding. The `list !== 'Complete'` clause is load-
  // bearing: 18 rows carry a resurvey request with no Resurvey Complete Date
  // but have gone back to list 'Complete' — the resurvey was resolved and the
  // date field was never filled in. Testing only the dates counts those as
  // open. It happens not to matter on the WIP page (which pre-filters to
  // isWIP, so those rows never reach it), but any surface that runs this over
  // completed rows needs the stricter test.
  const isOpenResurvey = r => !!(r.resurvey_requested && !r.resurvey_complete && r.list !== 'Complete');

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

  // Weekly projection, per row: each scheduled-remaining survey contributes its
  // resource's measured show-rate; each unscheduled WIP survey contributes the
  // probability it flows through before week's end, min(daysRemaining/ct, 1),
  // with ct from its rep/region/resource context.
  function projectWeekTotal(completed, schedRows, unschedRows, ctx) {
    const { daysRemaining, showRates, expectedCt } = ctx;
    if (!(daysRemaining > 0)) return completed;
    let exp = 0;
    schedRows.forEach(r => {
      const sr = showRates.byResource[r.resource || ''];
      exp += sr != null ? sr : showRates.global;
    });
    unschedRows.forEach(r => {
      exp += Math.min(daysRemaining / Math.max(expectedCt(r), 1), 1);
    });
    return completed + Math.round(exp);
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

  // The floor of the weekly WIP cycle: open WIP the day after weekEndISO, once
  // the weekend buildup has drained. Robust to the Fri/Sat rhythm by
  // construction — it is measured after the drain, not on a fixed weekday, so
  // the name describes the concept (the week's low point) rather than the
  // mechanism (today that low point lands the day after Monday).
  function weeklyFloor(rows, weekEndISO) {
    return wipOn(rows, _isoAddDays(weekEndISO, 1));
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

  // Trend label dead bands. The dashboard trend compares 3-wk avg cycle deltas
  // (±0.1d); compose compares weekly medians (±0.3d). The two calculations
  // differ on purpose — only the labels and thresholds are shared.
  const TREND_BAND_AVG = 0.1;
  const TREND_BAND_MED = 0.3;
  function trendLabel(current, previous, band) {
    if (current == null || previous == null) return null;
    return current < previous - band ? 'Improving' : current > previous + band ? 'Slowing' : 'Stable';
  }

  return { DATA_CUTOFF, inScope, filterRows, normalizeName, isComplete, isWIP, everCompleted, wipAgeFrom,
    hasRepGrace, ssDaysOpen, inRepGrace, hasResurveySig, isOpenResurvey, avg, med, pct,
    wipOn, meanWipForWeek, avgWeeklyCompletions, lastCompleteWeekEnd, ssRatioForWeek, ssRatioLive, ssRatioBand,
    rollingClearance, weeklyFloor, clearanceAlarm, floorAlarm, floorBaseline, ALARM_CLEARANCE, ALARM_FLOOR_MULT,
    businessDays, weekDaysRemaining, buildShowRates, buildExpectedCt,
    buildSegmentAvgs, lookupSegmentAvg, projectWeekTotal, bandFor, TREND_BAND_AVG, TREND_BAND_MED, trendLabel };
});
