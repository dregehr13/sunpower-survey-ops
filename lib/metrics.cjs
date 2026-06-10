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
  function filterRows(raw, cutoff) { return raw.filter(r => inScope(r, cutoff)); }

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

  return { DATA_CUTOFF, inScope, filterRows, isComplete, isWIP, wipAgeFrom, hasResurveySig, avg, med, pct };
});
