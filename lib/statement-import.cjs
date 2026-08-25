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
  let hdrRow = -1, map = {};
  for (let i = 0; i < Math.min(grid.length, 20); i++) {
    const cells = grid[i].map(c => String(c || '').trim().toLowerCase());
    const found = {};
    Object.entries(SPEC.columns).forEach(([k, label]) => {
      const idx = cells.indexOf(label);
      if (idx >= 0) found[k] = idx;
    });
    if (found.name != null && found.units != null && found.subtype != null) { hdrRow = i; map = found; break; }
  }
  if (hdrRow < 0) {
    throw new Error(`no header row matching the ${SPEC.name} column map (${Object.values(SPEC.columns).join(', ')})`);
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

// Replaces this statement's own lines in place and appends the rest of
// history untouched. `history` is `{ statements: [], lines: [] }` — the
// shape billing.json is stored in. Never mutates the object passed in.
function mergeStatement(history, vendorId, filename, lines) {
  const base = history && Array.isArray(history.lines) ? history : { statements: [], lines: [] };
  const id = statementId(vendorId, filename);
  const dates = lines.map(l => l.date).filter(Boolean).sort();

  const statements = base.statements.filter(s => s.id !== id);
  const before = base.lines.length;
  const keptLines = base.lines.filter(l => l.statement !== id);
  const replaced = before - keptLines.length;

  const newLines = lines.map((l, i) => ({ ...l, statement: id, line: i + 1 }));
  const meta = { id, vendor: vendorId, file: basename(filename), from: dates[0] || '',
    to: dates[dates.length - 1] || '', lines: lines.length, imported: new Date().toISOString().slice(0, 10) };
  statements.push(meta);

  const allLines = [...keptLines, ...newLines]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.line || 0) - (b.line || 0));
  statements.sort((a, b) => String(a.from).localeCompare(String(b.from)));

  return {
    history: { statements, lines: allLines, updated: new Date().toISOString() },
    meta, replaced,
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

module.exports = { isoDate, statementId, parseWorkbookLines, mergeStatement, overlapWarnings };
