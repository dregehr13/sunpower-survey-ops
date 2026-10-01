#!/usr/bin/env node
// scripts/build-qa-radicl-spec.mjs — Radicl reports → qa/specs/radicl.json
//
// Radicl does not publish its template, so the spec is INFERRED: the sections,
// fields and photo captions that the reference surveys carry, and for every
// caption all of them share, the fewest photos any of them had. That minimum is
// the standard a new survey is held to until Radicl's own template is seen.
//   node scripts/build-qa-radicl-spec.mjs report1.pdf report2.pdf ...
// Rerun it with more good reports to tighten the spec; branches no report took
// (existing solar = Yes, a second roof, a battery) stay unseen until one does.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pdfToBlocks } from '../qa/pdf-blocks.mjs';
const require = createRequire(import.meta.url);
const QA = require('../lib/qa.cjs');

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: build-qa-radicl-spec.mjs <report.pdf>...'); process.exit(1); }

// Radicl changed its template between 2026-08-29 and 2026-09-30, so reports are
// grouped by the version detectTemplate reads off the contents page and each
// version gets its own spec.
const byVersion = new Map();
for (const f of files) {
  const { pages } = await pdfToBlocks(f);
  const det = QA.detectTemplate(pages, []);
  if (!byVersion.has(det.specId)) byVersion.set(det.specId, []);
  byVersion.get(det.specId).push({ f, pages });
}
for (const [version, group] of byVersion) await buildVersion(version, group);

async function buildVersion(version, group) {
const sections = [], fields = new Map(), photos = new Map();
for (const { f, pages } of group) {
  const S = QA.parseRadicl(pages, { specId: version });
  const seenF = new Set(), seenP = new Map();
  for (const e of S.entries) { seenF.add(e.ref + '|' + e.section); if (!sections.includes(e.section)) sections.push(e.section); }
  for (const ph of S.photos) {
    const k = ph.ref + '|' + ph.section;
    const per = seenP.get(k) || new Map();
    per.set(ph.instance || '', (per.get(ph.instance || '') || 0) + 1);
    seenP.set(k, per);
    if (!sections.includes(ph.section)) sections.push(ph.section);
  }
  for (const k of seenF) fields.set(k, (fields.get(k) || 0) + 1);
  for (const [k, per] of seenP) {
    const cur = photos.get(k) || { seen: 0, min: Infinity, max: 0, perInstance: false };
    cur.seen++;
    for (const n of per.values()) { cur.min = Math.min(cur.min, n); cur.max = Math.max(cur.max, n); }
    if ([...per.keys()].some(x => x)) cur.perInstance = true;
    photos.set(k, cur);
  }
}
const n = group.length;
const spec = {
  id: version, vendor: 'radicl', inferred: true, inferredFrom: n,
  note: 'Inferred from reference surveys; Radicl publishes no template. Branches no survey took are unseen.',
  sections,
  fields: [...fields].map(([k, seen]) => { const [ref, section] = k.split('|'); return { ref, section, seen }; }),
  photos: [...photos].map(([k, v]) => { const [ref, section] = k.split('|'); return { ref, section, seen: v.seen, min: v.min, max: v.max, perInstance: v.perInstance }; }),
};
// A caption's minimum is only a standard when the reference surveys agree on it:
// 12–14 perimeter photos is a norm, 10–24 dead-front photos is not, so presence
// is all that is asked of the latter.
spec.core = spec.photos.filter(p => p.seen === n).map(p => ({ ref: p.ref, section: p.section, min: p.max <= 2 * p.min ? p.min : 1, perInstance: p.perInstance }));
writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'qa', 'specs', version + '.json'), JSON.stringify(spec, null, 1) + '\n');
console.log(`${version}: ${n} reports → ${spec.sections.length} sections, ${spec.fields.length} fields, ${spec.photos.length} photo captions, ${spec.core.length} core`);
}
