#!/usr/bin/env node
// scripts/build-archive.cjs — resolve billing lines against projects older than
// the dashboard's window, and keep ONLY the resolutions.
//
// Usage: node scripts/build-archive.cjs <wide-export.xls>
//
// Radicl bills in the month they survey, not the month the project started, so
// a January statement carries work on projects sold the previous summer. Those
// projects are outside DATA_CUTOFF and therefore outside data.json, and every
// line on them reads as "No Salesforce record".
//
// Moving DATA_CUTOFF would fix the attribution and restate first pass yield,
// cycle time and every trend line to do it — a bad trade for a billing
// question. So the wide export is used ONCE, here, and what gets committed is
// not the export but the handful of accounts that actually resolved something:
// ~50 rows rather than 20,000, and nothing on the metrics side moves.
//
// Re-runnable and additive. Import a new statement, run this again against
// whatever wide export is to hand, and it appends the newly resolved accounts
// and leaves the rest alone.
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/build-archive.cjs <wide-export.xls>'); process.exit(1); }

const root = path.join(__dirname, '..');
const OpsBilling = require(path.join(root, 'lib', 'billing.cjs'));

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const history = readJson(path.join(root, 'billing.json'), { lines: [] });
const surveys = readJson(path.join(root, 'data.json'), []);
const epc = (readJson(path.join(root, 'epc.json'), {}).accounts) || [];
const ARCHIVE = path.join(root, 'archive.json');
const prior = readJson(ARCHIVE, {});
const priorAccounts = prior.accounts || [];

// Salesforce "Export → Details Only" is an HTML table with a .xls suffix and
// escaped free text, the same shape parse-sf.js reads.
const dec = s => s
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').trim();
const iso = s => {
  const p = String(s || '').split(',')[0].trim().split('/');
  if (p.length < 3) return '';
  return `${p[2].length === 2 ? '20' + p[2] : p[2]}-${String(p[0]).padStart(2, '0')}-${String(p[1]).padStart(2, '0')}`;
};

const raw = fs.readFileSync(file, 'latin1');
let cols = null;
const wide = [];
for (const tr of raw.split(/<tr[^>]*>/i).slice(1)) {
  const cells = (tr.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || []).map(c => dec(c.replace(/<[^>]+>/g, '')));
  if (!cells.length) continue;
  if (!cols) { cols = cells; continue; }
  if (cells.length < cols.length - 2) continue;
  const o = {}; cols.forEach((k, i) => { o[k] = cells[i] || ''; });
  if (!o['Primary Contact'] || !o['Installation Address']) continue;
  wide.push({
    task_id: o['TaskRay Task ID'],
    contact: o['Primary Contact'],
    address: o['Installation Address'],
    project: o['Project Name'],
    project_status: o['Project Status'],
    resource: o['Site Survey Resource'],
    start: iso(o['Project Start Date']),
    complete: iso(o['Site Survey Complete']),
  });
}

// Reconcile with what we already have, so this only ever ADDS. A line the live
// export can match must keep matching the live export: it carries the resurvey
// history and the archive row does not.
const rec = OpsBilling.reconcile(history.lines || [], surveys, epc, priorAccounts);
const unmatched = rec.filter(l => OpsBilling.isCharge(l) && !l.match);

const index = OpsBilling.indexSurveys(wide);
const found = new Map(priorAccounts.map(a => [a.task_id || (a.project + '|' + a.address), a]));
const before = found.size;
let resolved = 0;
for (const line of unmatched) {
  const m = OpsBilling.matchLine(line, index).row;
  if (!m) continue;
  resolved++;
  found.set(m.task_id || (m.project + '|' + m.address), m);
}

const accounts = [...found.values()].sort((a, b) => String(a.start).localeCompare(String(b.start)));
fs.writeFileSync(ARCHIVE, JSON.stringify({
  _comment: 'Projects older than DATA_CUTOFF that a billing line matched. Built by '
    + 'scripts/build-archive.cjs from a wide Salesforce export and committed; the export itself is '
    + 'not kept. Read ONLY by billing reconciliation, and only where the live export has nothing, so '
    + 'no survey metric can see these rows. Re-run after importing a statement that reaches further '
    + 'back than the last one did — it appends.',
  updated: new Date().toISOString().slice(0, 10),
  source: path.basename(file),
  accounts,
}, null, 1));

const usd = ls => ls.reduce((s, l) => s + Math.abs(l.units || 0) * OpsBilling.vendor(l.vendor).unitUsd, 0);
const stillOut = unmatched.filter(l => !OpsBilling.matchLine(l, index).row);
console.error(`archive.json: ${accounts.length} accounts (${accounts.length - before} new)`);
console.error(`  resolved ${resolved} of ${unmatched.length} unmatched charge lines, `
  + `$${(usd(unmatched) - usd(stillOut)).toLocaleString()} of $${usd(unmatched).toLocaleString()}`);
console.error(`  still unresolved: ${stillOut.length} lines, $${usd(stillOut).toLocaleString()}`);
