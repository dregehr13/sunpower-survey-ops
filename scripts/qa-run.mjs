#!/usr/bin/env node
// scripts/qa-run.mjs — run the QA engine on a survey report PDF.
//   node scripts/qa-run.mjs <report.pdf> [--json] [--sf-address "123 Main St"] [--sf-type "Battery Only Survey"]
// Prints the findings, grouped by outcome, and the Salesforce hand-off text.
// Reports hold customer names and photos of homes: run this on your own
// machine and keep the PDFs out of the repo.
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pdfToBlocks } from '../qa/pdf-blocks.mjs';

const require = createRequire(import.meta.url);
const QA = require('../lib/qa.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.join(here, '..', 'qa', 'specs');
const specs = readdirSync(specDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(path.join(specDir, f), 'utf8')));

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('usage: qa-run.mjs <report.pdf> [--json] [--sf-address "..."]'); process.exit(1); }
const ai = args.indexOf('--sf-address');
const ti = args.indexOf('--sf-type');
const ctx = { sfAddress: ai >= 0 ? args[ai + 1] : null, sfSurveyType: ti >= 0 ? args[ti + 1] : null };

const { pages } = await pdfToBlocks(file);
const det = QA.detectTemplate(pages, specs);
if (det.vendor === 'unknown') { console.error('Unrecognised report: ' + det.reason); process.exit(2); }
const spec = specs.find(s => s.id === det.specId);
if (det.vendor === 'radicl' && !spec) console.error('Note: no spec for ' + det.specId + ' — Layer A skipped');
const S = det.vendor === 'sitecapture' ? QA.parseSiteCapture(pages, spec) : QA.parseRadicl(pages, { specId: det.specId });
const R = QA.evaluate(S, specs, ctx);

if (args.includes('--json')) { console.log(JSON.stringify({ det, meta: R.meta, counts: R.counts, suggestedStatus: R.suggestedStatus, findings: R.findings }, null, 1)); process.exit(0); }

console.log(`${det.vendor} · ${S.meta.project || S.meta.address} · ${S.entries.length} fields, ${S.photos.length} photos, ${S.unmatched.length} unmatched blocks`);
console.log(`Suggested: ${R.suggestedStatus}   ${JSON.stringify(R.counts)}\n`);
const order = ['miss', 'gap', 'verify'];
const extra = [];
for (const st of order) {
  const rows = R.findings.filter(f => f.status === st || (st === 'verify' && f.verify && f.status === 'pass'));
  if (!rows.length) continue;
  console.log(`── ${st.toUpperCase()} (${rows.length})`);
  for (const f of rows) console.log(`  [${f.layer}${f.severity === 'hard' ? ' HARD' : ''}${f.standing ? ' standing' : ''}] ${f.area}: ${f.title}${f.detail ? ' — ' + f.detail : ''}`);
  console.log('');
}
if (args.includes('--coverage')) {
  console.log('── Template report');
  console.log('  new to the spec (' + R.templateReport.newToSpec.length + '):', R.templateReport.newToSpec.slice(0, 15));
  if (spec && spec.fields && spec.vendor === 'sitecapture') console.log('  coverage:', JSON.stringify(QA.templateCoverage(spec)));
  console.log('');
}
const sum = QA.summarize(R, {});
console.log('── Salesforce summary (' + sum.text.length + ' chars) · status: ' + sum.status + '\n' + sum.text);
