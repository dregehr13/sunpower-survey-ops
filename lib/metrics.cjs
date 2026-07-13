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

  // Row scope: active projects started on/after the cutoff
  function inScope(r, cutoff) {
    cutoff = cutoff || DATA_CUTOFF;
    return (r.project_status === 'In Progress' || r.project_status === 'Change Order') && r.start >= cutoff;
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

  // Any signal that a resurvey happened. reopened_by_design is a string '0'/'1' flag.
  const hasResurveySig = r => !!(r.resurvey_requested || r.resurvey_complete || r.resurvey_reason || r.reopened_by_design === '1');

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

  // Weekly projection: completed so far + 90% of scheduled remaining +
  // unscheduled WIP flowing at the recent avg cycle time × business days left.
  function projectWeekTotal(completed, scheduledRem, unscheduledWip, recentAvgCt, daysRemaining) {
    return daysRemaining > 0
      ? completed + Math.round(scheduledRem * 0.9 + unscheduledWip / recentAvgCt * daysRemaining)
      : completed;
  }

  // Status band vs target: ≤target good, ≤target+2 mid, else bad. null → ''.
  function bandFor(v, target) {
    if (v == null) return '';
    return v <= target ? 'good' : v <= target + 2 ? 'mid' : 'bad';
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

  return { DATA_CUTOFF, inScope, filterRows, normalizeName, isComplete, isWIP, wipAgeFrom, hasResurveySig, avg, med, pct,
    businessDays, buildSegmentAvgs, lookupSegmentAvg, projectWeekTotal, bandFor, TREND_BAND_AVG, TREND_BAND_MED, trendLabel };
});
