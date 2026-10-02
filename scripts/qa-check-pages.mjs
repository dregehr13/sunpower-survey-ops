#!/usr/bin/env node
// scripts/qa-check-pages.mjs — are the page numbers in a QA review right?
//   node scripts/qa-check-pages.mjs <report.pdf>...
// A finding links to "PDF p.N" from the page of the field or photo it was read from. This
// re-checks that on real reports: (1) the page numbering matches the "Page N of M" the
// report prints, (2) every answer the parser read really is printed on the page it was
// given, (3) every photo's caption is on its page, and (4) every finding's page is the
// page of an entry or photo it could have been read from. Reports hold customer data:
// run it on your own machine; nothing is written.
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pdfToBlocks } from '../qa/pdf-blocks.mjs';

const require = createRequire(import.meta.url);
const QA = require('../lib/qa.cjs');
const specDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'qa', 'specs');
const specs = readdirSync(specDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(path.join(specDir, f), 'utf8')));
const norm = t => String(t || '').toLowerCase().replace(/[‘’“”"'`]/g, '').replace(/\s+/g, ' ').trim();

let bad = 0;
for (const file of process.argv.slice(2)) {
  const { pages } = await pdfToBlocks(file);
  const det = QA.detectTemplate(pages, specs);
  if (det.vendor === 'unknown') { console.log(`${path.basename(file)}: not a survey report`); continue; }
  const spec = specs.find(s => s.id === det.specId);
  const S = det.vendor === 'sitecapture' ? QA.parseSiteCapture(pages, spec) : QA.parseRadicl(pages, { specId: det.specId });
  const R = QA.evaluate(S, specs, {});
  const text = n => norm(((pages[n - 1] || {}).blocks || []).map(b => b.text).join(' '));
  const problems = [];
  // 1. numbering against the printed footer
  let footers = 0;
  for (const pg of pages) {
    const m = text(pg.n).match(/page (\d+) of (\d+)/);
    if (m) { footers++; if (Number(m[1]) !== pg.n) problems.push(`page ${pg.n} prints "Page ${m[1]} of ${m[2]}"`); }
  }
  // 2 and 3. every answer and every caption is on the page it was given
  for (const e of S.entries) if (e.value != null && String(e.value).trim().length > 2 && e.page && !text(e.page).includes(norm(e.value).slice(0, 8))) problems.push(`answer "${String(e.value).slice(0, 30)}" for ${e.ref} is not on p.${e.page}`);
  for (const p of S.photos) if (p.label && p.page && !text(p.page).includes(norm(p.label).slice(0, 20))) problems.push(`photo caption "${String(p.label).slice(0, 30)}" is not on p.${p.page}`);
  // 4. a finding's page belongs to something it could have been read from
  const known = new Set([...S.entries, ...S.photos].map(x => x.page).filter(Boolean));
  for (const f of R.findings) if (f.page && !known.has(f.page)) problems.push(`finding ${f.id} links p.${f.page}, which holds none of its fields`);
  const linked = R.findings.filter(f => f.page).length;
  console.log(`${path.basename(file).slice(0, 60)}: ${det.vendor}, ${pages.length} pages, ${footers} footers, ${S.entries.length} answers, ${S.photos.length} photos, ${linked} linked findings — ${problems.length ? problems.length + ' PROBLEMS' : 'ok'}`);
  for (const p of problems.slice(0, 12)) console.log('   ' + p);
  bad += problems.length;
}
process.exit(bad ? 1 : 0);
