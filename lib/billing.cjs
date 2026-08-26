// lib/billing.cjs — third-party surveyor invoice reconciliation.
//
// Built around a VENDOR SPEC rather than around Radicl. Radicl is the only
// vendor today, but the shape of the problem — a statement of line items, a
// unit price, some subtypes that mean "we went back out", and a customer name
// and address that have to be matched to a Salesforce survey — is the same for
// any survey subcontractor. Adding one is a spec object plus a column map, not
// a second copy of this file.
//
// The parser and the Billing page both read this, so a rule can never mean two
// things in two places — the discipline metrics.cjs enforces for survey metrics.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpsBilling = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // ── Vendors ──────────────────────────────────────────────────────────────
  // `sfResource` is how Salesforce's Site Survey Resource field names the
  // vendor; it is what lets a billed line be checked against who Salesforce
  // thinks did the work. A vendor with no SF resource value can still be
  // reconciled on identity and history, just not on attribution.
  const VENDORS = {
    radicl: {
      id: 'radicl',
      name: 'Radicl Services',
      sfResource: 'Radicl Services',
      // Radicl prepays: a balance of credits is drawn down per job. Other
      // vendors may bill flat dollars — unitUsd of 1 with unit 'dollar'
      // makes the rest of this file work unchanged.
      unit: 'credit',
      unitUsd: 20,
      travelAdderUnits: 9,
      travelFreeRadiusMi: 50,
      // Statement columns, matched case-insensitively against a trimmed
      // header. A value may be a LIST of accepted labels, because a vendor
      // renames its columns without telling anyone: Radicl's 08.24.26
      // statement shipped "Total Credits" and "Running Balance" where the
      // 07.01.26 one had "Credits" and "Running Credit Balance", and added an
      // Organization column that shifted every index. Aliases are listed
      // newest first and old ones are kept, so a re-import of an older
      // statement still parses. Position is never assumed — the column is
      // found by label — so a new column between two mapped ones costs
      // nothing.
      columns: { name: 'name', address: 'address', date: 'mission date',
        type: 'type', subtype: 'sub type',
        units: ['total credits', 'credits'],
        balance: ['running balance', 'running credit balance'] },
      topupPattern: /credits added/i,
      // Subtype taxonomy. `first` is an original visit; `cleanup` is finishing
      // a survey somebody else started; `rework` is a return to a job this
      // vendor already did. All three bill at the same rate, which is the most
      // important and least visible fact on the invoice.
      subtypes: {
        first:   ['Base'],
        cleanup: ['Partial Survey'],
        rework:  ['Go Back'],
        travel:  ['Travel'],
        other:   ['Demob'],
      },
    },
  };
  const vendor = id => VENDORS[id] || VENDORS.radicl;
  const DEFAULT_VENDOR = 'radicl';

  const usd = (units, v) => (units == null ? null : units * vendor(v).unitUsd);

  // ── Line taxonomy ────────────────────────────────────────────────────────
  const KINDS = { WORK: 'work', TRAVEL: 'travel', OTHER: 'other', TOPUP: 'topup' };
  const workSubtypes = v => {
    const s = vendor(v).subtypes;
    return [...s.first, ...s.cleanup, ...s.rework];
  };
  function lineKind(line, v) {
    if (!line) return KINDS.OTHER;
    const spec = vendor(v || line.vendor);
    if (spec.topupPattern.test(String(line.type || ''))) return KINDS.TOPUP;
    const st = String(line.subtype || '');
    if (workSubtypes(spec.id).includes(st)) return KINDS.WORK;
    if (spec.subtypes.travel.includes(st)) return KINDS.TRAVEL;
    return KINDS.OTHER;
  }
  const isWork = l => lineKind(l) === KINDS.WORK;
  const isTravel = l => lineKind(l) === KINDS.TRAVEL;
  const isCharge = l => lineKind(l) !== KINDS.TOPUP && (l.units || 0) < 0;
  const subtypeRole = (line) => {
    const s = vendor(line.vendor).subtypes;
    const st = String(line.subtype || '');
    if (s.first.includes(st)) return 'first';
    if (s.cleanup.includes(st)) return 'cleanup';
    if (s.rework.includes(st)) return 'rework';
    if (s.travel.includes(st)) return 'travel';
    return 'other';
  };

  // ── Identity ─────────────────────────────────────────────────────────────
  // Statements carry a customer name and a street address; Salesforce carries
  // a primary contact and a full installation address. Neither side has a key
  // the other shares, so matching is fuzzy by necessity — which is why it
  // returns a score the UI shows rather than asserting a silent match.
  function norm(s) {
    return String(s == null ? '' : s)
      .normalize('NFKD').toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/).filter(Boolean).join(' ');
  }
  const tokens = s => new Set(norm(s).split(' ').filter(Boolean));
  function streetNumber(addr) {
    const m = /^\s*(\d+)/.exec(String(addr || ''));
    return m ? m[1] : '';
  }
  // Billing writes "123 Main St, Springfield"; Salesforce writes
  // "123 Main St Springfield, IL 62704".
  function billingTown(addr) {
    const s = String(addr || '');
    return s.includes(',') ? norm(s.slice(s.indexOf(',') + 1)) : '';
  }
  // "This account", stable against the formatting differences between the two
  // systems and against a statement writing "Dominic Catalano Catalano".
  function accountKey(name, addr) {
    const parts = norm(name).split(' ').filter(Boolean);
    return (parts.length ? parts[parts.length - 1] : '') + '|' + streetNumber(addr);
  }

  const MATCH_THRESHOLD = 4;
  function scoreMatch(line, row) {
    if (!line || !row) return 0;
    if (streetNumber(line.address) !== streetNumber(row.address)) return 0;
    let s = 0;
    const rowTok = tokens(row.contact);
    s += [...tokens(line.name)].filter(t => rowTok.has(t)).length * 2;
    const town = billingTown(line.address);
    if (town && norm(row.address).includes(town)) s += 3;
    const rowAddr = tokens(row.address);
    if ([...tokens(line.address)].filter(t => rowAddr.has(t)).length >= 2) s += 2;
    return s;
  }
  function indexSurveys(rows) {
    const byStreet = new Map();
    (rows || []).forEach(r => {
      const k = streetNumber(r.address);
      let b = byStreet.get(k); if (!b) { b = []; byStreet.set(k, b); }
      b.push(r);
    });
    return { byStreet };
  }
  function matchLine(line, index) {
    const cands = index.byStreet.get(streetNumber(line.address)) || [];
    let best = null, score = 0;
    cands.forEach(r => { const s = scoreMatch(line, r); if (s > score) { score = s; best = r; } });
    return score >= MATCH_THRESHOLD ? { row: best, score } : { row: null, score };
  }

  // ── Exception rules ──────────────────────────────────────────────────────
  // Each rule is a PROMPT TO CHECK, never a verdict. The tool knows what the
  // invoice says and what Salesforce says, and where the two disagree; it does
  // not know the contract. An exception worded as an accusation gets ignored
  // the first time one turns out to be legitimate.
  const SEVERITY = { HIGH: 'high', MED: 'med', INFO: 'info' };

  // Rework on a job this vendor did first time, where Salesforce blames the
  // surveyor. Both halves matter: attribution alone is not enough, because a
  // rep-performed survey is also attributed to "Surveyor" — meaning the rep.
  // Reading attribution without checking who held the original survey is what
  // turns 1 case into an apparent 4.
  function isOwnDefectRebill(line, row) {
    if (!row || subtypeRole(line) !== 'rework') return false;
    return row.resurvey_attributed === 'Surveyor' && row.resource === vendor(line.vendor).sfResource;
  }

  // Finishing a survey somebody else started. Not an error and not disputable
  // — it is the price of the first survey having been incomplete, and it is
  // invisible on the invoice because it bills at the same rate as a fresh one.
  function isCleanup(line, row) {
    if (subtypeRole(line) !== 'cleanup') return false;
    if (!row) return true;
    return true;
  }
  const cleanupOrigin = (line, row) => (row && row.resource) || null;

  const EXCEPTIONS = [
    { k: 'no_sf_match', label: 'No Salesforce record', sev: SEVERITY.HIGH,
      why: 'Billed work with no matching survey in the export. Usually a name or address written differently on one side, but it can also be a survey we have no record of requesting.' },
    { k: 'own_defect_rebill', label: 'Rework on their own defect', sev: SEVERITY.HIGH,
      why: 'A return visit billed at the full first-visit rate, on a survey this vendor performed and that Salesforce attributes to the surveyor. Whether it is billable is a contract question.' },
    { k: 'duplicate_charge', label: 'Same charge billed twice', sev: SEVERITY.HIGH,
      why: 'The same account billed the same charge type more than once. A genuine second visit months later is possible, so the earlier line is shown beside it.' },
    { k: 'cross_statement', label: 'Appears on two statements', sev: SEVERITY.HIGH,
      why: 'The same account, charge type and date imported from two different statements. Either the statements overlap or the charge was billed twice.' },
    { k: 'cleanup_of_other', label: "Cleanup of someone else's survey", sev: SEVERITY.INFO,
      why: 'A return to finish a survey another resource started, billed at the full first-visit rate. Not disputable: it is what an incomplete first survey costs, and the invoice is the only place it is recorded.' },
    { k: 'repeat_visit', label: 'Second visit to the same account', sev: SEVERITY.INFO,
      why: 'More than one work charge on one account. Often a legitimate first visit and return, but no single line shows what the account cost in total.' },
    { k: 'travel_adder', label: 'Travel adder', sev: SEVERITY.INFO,
      why: 'A travel adder applied beyond the vendor’s free radius. Not an error. Tracked because it is a quarter of the bill, and the one line a surveyor based in the market removes outright.' },
  ];
  const exceptionMeta = k => EXCEPTIONS.find(e => e.k === k) || null;
  const isDispute = f => { const m = exceptionMeta(f); return !!m && m.sev !== SEVERITY.INFO; };

  // Reconcile a whole history against Salesforce. `lines` is every line ever
  // imported across all statements — history is what makes the duplicate check
  // possible, and why importing the same statement twice must not silently merge.
  function reconcile(lines, surveyRows) {
    const index = indexSurveys(surveyRows);
    const out = (lines || []).map(l => ({ ...l, vendor: l.vendor || DEFAULT_VENDOR, match: null, score: 0, flags: [] }));

    out.forEach(l => {
      if (lineKind(l) === KINDS.TOPUP) return;
      const m = matchLine(l, index);
      l.match = m.row; l.score = m.score;
    });

    const seen = new Map();
    const chron = [...out].sort((a, b) =>
      String(a.date || '').localeCompare(String(b.date || '')) || (a.line || 0) - (b.line || 0));

    chron.forEach(l => {
      if (!isCharge(l)) return;
      const key = l.vendor + '|' + accountKey(l.name, l.address);
      const prior = seen.get(key) || [];

      if (isWork(l)) {
        if (!l.match) l.flags.push('no_sf_match');
        if (isOwnDefectRebill(l, l.match)) l.flags.push('own_defect_rebill');
        if (isCleanup(l, l.match)) {
          l.flags.push('cleanup_of_other');
          l.cleanupOrigin = cleanupOrigin(l, l.match);
        }
        const priorWork = prior.filter(isWork);
        if (priorWork.length) {
          // A first visit followed by a return is a SEQUENCE, not a duplicate.
          // Only the same charge type twice is suspicious on its own.
          l.flags.push('repeat_visit');
          l.priorLines = priorWork.map(p => ({ statement: p.statement, date: p.date, subtype: p.subtype, units: p.units }));
          if (priorWork.some(p => p.subtype === l.subtype)) l.flags.push('duplicate_charge');
          if (priorWork.some(p => p.date === l.date && p.subtype === l.subtype && p.statement !== l.statement)) {
            l.flags.push('cross_statement');
          }
        }
      }
      if (isTravel(l)) l.flags.push('travel_adder');
      seen.set(key, [...prior, l]);
    });

    return out;
  }

  // What one account actually cost, across every line it drew. The invoice
  // never shows this and it is the number a build-vs-buy argument needs.
  function byAccount(lines) {
    const m = new Map();
    (lines || []).filter(isCharge).forEach(l => {
      const k = l.vendor + '|' + accountKey(l.name, l.address);
      let e = m.get(k);
      if (!e) { e = { key: k, vendor: l.vendor, name: l.name, address: l.address, lines: [], units: 0, visits: 0 }; m.set(k, e); }
      e.lines.push(l); e.units += Math.abs(l.units || 0);
      if (isWork(l)) e.visits++;
    });
    return [...m.values()].map(e => ({ ...e, usd: usd(e.units, e.vendor) }));
  }

  // Charges are stored negative on the statement; every figure here is positive.
  function summarize(lines) {
    const charges = (lines || []).filter(isCharge);
    const units = charges.reduce((s, l) => s + Math.abs(l.units || 0), 0);
    const work = charges.filter(isWork);
    const travel = charges.filter(isTravel);
    const travelUnits = travel.reduce((s, l) => s + Math.abs(l.units || 0), 0);
    const cleanup = work.filter(l => subtypeRole(l) === 'cleanup');
    const rework = work.filter(l => subtypeRole(l) === 'rework');
    const disputed = charges.filter(l => (l.flags || []).some(isDispute));
    const v = (work[0] || charges[0] || {}).vendor;
    const topups = (lines || []).filter(l => lineKind(l) === KINDS.TOPUP);
    return {
      lines: (lines || []).length,
      surveys: work.length,
      units, usd: usd(units, v),
      perSurvey: work.length ? usd(units, v) / work.length : null,
      travelUnits, travelUsd: usd(travelUnits, v),
      travelShare: units ? travelUnits / units : null,
      travelRate: work.length ? travel.length / work.length : null,
      cleanupN: cleanup.length,
      cleanupUsd: usd(cleanup.reduce((s, l) => s + Math.abs(l.units || 0), 0), v),
      reworkN: rework.length,
      reworkUsd: usd(rework.reduce((s, l) => s + Math.abs(l.units || 0), 0), v),
      toppedUp: topups.reduce((s, l) => s + Math.abs(l.units || 0), 0),
      disputed: disputed.length,
      disputedUsd: usd(disputed.reduce((s, l) => s + Math.abs(l.units || 0), 0), v),
    };
  }

  function byFlag(lines) {
    const m = {};
    (lines || []).forEach(l => (l.flags || []).forEach(f => {
      m[f] = m[f] || { n: 0, units: 0, vendor: l.vendor };
      m[f].n++; m[f].units += Math.abs(l.units || 0);
    }));
    return EXCEPTIONS.map(e => {
      const hit = m[e.k] || { n: 0, units: 0 };
      return { ...e, n: hit.n, units: hit.units, usd: usd(hit.units, hit.vendor) };
    });
  }

  return { VENDORS, vendor, DEFAULT_VENDOR, usd,
    KINDS, lineKind, isWork, isTravel, isCharge, subtypeRole, workSubtypes,
    norm, tokens, streetNumber, billingTown, accountKey, scoreMatch, MATCH_THRESHOLD,
    indexSurveys, matchLine, isOwnDefectRebill, isCleanup,
    SEVERITY, EXCEPTIONS, exceptionMeta, isDispute,
    reconcile, byAccount, summarize, byFlag };
});
