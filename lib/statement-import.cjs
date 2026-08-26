// lib/statement-import.cjs — parse a vendor statement workbook and merge it
// into billing.json's history.
//
// Pulled out of parse-radicl.js so the CLI and the in-app "Import statement"
// button on the Billing page (api/update-billing.js) run the exact same
// parser and the exact same merge rule. Two entry points reading one function
// is the same discipline lib/billing.cjs already holds for the vendor spec —
// onboarding a statement should never mean writing a second parser.
const XLSX = require('xlsx');
const { basename } = require('path');
const OpsBilling = require('./billing.cjs');

const isoDate = v => {
  if (v == null || v === '') return '';
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return '';
};

// A statement's identity is its vendor plus its filename. These are named by
// period ("Sunpower 07.01.26-08.08.26.xlsx"), so the name is meaningful and
// stable, and re-importing the same file updates rather than duplicates.
const statementId = (vendorId, filename) => vendorId + '/' + basename(filename).replace(/\.xlsx?$/i, '');

// `wb` is an already-loaded SheetJS workbook (XLSX.readFile for the CLI,
// XLSX.read(buffer) for the API) — reading the file is the caller's job so
// this stays usable from either a path or an in-memory upload.
function parseWorkbookLines(wb, vendorId) {
  const SPEC = OpsBilling.vendor(vendorId);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });

  // Find the header row rather than assuming row 1 — these statements carry a
  // balance figure in the header row's trailing cell and could gain a title.
  // A spec column is one label or a list of accepted ones (vendors rename
  // columns between statements) — take whichever alias this sheet carries.
  const labelsFor = v => (Array.isArray(v) ? v : [v]);
  let hdrRow = -1, map = {};
  for (let i = 0; i < Math.min(grid.length, 20); i++) {
    const cells = grid[i].map(c => String(c || '').trim().toLowerCase());
    const found = {};
    Object.entries(SPEC.columns).forEach(([k, label]) => {
      for (const alias of labelsFor(label)) {
        const idx = cells.indexOf(alias);
        if (idx >= 0) { found[k] = idx; break; }
      }
    });
    if (found.name != null && found.units != null && found.subtype != null) { hdrRow = i; map = found; break; }
  }
  if (hdrRow < 0) {
    // Name the columns that are actually missing, not the whole map — the
    // failure is nearly always one renamed column, and a list of seven
    // labels that "did not match" hides which one.
    const seen = new Set(grid.slice(0, Math.min(grid.length, 20))
      .flatMap(r => r.map(c => String(c || '').trim().toLowerCase())).filter(Boolean));
    const missing = ['name', 'units', 'subtype']
      .filter(k => !labelsFor(SPEC.columns[k]).some(a => seen.has(a)))
      .map(k => labelsFor(SPEC.columns[k]).map(a => `"${a}"`).join(' or '));
    throw new Error(`no header row matching the ${SPEC.name} column map — looked for `
      + `${missing.join(', ')} and found none of them. If ${SPEC.name} renamed a column, `
      + `add the new label to its column map in lib/billing.cjs.`);
  }

  const lines = [];
  for (let i = hdrRow + 1; i < grid.length; i++) {
    const row = grid[i];
    const units = Number(row[map.units]);
    if (!Number.isFinite(units)) continue;
    const name = String(row[map.name] == null ? '' : row[map.name]).trim();
    if (!name) continue;
    lines.push({
      vendor: vendorId,
      name,
      address: String(row[map.address] == null ? '' : row[map.address]).trim(),
      date: isoDate(row[map.date]),
      type: String(row[map.type] == null ? '' : row[map.type]).trim(),
      subtype: String(row[map.subtype] == null ? '' : row[map.subtype]).trim(),
      units,
      balance: map.balance != null && Number.isFinite(Number(row[map.balance])) ? Number(row[map.balance]) : null,
    });
  }
  return lines;
}

// What makes two lines THE SAME CHARGE rather than two charges that look
// alike. Deliberately strict — the whole normalised name and address, not
// OpsBilling.accountKey(), which is surname plus street number and is
// deliberately fuzzy because its job is matching a statement to Salesforce.
// Here a false positive silently deletes money that was really billed, so the
// safe direction is to keep a line and let it be flagged rather than drop it.
// Amount is part of the identity: a corrected re-bill is a different charge.
const lineIdentity = l => JSON.stringify([
  l.vendor || OpsBilling.DEFAULT_VENDOR,
  OpsBilling.norm(l.name), OpsBilling.norm(l.address),
  l.date || '', l.type || '', l.subtype || '', l.units,
]);

