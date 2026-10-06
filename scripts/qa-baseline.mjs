#!/usr/bin/env node
// scripts/qa-baseline.mjs — run the QA engine over a folder of real reports and compare with qa/baseline.json.
//   node scripts/qa-baseline.mjs [folder]            check: exit 1 if any report reads differently
//   node scripts/qa-baseline.mjs [folder] --record   add or update the entries (accept the change)
// The folder defaults to qa/samples (gitignored). Reports hold customer data and stay local; the
// baseline holds only each report's SHA-256, its template and its findings' ids and statuses.
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pdfToBlocks } from '../qa/pdf-blocks.mjs';

const require = createRequire(import.meta.url);
const QA = require('../lib/qa.cjs');
const Base = require('../lib/qa-baseline.cjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const specDir = path.join(root, 'qa', 'specs');
const specs = readdirSync(specDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(path.join(specDir, f), 'utf8')));
const file = path.join(root, 'qa', 'baseline.json');

const args = process.argv.slice(2), record = args.includes('--record');
const dir = args.find(a => !a.startsWith('--')) || path.join(root, 'qa', 'samples');
if (!existsSync(dir)) { console.error('No reports in ' + dir); process.exit(1); }
const base = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { reports: {} };

let moved = 0, ok = 0, fresh = 0;
for (const name of readdirSync(dir).filter(f => /\.pdf$/i.test(f)).sort()) {
  const bytes = readFileSync(path.join(dir, name));
  const sha = createHash('sha256').update(bytes).digest('hex');
  const { pages } = await pdfToBlocks(path.join(dir, name));
  const det = QA.detectTemplate(pages, specs);
  if (det.vendor === 'unknown') { console.log(`?? ${sha.slice(0, 8)}  not recognised: ${det.reason}`); moved++; continue; }
  const spec = specs.find(s => s.id === det.specId);
  const S = det.rep ? QA.parseRep(pages) : det.vendor === 'sitecapture' ? QA.parseSiteCapture(pages, spec) : QA.parseRadicl(pages, { specId: det.specId, partial: det.partial });
  const now = Base.entryOf(det, QA.evaluate(S, specs, {}));
  const was = base.reports[sha];
  const label = `${sha.slice(0, 8)}  ${now.template}`;
  if (!was) { console.log(`+  ${label}  ${now.suggested}, ${now.findings.length} findings (not in the baseline)`); fresh++; if (record) base.reports[sha] = now; continue; }
  const d = Base.diff(was, now);
  if (!d.length) { console.log(`ok ${label}`); ok++; continue; }
  console.log(`!! ${label}`); d.forEach(x => console.log('     ' + x)); moved++;
  if (record) base.reports[sha] = now;
}
if (record) { writeFileSync(file, JSON.stringify(base, null, 1) + '\n'); console.log(`\nRecorded ${Object.keys(base.reports).length} reports in qa/baseline.json`); process.exit(0); }
console.log(`\n${ok} unchanged, ${moved} changed, ${fresh} new`);
process.exit(moved ? 1 : 0);
