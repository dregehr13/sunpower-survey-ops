// lib/qa-baseline.cjs — what a QA run is expected to find on a real report, without the report.
//
// A baseline entry is the template, the suggested status, the counts and one line per finding
// (id, status, severity), keyed by the report's SHA-256. It holds no customer text: titles and
// details are left out because details can carry addresses. `diff` says what moved when the engine
// or a spec changes, so a change can be accepted on purpose rather than found out by hand.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpsQABaseline = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const key = f => f.id + (/^tpl:/.test(f.id) ? '|' + f.title : '');

  function entryOf(det, R) {
    const items = R.findings.filter(f => f.status !== 'na').map(f => ({ k: key(f), s: f.status + (f.verify ? '+verify' : ''), v: f.severity || '' }));
    items.sort((a, b) => a.k.localeCompare(b.k) || a.s.localeCompare(b.s));
    return { template: (det.specId || det.vendor) + (det.partial ? ' partial' : ''), suggested: R.suggestedStatus, counts: R.counts, findings: items };
  }

  function diff(was, now) {
    const out = [];
    if (was.template !== now.template) out.push(`template ${was.template} → ${now.template}`);
    if (was.suggested !== now.suggested) out.push(`status ${was.suggested} → ${now.suggested}`);
    const idx = list => { const m = new Map(); list.forEach(f => m.set(f.k, f)); return m; };
    const a = idx(was.findings), b = idx(now.findings);
    for (const [k, f] of b) {
      const g = a.get(k);
      if (!g) out.push(`new: ${k} (${f.s}${f.v ? ', ' + f.v : ''})`);
      else if (g.s !== f.s || g.v !== f.v) out.push(`changed: ${k} ${g.s}${g.v ? ' ' + g.v : ''} → ${f.s}${f.v ? ' ' + f.v : ''}`);
    }
    for (const k of a.keys()) if (!b.has(k)) out.push(`gone: ${k}`);
    return out;
  }

  return { entryOf, diff };
});
