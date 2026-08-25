#!/usr/bin/env node
// parse-radicl.js — third-party surveyor statement (XLSX) → billing history
//
// Usage: node parse-radicl.js [--vendor <id>] <statement.xlsx> [more.xlsx ...]
//
// Column mapping, unit price and subtype taxonomy all come from the vendor
// spec in lib/billing.cjs, so onboarding a second subcontractor is a spec
// object there plus `--vendor <id>` here — not a second parser.
//
// Merges into billing.json, the master history. History is the point: a
// duplicate charge is only visible if you still hold the statement it first
// appeared on, so this file only ever GROWS. Re-importing the same statement
// replaces that statement's lines in place; two DIFFERENT statements carrying
// the same charge are both kept, because that is the thing worth catching.
import XLSX from 'xlsx';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { basename } from 'path';
import OpsBilling from './lib/billing.cjs';

const HISTORY = new URL('./billing.json', import.meta.url).pathname;
const DATA = new URL('./data.json', import.meta.url).pathname;

const argv = process.argv.slice(2);
let vendorId = OpsBilling.DEFAULT_VENDOR;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--vendor') { vendorId = argv[++i]; continue; }
  files.push(argv[i]);
}
if (!files.length) {
  console.error('Usage: node parse-radicl.js [--vendor <id>] <statement.xlsx> [more.xlsx ...]');
  console.error('Vendors: ' + Object.keys(OpsBilling.VENDORS).join(', '));
  process.exit(1);
}
if (!OpsBilling.VENDORS[vendorId]) {
  console.error(`Unknown vendor "${vendorId}". Known: ${Object.keys(OpsBilling.VENDORS).join(', ')}`);
  process.exit(1);
}
const SPEC = OpsBilling.vendor(vendorId);

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

function parseStatement(file) {
  const wb = XLSX.readFile(file, { cellDates: true });
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
    throw new Error(`${basename(file)}: no header row matching the ${SPEC.name} column map `
      + `(${Object.values(SPEC.columns).join(', ')})`);
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

// A statement's identity is its vendor plus its filename. These are named by
// period ("Sunpower 07.01.26-08.08.26.xlsx"), so the name is meaningful and
// stable, and re-importing the same file updates rather than duplicates.
const statementId = f => vendorId + '/' + basename(f).replace(/\.xlsx?$/i, '');

let history = { statements: [], lines: [] };
if (existsSync(HISTORY)) {
  try { history = JSON.parse(readFileSync(HISTORY, 'utf8')); }
  catch (e) { console.error(`billing.json is unreadable (${e.message}) — refusing to overwrite it.`); process.exit(1); }
}

const report = [];
for (const file of files) {
  const id = statementId(file);
  let lines;
  try { lines = parseStatement(file); }
  catch (e) { console.error('SKIP  ' + e.message); continue; }

  const dates = lines.map(l => l.date).filter(Boolean).sort();
  const existing = history.statements.find(s => s.id === id);
  const before = history.lines.length;
  history.lines = history.lines.filter(l => l.statement !== id);
  const replaced = before - history.lines.length;

  lines.forEach((l, i) => history.lines.push({ ...l, statement: id, line: i + 1 }));
  const meta = { id, vendor: vendorId, file: basename(file), from: dates[0] || '',
    to: dates[dates.length - 1] || '', lines: lines.length, imported: new Date().toISOString().slice(0, 10) };
  if (existing) Object.assign(existing, meta); else history.statements.push(meta);

  report.push({ id, lines: lines.length, replaced, from: meta.from, to: meta.to,
    charged: lines.filter(OpsBilling.isCharge).reduce((s, l) => s + Math.abs(l.units), 0) });
}

history.statements.sort((a, b) => String(a.from).localeCompare(String(b.from)));
history.lines.sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.line || 0) - (b.line || 0));
history.updated = new Date().toISOString();
writeFileSync(HISTORY, JSON.stringify(history, null, 2) + '\n');

// ── Import report, to stderr, non-blocking — parse-sf.js convention ─────────
const e = s => process.stderr.write(s + '\n');
const money = n => '$' + Math.round(n).toLocaleString();
e('');
e(`${SPEC.name} statement import`);
report.forEach(r => {
  e(`  ${r.id}`);
  e(`    ${r.from} → ${r.to} · ${r.lines} lines · ${r.charged.toFixed(2)} ${SPEC.unit}s (${money(OpsBilling.usd(r.charged, vendorId))})`
    + (r.replaced ? `  [replaced ${r.replaced} previously imported lines]` : ''));
});
e(`  history: ${history.statements.length} statement(s), ${history.lines.length} lines, `
  + `${new Set(history.statements.map(s => s.vendor)).size} vendor(s)`);

// Overlapping periods are the usual reason a charge looks duplicated when it
// is really the same work reported twice.
const st = history.statements.filter(s => s.from && s.to);
for (let i = 1; i < st.length; i++) {
  if (st[i].vendor === st[i - 1].vendor && st[i].from <= st[i - 1].to) {
    e(`  ! ${st[i].id} overlaps ${st[i - 1].id} (${st[i].from} <= ${st[i - 1].to})`);
  }
}

if (existsSync(DATA)) {
  const rows = JSON.parse(readFileSync(DATA, 'utf8'));
  const recon = OpsBilling.reconcile(history.lines, rows);
  const s = OpsBilling.summarize(recon);
  e('');
  e(`  ${s.surveys} surveys billed · ${money(s.usd)} · ${money(s.perSurvey)} per survey all-in`);
  e(`  travel adders on ${(s.travelRate * 100).toFixed(0)}% of surveys · ${money(s.travelUsd)} (${(s.travelShare * 100).toFixed(0)}% of spend)`);
  e('');
  OpsBilling.byFlag(recon).filter(f => f.n).forEach(f => {
    const mark = f.sev === 'high' ? '!!' : f.sev === 'med' ? ' !' : '  ';
    e(`  ${mark} ${f.label}: ${f.n} line(s), ${money(f.usd)}`);
  });
  const acc = OpsBilling.byAccount(recon).filter(a => a.visits > 1).sort((a, b) => b.usd - a.usd);
  if (acc.length) {
    e('');
    e(`  accounts that took more than one visit: ${acc.length}`);
    acc.slice(0, 5).forEach(a => e(`     ${money(a.usd)}  ${a.name} — ${a.lines.map(l => l.subtype).join(' + ')}`));
  }
} else {
  e('  (data.json not found — skipped the Salesforce reconciliation)');
}
e('');
