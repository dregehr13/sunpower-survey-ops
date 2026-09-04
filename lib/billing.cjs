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
      // Vendors rename columns between statements: the monthly remittances head
      // this "Mission Date", the YTD export just "Date". Newest first.
      columns: { name: 'name', address: 'address', date: ['mission date', 'date'],
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
      // SERVICE LINES, read off the statement's `type` column. A vendor can
      // bill us for more than one book of business: Radicl's YTD statement
      // carries O&M visits (Quality Check, Service) beside site surveys. They
      // are real money and belong in the history, but they are not survey
      // cost, and averaging them into a per-survey figure quietly overstates
      // what a survey costs. Anything not listed lands in `other` so a new
      // service line shows up as its own segment rather than being absorbed.
      services: {
        survey: ['Survey'],
        om:     ['O&M'],
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
  // Which book of business a line belongs to. Topups are not a service: they
  // are money going in, not work coming out, so they are excluded from every
  // dollar figure on the page and from the segment control.
  const SERVICES = { SURVEY: 'survey', OM: 'om', OTHER: 'other', TOPUP: 'topup' };
  const SERVICE_LABELS = { survey: 'Site survey', om: 'O&M', other: 'Other' };
  function lineService(line, v) {
    if (!line) return SERVICES.OTHER;
    const spec = vendor(v || line.vendor);
    if (spec.topupPattern.test(String(line.type || ''))) return SERVICES.TOPUP;
    const t = String(line.type || '');
    const table = spec.services || {};
    for (const [k, labels] of Object.entries(table)) if (labels.includes(t)) return k;
    return SERVICES.OTHER;
  }
  const isSurveyService = l => lineService(l) === SERVICES.SURVEY;

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
      why: 'Billed work with no matching survey in the export. Usually a name or address written differently on one side; it can also be a survey we have no record of requesting.' },
    { k: 'own_defect_rebill', label: 'Rework on their own defect', sev: SEVERITY.HIGH,
      why: 'A return billed at the full first-visit rate, on a survey this vendor performed and Salesforce attributes to the surveyor. Whether it is billable is a contract question.' },
    { k: 'duplicate_charge', label: 'Same charge billed twice', sev: SEVERITY.HIGH,
      why: 'The same account billed the same charge type more than once. Each line carries the charge it repeats, with the gap between them: same day reads as a double bill, months apart reads as a second visit, and the rule cannot tell them apart. Take the list to the vendor rather than treating it as a finding.' },
    { k: 'cross_statement', label: 'Re-billed on another statement', sev: SEVERITY.HIGH,
      why: 'The same account and charge type on two statements, carrying DIFFERENT dates. A moved date is the shape a double bill takes, because neither statement shows the other. Same date is the ordinary overlap and is stored once, not flagged.' },
    { k: 'cleanup_of_other', label: "Cleanup of someone else's survey", sev: SEVERITY.INFO,
      why: 'A return to finish a survey another resource started, billed at the full first-visit rate. Not disputable — it is what an incomplete first survey costs.' },
    { k: 'repeat_visit', label: 'Second visit to the same account', sev: SEVERITY.INFO,
      why: 'More than one work charge on one account. Usually a first visit and a return; no single line shows what the account cost in total.' },
    { k: 'epc_account', label: 'External EPC account', sev: SEVERITY.INFO,
      why: 'Every charge on an account whose project was sold through an external EPC, travel and demob included, matched to the EPC registry rather than to the survey export. Real work we were billed for; it carries cost but no survey resource or dates, so it cannot contribute to cycle time or first pass yield.' },
    // `derivable`: this rule's population is exactly a charge subtype —
    // `isTravel(l)` is the same test the Charge column prints. It earns its
    // chip, which is where the $113k figure lives, but printing it again in a
    // row's "Also flagged" cell restates that row's own charge type nine
    // pixels away. Contrast own_defect_rebill, which is 18 of 49 Go Backs, and
    // cleanup_of_other, which is every Partial Survey today but asserts the
    // original was someone else's and can stop being.
    { k: 'travel_adder', label: 'Travel adder', sev: SEVERITY.INFO, derivable: true,
      why: 'A travel adder beyond the vendor’s free radius. Not an error — tracked because it is a quarter of the bill, and the one line a local surveyor removes outright.' },
  ];
  const exceptionMeta = k => EXCEPTIONS.find(e => e.k === k) || null;
  const isDispute = f => { const m = exceptionMeta(f); return !!m && m.sev !== SEVERITY.INFO; };

  // Reconcile a whole history against Salesforce. `lines` is every line ever
  // imported across all statements — history is what makes the duplicate check
  // possible, and why importing the same statement twice must not silently merge.
  // `epcRows` is the external-EPC account registry (epc.json). It is tried
  // ONLY where Salesforce has nothing, and never in preference to it: an SF row
  // carries the survey resource, the dates and the resurvey history, and an EPC
  // row carries none of that, so a line that can be matched to Salesforce must
  // be. What the registry buys is that a survey we really performed and really
  // paid for stops reading as a missing record just because the project was
  // sold through somebody else's EPC.
  // `archiveRows` is the pre-cutoff project registry (archive.json). A vendor
  // bills in the month it surveys, not the month the project started, so a
  // January statement carries work on projects sold the previous summer, which
  // sit outside the dashboard's window. They are OURS and carry a real status,
  // so they are tried before the EPC registry and group by outcome normally.
  function reconcile(lines, surveyRows, epcRows, archiveRows) {
    const index = indexSurveys(surveyRows);
    const archiveIndex = indexSurveys(archiveRows || []);
    const epcIndex = indexSurveys(epcRows || []);
    const out = (lines || []).map(l => ({ ...l, vendor: l.vendor || DEFAULT_VENDOR, match: null, score: 0, flags: [] }));

    out.forEach(l => {
      if (lineKind(l) === KINDS.TOPUP) return;
      const m = matchLine(l, index);
      if (m.row) { l.match = m.row; l.score = m.score; l.matchSource = 'sf'; return; }
      const a = matchLine(l, archiveIndex);
      if (a.row) { l.match = a.row; l.score = a.score; l.matchSource = 'archive'; l.archived = true; return; }
      const e = matchLine(l, epcIndex);
      if (e.row) { l.match = e.row; l.score = e.score; l.matchSource = 'epc'; l.epc = true; return; }
      l.match = null; l.score = m.score;
    });

    const seen = new Map();
    const chron = [...out].sort((a, b) =>
      String(a.date || '').localeCompare(String(b.date || '')) || (a.line || 0) - (b.line || 0));

    chron.forEach(l => {
      if (!isCharge(l)) return;
      const key = l.vendor + '|' + accountKey(l.name, l.address);
      const prior = seen.get(key) || [];

      // NOT inside the isWork block, unlike no_sf_match beside it. That rule
      // asks "is there a survey behind this visit", which only a work line can
      // answer. This one says whose project the account belongs to, which is
      // true of every line the account drew — its travel adders and demobs
      // included. Work-only, the chip showed $9,203 against the $11,077 the
      // outcome lens reported for the same population.
      if (l.epc) l.flags.push('epc_account');

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
          // Two statements, same charge type, DIFFERENT dates. Same-date is
          // deliberately not flagged: overlapping statement periods re-report
          // the same charge as a matter of course, and the import now stores
          // one copy of it (dedupeHistory in lib/statement-import.cjs), so an
          // identical pair cannot reach here anyway. A charge that moved date
          // between statements is the one worth a person's time — Doug's call
          // 2026-08-26.
          if (priorWork.some(p => p.subtype === l.subtype && p.statement !== l.statement && p.date !== l.date)) {
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

  // What the work cost, cut by what became of the project it was done for.
  //
  // Only visible since the 2026-08-26 report change brought canceled projects
  // into the export — before it there was exactly ONE canceled row in scope, so
  // every dollar looked like it was spent on a live deal. It is not an
  // exception and must never be rendered as one: the surveys were all performed
  // before the cancellation, so this is the cost of doing business, not a
  // billing error. Doug's call 2026-08-26. It is worth a surface anyway because
  // it is a fifth of vendor spend and nothing else on the page could show it.
  //
  // Cut by `project_status` on the MATCHED survey row, not by `opp_stage` —
  // stage disagrees with status on 4 rows in 3,791 and on 2 billed lines out of
  // 624, so it would draw the same picture from a field with no history behind
  // it. An unmatched line has no project to have an outcome, and gets its own
  // bucket rather than being dropped: it is the same population the
  // no_sf_match rule counts, and silently omitting it would stop the shares
  // from summing to the invoiced total.
  // NOT "No Salesforce record", which is the no_sf_match exception's label: that
  // rule only fires on WORK lines, so the chip and this bucket would carry the
  // same name and different money on one screen ($2,272 against $2,942 live —
  // the gap is the travel adders those visits drew). The Visits column still
  // reconciles to the chip exactly; the name is what has to differ.
  const OUTCOME_UNMATCHED = 'No project matched';
  const OUTCOME_EPC = 'Sold through an external EPC';
  function byOutcome(lines) {
    const charges = (lines || []).filter(isCharge);
    const m = new Map();
    charges.forEach(l => {
      // An EPC-matched line is its own group rather than folded into the
      // SunPower project statuses beside it: the two populations are different
      // books, and mixing them would make "14% of spend went to canceled
      // projects" a statement about neither one.
      const k = l.epc ? OUTCOME_EPC
        : l.match ? (l.match.project_status || 'Unknown') : OUTCOME_UNMATCHED;
      let e = m.get(k);
      if (!e) e = m.set(k, { status: k, lines: [], units: 0, visits: 0, first: 0, accounts: new Set(),
                             vendor: l.vendor, matched: !!l.match }).get(k);
      e.lines.push(l); e.units += Math.abs(l.units || 0);
      if (isWork(l)) e.visits++;
      // Per survey means per PROPERTY here too. Divided by visits it was a
      // second definition of the same words on the same page as the rail.
      if (subtypeRole(l) === 'first') e.first++;
      e.accounts.add(l.vendor + '|' + accountKey(l.name, l.address));
    });
    const total = charges.reduce((s, l) => s + Math.abs(l.units || 0), 0);
    return [...m.values()].map(e => ({
      status: e.status,
      matched: e.matched,
      // Canceled is the only outcome that is settled. At-Risk is a project on
      // its way somewhere, not a loss, and adding the two would report a
      // number that keeps changing as those projects resolve either way.
      dead: e.status === 'Canceled',
      epc: e.status === OUTCOME_EPC,
      lines: e.lines,
      n: e.lines.length,
      visits: e.visits,
      surveyed: e.first,
      accounts: e.accounts.size,
      units: e.units,
      usd: usd(e.units, e.vendor),
      share: total ? e.units / total : null,
      perSurvey: e.first ? usd(e.units, e.vendor) / e.first : null,
    })).sort((a, b) => b.units - a.units);
  }

  // Charges are stored negative on the statement; every figure here is positive.
  function summarize(lines) {
    const charges = (lines || []).filter(isCharge);
    const units = charges.reduce((s, l) => s + Math.abs(l.units || 0), 0);
    const work = charges.filter(isWork);
    const travel = charges.filter(isTravel);
    const travelUnits = travel.reduce((s, l) => s + Math.abs(l.units || 0), 0);
    // PROPERTIES, not visits. Every work subtype bills at the same rate, so a
    // cleanup visit adds one to the numerator AND one to the denominator and
    // per-visit barely moves: in July cleanup hit 1.65 visits per property and
    // the per-visit figure went DOWN, from $391 to $378, while per-property
    // went from $527 to $624. A cost metric that improves as quality falls is
    // worse than no metric. `first` visits are the denominator that carries a
    // property's own rework, which is the question anyone asking "what does a
    // survey cost" is actually asking. Per-visit survives for the two jobs it
    // is honest at: comparing one vendor's rate to another's, and capacity.
    const first = work.filter(l => subtypeRole(l) === 'first');
    // What a survey costs once we stop counting the ones nobody will use. Same
    // numerator: every dollar is in both figures, cancelled work included. The
    // denominator drops properties whose project has since died, so their cost
    // lands on the surveys that are still going somewhere.
    const firstLive = first.filter(l => !(l.match && l.match.project_status === 'Canceled'));
    const cleanup = work.filter(l => subtypeRole(l) === 'cleanup');
    const rework = work.filter(l => subtypeRole(l) === 'rework');
    const disputed = charges.filter(l => (l.flags || []).some(isDispute));
    const v = (work[0] || charges[0] || {}).vendor;
    const topups = (lines || []).filter(l => lineKind(l) === KINDS.TOPUP);
    return {
      lines: (lines || []).length,
      surveys: work.length,
      units, usd: usd(units, v),
      surveyed: first.length,
      perSurvey: first.length ? usd(units, v) / first.length : null,
      perVisit: work.length ? usd(units, v) / work.length : null,
      liveSurveyed: firstLive.length,
      perLiveSurvey: firstLive.length ? usd(units, v) / firstLive.length : null,
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
    SERVICES, SERVICE_LABELS, lineService, isSurveyService,
    norm, tokens, streetNumber, billingTown, accountKey, scoreMatch, MATCH_THRESHOLD,
    OUTCOME_UNMATCHED, OUTCOME_EPC, byOutcome,
    indexSurveys, matchLine, isOwnDefectRebill, isCleanup,
    SEVERITY, EXCEPTIONS, exceptionMeta, isDispute,
    reconcile, byAccount, summarize, byFlag };
});