// Statements overlap — Radicl's 08.24.26 statement re-reports everything from
// Aug 1-8 that the 07.01.26-08.08.26 one already billed — so the same charge
// arrives twice and the history counted it twice. Doug's call 2026-08-26: keep
// ONE copy, and reserve the "billed twice" alarm for charges that differ.
//
// COUNT-AWARE, not "drop every repeat". A statement legitimately carries the
// same line more than once: 10 groups in the live data, up to 3 travel adders
// for one account on one day. So per identity the history keeps as many copies
// as the statement that reported the MOST of them, which is exactly the number
// actually billed. Ties go to the earlier period, so a charge stays attributed
// to the statement that first reported it.
//
// Nothing is lost: every kept line records the other statements it also
// appeared on in `alsoOn`, and each statement's `dupes` count says how much of
// it was already in the history. Recomputed over the whole history on every
// merge, so it is self-healing rather than a running tally that can drift.
function dedupeHistory(history) {
  // "Which statement reported this first": period start, then import date,
  // then id so the order is total and the result never depends on the order
  // statements happen to sit in the file.
  const statements = (history.statements || []).map(s => ({ ...s }));
  const rank = new Map();
  [...statements]
    .sort((a, b) => String(a.from).localeCompare(String(b.from))
      || String(a.imported).localeCompare(String(b.imported))
      || String(a.id).localeCompare(String(b.id)))
    .forEach((s, i) => rank.set(s.id, i));
  const rankOf = id => (rank.has(id) ? rank.get(id) : Number.MAX_SAFE_INTEGER);

  const groups = new Map();
  (history.lines || []).forEach(l => {
    const k = lineIdentity(l);
    let g = groups.get(k); if (!g) { g = new Map(); groups.set(k, g); }
    const st = l.statement || '';
    let arr = g.get(st); if (!arr) { arr = []; g.set(st, arr); }
    arr.push(l);
  });

  const out = [];
  const droppedBy = new Map();
  groups.forEach(g => {
    if (g.size === 1) { [...g.values()][0].forEach(l => out.push(l)); return; }
    const byCount = [...g.entries()]
      .sort((a, b) => b[1].length - a[1].length || rankOf(a[0]) - rankOf(b[0]));
    const [, winners] = byCount[0];
    const also = byCount.slice(1).map(([st, ls]) => {
      droppedBy.set(st, (droppedBy.get(st) || 0) + ls.length);
      return st;
    });
    winners.forEach(l => out.push({ ...l, alsoOn: also }));
  });

  statements.forEach(s => { s.dupes = droppedBy.get(s.id) || 0; });
  const dropped = [...droppedBy.values()].reduce((a, n) => a + n, 0);
  return { statements, lines: out, dropped, droppedBy };
}

// Replaces this statement's own lines in place, appends the rest of history
// untouched, then dedupes the whole history. `history` is
// `{ statements: [], lines: [] }` — the shape billing.json is stored in.
// Never mutates the object passed in.
function mergeStatement(history, vendorId, filename, lines) {
  const base = history && Array.isArray(history.lines) ? history : { statements: [], lines: [] };
  const id = statementId(vendorId, filename);
  const dates = lines.map(l => l.date).filter(Boolean).sort();

  const statements = base.statements.filter(s => s.id !== id);
  const before = base.lines.length;
  // Re-importing this statement also clears it from every other line's
  // alsoOn: that record says "this charge also arrived on <id>", and the
  // incoming file is now the only authority on what <id> contains.
  const keptLines = base.lines.filter(l => l.statement !== id).map(l => {
    if (!Array.isArray(l.alsoOn) || !l.alsoOn.includes(id)) return l;
    const rest = l.alsoOn.filter(x => x !== id);
    const copy = { ...l };
    if (rest.length) copy.alsoOn = rest; else delete copy.alsoOn;
    return copy;
  });
  const replaced = before - keptLines.length;

  const newLines = lines.map((l, i) => ({ ...l, statement: id, line: i + 1 }));
  const meta = { id, vendor: vendorId, file: basename(filename), from: dates[0] || '',
    to: dates[dates.length - 1] || '', lines: lines.length, imported: new Date().toISOString().slice(0, 10) };
  statements.push(meta);

  const merged = dedupeHistory({ statements, lines: [...keptLines, ...newLines] });
  const allLines = merged.lines
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.line || 0) - (b.line || 0));
  merged.statements.sort((a, b) => String(a.from).localeCompare(String(b.from)));

  return {
    history: { statements: merged.statements, lines: allLines, updated: new Date().toISOString() },
    meta: merged.statements.find(s => s.id === id) || meta,
    replaced,
    deduped: merged.droppedBy.get(id) || 0,
    dropped: merged.dropped,
    charged: lines.filter(OpsBilling.isCharge).reduce((s, l) => s + Math.abs(l.units), 0),
  };
}

// Overlapping statement periods, same vendor — usually the reason a charge
// looks duplicated when it is really the same work reported twice.
function overlapWarnings(history) {
  const out = [];
  const st = (history.statements || []).filter(s => s.from && s.to);
  for (let i = 1; i < st.length; i++) {
    if (st[i].vendor === st[i - 1].vendor && st[i].from <= st[i - 1].to) {
      out.push(`${st[i].id} overlaps ${st[i - 1].id} (${st[i].from} <= ${st[i - 1].to})`);
    }
  }
  return out;
}

module.exports = { isoDate, statementId, parseWorkbookLines, lineIdentity, dedupeHistory, mergeStatement, overlapWarnings };
