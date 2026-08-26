#!/usr/bin/env node
// parse-radicl.js — third-party surveyor statement (XLSX) → billing history
//
// Usage: node parse-radicl.js [--vendor <id>] <statement.xlsx> [more.xlsx ...]
//
// Column mapping, unit price and subtype taxonomy all come from the vendor
// spec in lib/billing.cjs, so onboarding a second subcontractor is a spec
// object there plus `--vendor <id>` here — not a second parser. The parsing
// and merge logic itself lives in lib/statement-import.cjs, shared with the
// in-app "Import statement" button (api/update-billing.js) — same reason.
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
import StatementImport from './lib/statement-import.cjs';
const { parseWorkbookLines, mergeStatement, overlapWarnings } = StatementImport;

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

let history = { statements: [], lines: [] };
if (existsSync(HISTORY)) {
  try { history = JSON.parse(readFileSync(HISTORY, 'utf8')); }
  catch (e) { console.error(`billing.json is unreadable (${e.message}) — refusing to overwrite it.`); process.exit(1); }
}

const report = [];
for (const file of files) {
  let lines;
  try {
    const wb = XLSX.readFile(file, { cellDates: true });
    lines = parseWorkbookLines(wb, vendorId);
  } catch (e) { console.error('SKIP  ' + basename(file) + ': ' + e.message); continue; }

  const { history: next, meta, replaced, deduped, charged } = mergeStatement(history, vendorId, file, lines);
  history = next;
  report.push({ id: meta.id, lines: lines.length, replaced, deduped, from: meta.from, to: meta.to, charged });
}

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
  // Not a warning: overlapping periods are how these statements are issued.
  // It is reported because it is the difference between what the statement
  // charges and what this import adds to the history.
  if (r.deduped) e(`    ${r.deduped} of those lines were already billed on an earlier statement — one copy kept`);
});
e(`  history: ${history.statements.length} statement(s), ${history.lines.length} lines, `
  + `${new Set(history.statements.map(s => s.vendor)).size} vendor(s)`);

overlapWarnings(history).forEach(w => e(`  ! ${w}`));

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
