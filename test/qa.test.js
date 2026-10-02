// test/qa.test.js — the QA engine against hand-written cases.
//
// Reports hold customer names and photos of homes, so no real report is
// committed. These build the smallest positioned-block pages that exercise each
// rule; the real reports are run locally with scripts/qa-run.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const QA = require('../lib/qa.cjs');
const SC = require('../qa/specs/sitecapture-v13.json');
const specs = [SC, require('../qa/specs/radicl-v1.json'), require('../qa/specs/radicl-v2.json')];

const tk = QA.tok;
const blk = (text, x0 = 18, y0 = 700) => ({ text, x0, y0, x1: x0 + 100, y1: y0 - 10 });
const page = (n, blocks) => ({ n, width: 612, height: 792, blocks });

test('alignLabel reads an answer before, inside or after a wrapped label', () => {
  const L = tk('What does the customer know about the roof?');
  assert.deepEqual(QA.alignLabel(tk('Roof Replaced What does the customer know about the roof?'), L).value, 'Roof Replaced');
  assert.deepEqual(QA.alignLabel(tk('What does the customer know Roof Replaced about the roof?'), L).value, 'Roof Replaced');
  assert.deepEqual(QA.alignLabel(tk('What does the customer know about the roof? Roof Replaced'), L).value, 'Roof Replaced');
  assert.equal(QA.alignLabel(tk('What does the customer know about the roof?'), L).value, '');
});

test('alignLabel accepts a cut label only when enough of it is present', () => {
  const long = tk('Water, Fire, Mold 1 - Penetration test on water damage, fire damage or mold. Take photo of caliper reading');
  assert.ok(QA.alignLabel(long.slice(0, 12), long));
  assert.equal(QA.alignLabel(tk('Brittle Test'), tk('Brittle Test - Are the shingles brittle?')), null);
});

test('captionMatches ignores spacing and punctuation differences', () => {
  assert.ok(QA.captionMatches(tk('Exterior MSP - Dead Front On - 1.) Photo of full length'), tk('Exterior MSP - Dead Front On - 1.)Photo of full length of panelboard.')));
  assert.ok(QA.captionExact(tk('Brittle Test'), tk('Brittle  Test')));
  assert.equal(QA.captionMatches(tk('Brittle Test'), tk('Brittle Test - Are the shingles brittle?')), false);
});

test('detectTemplate names the vendor and, for Radicl, the version', () => {
  const sc = [page(1, [blk('Report Created: 09/25/2026'), blk('1 - Customer Information')])];
  assert.equal(QA.detectTemplate(sc, specs).vendor, 'sitecapture');
  const rad = body => [page(1, [blk('SITE SURVEY REPORT'), blk('radicl')]), page(2, [blk(body)])];
  assert.equal(QA.detectTemplate(rad('Outside Electrical Information'), specs).specId, 'radicl-v1');
  assert.equal(QA.detectTemplate(rad('Exterior Electrical'), specs).specId, 'radicl-v2');
  assert.equal(QA.detectTemplate([page(1, [blk('hello')])], specs).vendor, 'unknown');
});

test('Radicl refs are canonical across the two template versions', () => {
  assert.deepEqual(QA.radiclRef('Inside Breaker Box 1: Dead Front On'), { ref: 'Breaker Box — Dead Front On', instance: 'in1' });
  assert.deepEqual(QA.radiclRef('Outside Breaker Box 2: Main Breaker Rating'), { ref: 'Breaker Box — Main Breaker Rating', instance: 'out2' });
  assert.deepEqual(QA.radiclRef('Breaker Box / Electrical Panel #2 — Dead Front…'), { ref: 'Breaker Box — Dead Front', instance: '2' });
});

test('the September Radicl template names an inside panel "Interior Breaker Box: Quantity #N"', () => {
  assert.deepEqual(QA.radiclRef('Interior Breaker Box: Quantity #1 — Main Breaker Rating'), { ref: 'Breaker Box — Main Breaker Rating', instance: 'in1' });
  assert.deepEqual(QA.radiclRef('Interior Breaker Box:Quantity #2 — Dead Front…'), { ref: 'Breaker Box — Dead Front', instance: 'in2' });
});

test('Site Capture: identical labels resolve by the answer that makes them appear', () => {
  const f = (key, label, extra) => ({ key, label, type: 'FOTO', section: 's', group: null, required: true, dependsOnKey: null, dependsOnValue: null, order: 0, ...extra });
  const spec = { id: 'sitecapture-v13', vendor: 'sitecapture', sections: [{ key: 's', title: '3 - Roof' }], groups: {}, fields: [
    f('age', 'Roof Condition - Is the roof older than 8 years?', { type: 'SELECT' }),
    f('p_yes', 'Roof Condition - 6+ photos of each mounting plane taken at a distance', { dependsOnKey: 'age', dependsOnValue: 'Yes' }),
    f('p_unk', 'Roof Condition - 6+ photos of each mounting plane taken at a distance', { dependsOnKey: 'age', dependsOnValue: 'Age Unknown' }),
  ] };
  const pages = [page(1, [
    blk('3 - Roof', 18, 759),
    blk('Age Unknown Roof Condition - Is the roof older than 8 years?', 18, 700),
    blk('Roof Condition - 6+ photos of each mounting plane taken at a distance', 18, 650),
    blk('3 - Roof / Roof Condition - 6+ photos of each mounting plane taken at a distance', 18, 500),
  ])];
  const S = QA.parseSiteCapture(pages, spec);
  assert.equal(S.value('age'), 'Age Unknown');
  assert.equal(S.photoCount('p_unk'), 1);
  assert.equal(S.photoCount('p_yes'), 0);
});

// ── Evaluation ──
const survey = (vendor, o = {}) => QA.makeSurvey({ template: { vendor, specId: vendor === 'sitecapture' ? 'sitecapture-v13' : 'radicl-v2' }, meta: {}, ...o });
const get = (R, id) => R.findings.find(f => f.id === id);

test('pitchRise reads the formats surveyors actually write', () => {
  assert.equal(QA.pitchRise('6/12'), 6);
  assert.equal(QA.pitchRise('4 in 12'), 4);
  assert.ok(Math.abs(QA.pitchRise('30.07 degree pitch') - 6.95) < 0.05);
  assert.equal(QA.pitchRise('nonsense'), null);
});

test('Radicl: pitch present passes, absent is a miss, odd wording asks for a look', () => {
  const run = v => get(QA.evaluate(survey('radicl', { entries: v ? [{ ref: 'Roof Pitch / Slope Measurement', value: v, instance: null }] : [] }), specs), 'roof_pitch');
  assert.equal(run('6/12').status, 'pass');
  assert.equal(run(null).status, 'miss');
  assert.equal(run('5 in 12 for house. Panels are going on the shop').status, 'verify');
  assert.equal(run('40/12').status, 'miss');
});

test('Site Capture: no tilt is a surveyor miss when an attic was entered, a template gap when not', () => {
  const tiltKey = SC.fields.find(f => /Tilt Reading/.test(f.label) && f.group === 'mounting_plane_attic').key;
  const atticKey = SC.fields.find(f => /10\+ Photos of ENTIRE attic/.test(f.label)).key;
  const planes = id => ({ mounting_plane_attic: [{ idx: 1, id }] });
  const withAttic = survey('sitecapture', { groups: planes('MP1'), photos: [{ ref: atticKey, instance: 'MP1' }] });
  const noAttic = survey('sitecapture', { groups: planes('MP1') });
  const haveTilt = survey('sitecapture', { groups: planes('MP1'), entries: [{ ref: tiltKey, instance: 'MP1', value: '25' }] });
  assert.equal(get(QA.evaluate(withAttic, specs), 'roof_pitch').status, 'miss');
  assert.equal(get(QA.evaluate(noAttic, specs), 'roof_pitch').status, 'gap');
  assert.equal(get(QA.evaluate(haveTilt, specs), 'roof_pitch').status, 'pass');
});

test('plane_count: fewer planes than the proposal is hard, more is a warning', () => {
  const mk = (n, asked) => survey('sitecapture', {
    groups: { mounting_plane_roof: Array.from({ length: n }, (_, i) => ({ idx: i + 1, id: 'MP' + (i + 1) })) },
    entries: [{ ref: 'mounting_planes_how_many', value: String(asked), instance: null }] });
  const fewer = get(QA.evaluate(mk(3, 4), specs), 'plane_count');
  const more = get(QA.evaluate(mk(5, 4), specs), 'plane_count');
  assert.equal(fewer.severity, 'hard'); assert.equal(more.severity, 'warn');
  assert.equal(get(QA.evaluate(mk(4, 4), specs), 'plane_count').status, 'pass');
});

test('a missing numeric main breaker rating is a Site Capture template gap, not a miss', () => {
  const sc = get(QA.evaluate(survey('sitecapture'), specs), 'main_breaker_rating');
  assert.equal(sc.status, 'gap'); assert.equal(sc.standing, true);
  const rd = get(QA.evaluate(survey('radicl', { entries: [{ ref: 'Breaker Box — Main Breaker Rating', instance: '1', value: '200A' }], photos: [] }), specs), 'main_breaker_rating');
  assert.equal(rd.status, 'pass');
});

// The smallest Radicl (v2) survey that satisfies every rule that applies to it.
const cleanRadicl = (over = {}) => {
  const e = (ref, value, instance = null) => ({ ref, value, instance });
  const ph = (ref, instance = null, n = 1) => Array.from({ length: n }, () => ({ ref, instance }));
  return survey('radicl', {
    entries: [e('Roof Pitch / Slope Measurement', '6/12'), e('Is there attic access?', 'No'), e('Electric Service Type', 'Underground'),
      e('Existing Solar', over.solar || 'No'), e('Breaker Box — Main Breaker Rating', '200A', '1'), e('Breaker Box — Max Bus Rating', '200A', '1')],
    photos: [...ph('Breaker Box — Location', '1'), ...ph('Breaker Box — Dead Front', '1', 4), ...ph('Breaker Box — Panel La', '1'),
      ...ph('Electrical Meter: Close Up'), ...ph('Electric Meter: Location Photos'), ...ph('Layout Map'), ...ph('Eave/Soffit Measurement Photo'),
      // and every caption the reference reports all carry (Layer A)
      ...specs.find(x => x.id === 'radicl-v2').core.flatMap(c => ph(c.ref, c.perInstance ? '1' : null, c.min))],
  });
};

test('standing template gaps do not change the outcome; an applied gap suggests an override', () => {
  const base = QA.evaluate(cleanRadicl(), specs);
  assert.equal(base.counts.missHard, 0);
  assert.ok(base.counts.standingGaps > 0);
  assert.equal(base.suggestedStatus, 'Passed');
  // existing solar = Yes and no field captures it: the gap now applies to this survey
  const R = QA.evaluate(cleanRadicl({ solar: 'Yes' }), specs);
  const eq = get(R, 'existing_equipment');
  assert.equal(eq.status, 'gap'); assert.equal(eq.standing, false);
  assert.equal(R.suggestedStatus, 'Passed with Override');
});

test('Radicl: an inside panel is checked, and an outside panel the surveyor said is not there is not', () => {
  const e = (ref, value, instance = null) => ({ ref, value, instance });
  const ph = (ref, instance, n = 1) => Array.from({ length: n }, () => ({ ref, instance }));
  const S = survey('radicl', {
    entries: [e('Roof Pitch / Slope Measurement', '6/12'), e('Is there attic access?', 'No'), e('Electric Service Type', 'Underground'), e('Existing Solar', 'No'),
      e('Are there any breaker boxes outside?', 'No'),
      e('Breaker Box — Main Breaker Rating', '225A', 'in1'), e('Breaker Box — Max Bus Rating', '200A', 'in1')],
    photos: [...ph('Breaker Box — Location', '1', 4),                                  // outside number, location only
      ...ph('Breaker Box — Location', 'in1', 2), ...ph('Breaker Box — Dead Front', 'in1', 5), ...ph('Breaker Box — Panel La', 'in1', 3),
      ...ph('Electrical Meter: Close Up'), ...ph('Electric Meter: Location Photos'), ...ph('Layout Map'), ...ph('Eave/Soffit Measurement Photo')],
  });
  const R = QA.evaluate(S, specs);
  assert.equal(R.counts.missHard, 0, JSON.stringify(R.findings.filter(f => f.status === 'miss').map(f => f.id + ': ' + f.detail)));
  assert.equal(get(R, 'main_breaker_rating').status, 'pass');
});

test('the checklist names every check once and marks what the template cannot capture', () => {
  const sc = QA.checklist('sitecapture-v13'), rd = QA.checklist('radicl-v2');
  assert.ok(sc.length > 20 && rd.length > 20);
  assert.equal(new Set(sc.map(c => c.id)).size, sc.length);
  const by = (l, id) => l.find(c => c.id === id);
  assert.equal(by(sc, 'roof_overhang').inTemplate, false);          // Site Capture has no overhang field
  assert.equal(by(rd, 'roof_overhang').inTemplate, true);
  assert.equal(by(sc, 'main_breaker_rating').inTemplate, false);
  assert.equal(by(rd, 'main_breaker_rating').inTemplate, true);
  assert.equal(by(rd, 'plane_count').inTemplate, false);
  assert.ok(by(sc, 'photo_provenance') && !by(rd, 'photo_provenance'));  // vendor-specific checks only appear for their vendor
  // alarm-only checks are not part of the routine list, but a setting can bring one back
  assert.ok(!by(sc, 'photos_deleted') && !by(sc, 'resource_match') && !by(sc, 'proposal_attached'));
  assert.ok(QA.checklist('sitecapture-v13', { photos_deleted: 'warn' }).some(c => c.id === 'photos_deleted'));
});

test('keyPhotos shows a few per check unless asked for all', () => {
  const ph = (ref, instance, n) => Array.from({ length: n }, () => ({ ref, instance, page: 1 }));
  const S = survey('radicl', { photos: ph('Breaker Box — Dead Front', 'in1', 21) });
  assert.equal(QA.keyPhotos(S, null).length, 2);
  assert.equal(QA.keyPhotos(S, null, { all: true }).length, 21);
});

test('Radicl: a pitch with no number points at the pitch photos', () => {
  const S = survey('radicl', { entries: [{ ref: 'Roof Pitch / Slope Measurement', value: 'Unable to access roof', instance: null }], photos: [{ ref: 'Roof Pitch', instance: null }, { ref: 'Roof Pitch / Slope', instance: null }] });
  const f = get(QA.evaluate(S, specs), 'roof_pitch');
  assert.equal(f.status, 'verify'); assert.match(f.detail, /2 pitch photos/);
});

test('a hard miss fails the survey; warnings alone ask for review', () => {
  const noPitch = QA.evaluate(survey('radicl'), specs);
  assert.equal(noPitch.suggestedStatus, 'Failed - Gaps Found');
  assert.ok(noPitch.counts.missHard > 0);
});

test('photos_deleted and proposal_attached read the surveyor’s own answers', () => {
  const S = survey('sitecapture', { entries: [
    { ref: 'office_feedback_were_any', value: 'Yes', instance: null },
    { ref: 'office_feedback_was_the_p', value: 'No', instance: null } ] });
  const R = QA.evaluate(S, specs);
  assert.equal(get(R, 'photos_deleted').status, 'miss');
  assert.equal(get(R, 'proposal_attached').status, 'miss');
  assert.equal(get(QA.evaluate(survey('radicl'), specs), 'photos_deleted'), undefined);   // vendor-specific
});

test('address_match compares street numbers against Salesforce when it is supplied', () => {
  const S = survey('sitecapture', { meta: { address: '23210 NE Village Ct Wood Village Oregon' } });
  assert.equal(get(QA.evaluate(S, specs, { sfAddress: '23210 NE Village Ct, Wood Village, OR' }), 'address_match').status, 'pass');
  assert.equal(get(QA.evaluate(S, specs, { sfAddress: '9999 Other St' }), 'address_match').status, 'miss');
  assert.equal(get(QA.evaluate(S, specs, {}), 'address_match').status, 'na');
});

test('summarize emits only Salesforce picklist labels and keeps gaps apart from misses', () => {
  const R = QA.evaluate(survey('radicl'), specs);
  const out = QA.summarize(R, { reviewNumber: 2, reviewTotal: 3 });
  assert.ok(out.text.startsWith('QA review 2 of 3'));
  assert.ok(QA.SF_STATUS.includes(out.status));
  assert.ok(/Standing template gaps:/.test(out.text));
  assert.equal(QA.summarize(R, { status: 'Needs review' }).status, null);   // internal state is never sent as a picklist value
});

// ── The registry against the template ──
test('every Site Capture requirement that names fields still resolves against the spec', () => {
  for (const r of QA.REQUIREMENTS) {
    if (!r.sc) continue;
    const keys = [...QA.scKeys(SC, r.sc.match), ...QA.scKeys(SC, r.sc.equipment), ...QA.scKeys(SC, r.sc.combo)];
    assert.ok(keys.length > 0, `${r.id}: no template field matches — the template changed or the rule is stale`);
  }
});

test('every requirement has an area, a severity and an evidence trail or a reason', () => {
  for (const r of QA.REQUIREMENTS) {
    assert.ok(r.id && r.area && r.title, r.id);
    assert.ok(['hard', 'warn'].includes(r.severity), r.id);
    assert.ok(r.custom || r.sc !== undefined || r.rd !== undefined, `${r.id} names no template source`);
  }
});

test('the committed specs carry no customer data', () => {
  const blob = JSON.stringify(specs);
  assert.equal(/@[a-z0-9-]+\.[a-z]{2,}/i.test(blob), false);       // no email addresses
  assert.equal(/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/.test(blob), false); // no phone numbers
});

// ── Photo pack ──
test('indexPhotoPack reads the field from the folder name and the instance from its -k suffix', () => {
  const lab = SC.fields.find(f => /^3\+ Mounting Plane Photos$/.test(f.label));
  const names = [
    '3 - Roof/3+ Mounting Plane Photos/3+_Mounting_Plane_Photos-1.jpg',
    '3 - Roof/3+ Mounting Plane Photos/3+_Mounting_Plane_Photos-2.jpg',
    '3 - Roof/3+ Mounting Plane Photos-2/3+_Mounting_Plane_Photos-1.jpg',
    '9 - Nowhere/Something/x-1.jpg',
  ];
  const pack = QA.indexPhotoPack(names, SC);
  assert.deepEqual(pack[0].cands, [lab.key]);
  assert.equal(pack[0].k, 1);
  assert.equal(pack[2].k, 2);
  assert.equal(pack[3].section, null);
});

test('crossCheckPack agrees when pack and report hold the same photos per plane', () => {
  const key = SC.fields.find(f => /^3\+ Mounting Plane Photos$/.test(f.label)).key;
  const S = survey('sitecapture', {
    groups: { mounting_plane_roof: [{ idx: 1, id: 'MP1' }, { idx: 2, id: 'MP2' }] },
    photos: [{ ref: key, instance: 'MP1' }, { ref: key, instance: 'MP1' }, { ref: key, instance: 'MP2' }] });
  const names = [
    '3 - Roof/3+ Mounting Plane Photos/a-1.jpg', '3 - Roof/3+ Mounting Plane Photos/a-2.jpg',
    '3 - Roof/3+ Mounting Plane Photos-2/a-1.jpg'];
  const ok = QA.crossCheckPack(S, QA.indexPhotoPack(names, SC));
  assert.equal(ok.matched, 2); assert.equal(ok.mismatches.length, 0);
  const short = QA.crossCheckPack(S, QA.indexPhotoPack(names.slice(0, 2), SC));
  assert.equal(short.mismatches.length, 1);   // MP2's folder is missing from the pack
});

// ── The page is wired in ──
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const pageSrc = readFileSync(new URL('../qa/page.js', import.meta.url), 'utf8');

test('index.html loads the QA library and page, names the library in the boot guard, and gates the page', () => {
  assert.ok(html.includes('<script src="lib/qa.cjs"></script>'));
  assert.ok(html.includes('<script src="qa/page.js"></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="qa/page.css">'));
  assert.ok(/typeof OpsQA === 'undefined'/.test(html));
  assert.ok(html.includes('id="page-qa"') && html.includes('id="qa-content"'));
  assert.ok(/data-page="qa"/.test(html));
  assert.ok(/const PAGES = \[[^\]]*'qa'/.test(html));
  assert.ok(/const URL_PAGES=\[[^\]]*'qa'/.test(html));
  assert.ok(/if\(p==='qa'\)\s+renderQA\(\)/.test(html));
  assert.ok(/if\(page==='qa'&&!qaGate\(\)\)/.test(html));
});

test('every qa handler named in the page markup is defined', () => {
  const used = new Set();
  for (const m of pageSrc.matchAll(/\bon(?:click|input|change|keydown|dragover)="([^"]+)"/g)) {
    // `${qaH(id)}` inside an attribute runs at render time; only what is left is a handler
    for (const f of m[1].replace(/\$\{[^}]*\}/g, '').matchAll(/\b(_?qa[A-Za-z]+)\(/g)) used.add(f[1]);
  }
  assert.ok(used.size > 10);
  for (const fn of used) assert.ok(new RegExp('function\\s+' + fn + '\\b').test(pageSrc), `${fn} is called from markup but never defined`);
});

test('the QA page keeps reports in the browser: the only upload is the opt-in Claude photo check', () => {
  // Reports are never posted. The one thing that leaves is a downsized key photo, to
  // /api/qa-vision, and only when Settings has the Claude photo check on.
  const posts = [...pageSrc.matchAll(/method:\s*['"]POST['"]/g)];
  // and the project's street address, to /api/qa-geocode, to find where it is (no customer name)
  assert.equal(posts.length, 2);
  assert.ok(/async function qaGeoLookup[\s\S]*?\/api\/qa-geocode[\s\S]*?method: 'POST'/.test(pageSrc));
  assert.ok(/async function qaVisionCall[\s\S]*?\/api\/qa-vision[\s\S]*?method: 'POST'/.test(pageSrc));
  assert.ok(/async function qaVisionRun\(\) \{\s*const run = qaRun; if \(!run \|\| !qaVisionOn\(\)\) return;/.test(pageSrc));
  assert.equal(/\.send\(/.test(pageSrc), false);
  assert.ok(/qaVision:\s+false/.test(readFileSync(new URL('../index.html', import.meta.url), 'utf8')));
});

test('qa/page.css redefines no colour token', () => {
  const css = readFileSync(new URL('../qa/page.css', import.meta.url), 'utf8');
  assert.equal(/--[a-z-]+\s*:/.test(css), false);
});

test('no function in the QA page is defined twice (a later one silently replaces the first)', () => {
  const seen = new Map();
  for (const m of pageSrc.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  const dups = [...seen].filter(([, n]) => n > 1).map(([f]) => f);
  assert.deepEqual(dups, []);
});

test('the review is two steps, each with a renderer, and photo review rows open onto their photos', () => {
  for (const fn of ['_qaReviewStep', '_qaVerdictStep', '_qaIntake', 'qaToggleRow', 'qaExpandAll', 'qaPhotoCardHtml']) {
    assert.ok(new RegExp('function\\s+' + fn + '\\b').test(pageSrc), fn);
  }
  assert.ok(/const QA_STEPS = \['Photo Review', 'Verdict and Summary'\]/.test(pageSrc));
  assert.ok(!/_qaReportStep|_qaSummaryStep|_qaStatusStep\b|_qaPhotosStep|_qaFindings\b/.test(pageSrc));
  assert.ok(/Expand all/.test(pageSrc) && /Collapse all/.test(pageSrc));
});

test('photo lines read as people say them, with no count in the title', () => {
  const t = QA.photoTitle;
  assert.equal(t('5+ overlapping photos covering each section under the MP (left, middle-left, middle, middle-right, right)'), 'Mounting planes');
  assert.equal(t('3+ photos of each pipe or vent exiting the attic through the roof'), 'Each roof obstruction');
  assert.equal(t('Roof Condition - 6+ photos of each mounting plane'), 'Roof condition');
  assert.equal(t('Location - 5+ photos showing path to opposite side of wall', 'MSP'), 'MSP location');
  assert.equal(t('Location - 5+ photos showing the entire room', 'SP1'), 'Sub panel location');
  assert.equal(t('Roof Shading Front - 8+ photos creating a 360° photo set'), 'Roof Shading Front');
  assert.equal(QA.allChecks().find(c => c.id === 'msp_location').title, 'MSP location');
});

test('a plane with fewer photos than the template asks for is not a miss; none at all still is', () => {
  const S = survey('sitecapture', {});
  const ids = QA.evaluate(S, specs, {}).findings.filter(f => f.layer === 'A').map(f => f.detail);
  assert.ok(ids.every(d => !/ of \d+\+ photos/.test(d || '')), 'no "N of M+ photos" miss remains');
  const engine = readFileSync(new URL('../lib/qa.cjs', import.meta.url), 'utf8');
  assert.ok(!/of \$\{need\}\+ photos/.test(engine) && !/the reference surveys had at least/.test(engine));
});

test('the verdict step carries the summary help text and marks the suggested status', () => {
  assert.ok(pageSrc.includes('Written from the findings. Edit here and then paste into Salesforce.'));
  assert.ok(!/Looks like \$\{/.test(pageSrc));
  assert.ok(/rec === s && run\.status !== s \? ' rec'/.test(pageSrc));
});

test('every example photo exists, and each key photo category has its example and description', () => {
  const fs = require('node:fs');
  const refs = pageSrc.match(/const QA_REFS = \{[\s\S]*?\n\};/)[0];
  const cats = [...QA.KEY_PHOTOS.map(k => k.id)];
  for (const c of cats) assert.ok(new RegExp('\\n  ' + c + ': \\{ what:').test(refs), c);
  for (const m of refs.matchAll(/src: '([^']+)'/g)) assert.ok(fs.existsSync(new URL('../' + m[1], import.meta.url).pathname), m[1]);
});

test('photo marks are good or not usable, and the saved review keeps which photos were marked', () => {
  assert.ok(/qaMarkBtns\(i, v\)/.test(pageSrc) && /qaVerdict\(\$\{i\},'ok'\)/.test(pageSrc) && /qaVerdict\(\$\{i\},'bad'\)/.test(pageSrc));
  assert.ok(/function qaPhotoRec\(\)/.test(pageSrc) && /marks: marks/.test(pageSrc) || /marks,\s*\}|, marks \}/.test(pageSrc));
  assert.ok(/function qaPrintRecord\(id\)/.test(pageSrc) && /w\.print\(\)/.test(pageSrc));
  assert.ok(/not individually reviewed/.test(pageSrc));
});

test('a review cannot be saved without a project ID', () => {
  assert.ok(/if \(!qaProj\.trim\(\)\) return 'Add the project ID before saving';/.test(pageSrc));
});

test('the tabs read Review, Templates, History, and the page has no import or shared-log wording', () => {
  assert.ok(/btn\('review', 'Review'\)\}\$\{btn\('templates', 'Templates'\)\}\$\{btn\('log', 'History'\)/.test(pageSrc));
  assert.ok(!/qaImport|Shared log|shared log</.test(pageSrc.replace(/^\s*\/\/.*$/gm, '')));
});

test('the reviewer is read-only once a password has named them', () => {
  assert.ok(/qaMode === 'shared' && qaUser\s*\n?\s*\? /.test(pageSrc));
});

test('the likely-to-review list skips reps and anything scheduled after today', () => {
  const ctx = { allRows: [
    { project: 'A1', resource: 'Radicl Services', sched: '2000-01-01', scheduled: '2000-01-01' },
    { project: 'B2', resource: 'Sales Rep', scheduled: '2000-01-01' },
    { project: 'C3', resource: 'SunPower Surveyor', scheduled: '2999-01-01' },
    { project: 'D4', resource: 'SunPower Surveyor', scheduled: '2000-01-01' },
    { project: 'E5', resource: 'SunPower Surveyor', scheduled: '' },
  ], isOpenQueue: () => true, wipSchedDate: r => r.scheduled };
  const src = pageSrc.match(/function qaLikely\(\) \{[\s\S]*?\n\}\n/)[0];
  const out = new Function(...Object.keys(ctx), src + 'return qaLikely();')(...Object.values(ctx));
  assert.deepEqual(out.map(x => x.r.project).sort(), ['A1', 'D4']);
});

test('Start over asks before discarding an unsaved review', () => {
  assert.ok(/function qaStartOver\(\) \{\s*\n\s*if \(qaRun && !qaRun\.saved && !confirm\(/.test(pageSrc));
});

test('the photo zoom moves with the arrow keys', () => {
  assert.ok(/function qaZoomStep\(d\)/.test(pageSrc));
  assert.ok(/e\.key === 'ArrowRight' \|\| e\.key === 'ArrowLeft'/.test(pageSrc));
});

test('a Good or Bad call on a flagged item settles it: Good passes, Bad becomes a miss', () => {
  const F = [{ id: 'roof_pitch', status: 'verify', severity: 'hard', detail: 'odd pitch' }, { id: 'dead_front', status: 'pass', verify: true, severity: 'hard', detail: '' }];
  const src = pageSrc.match(/const qaActionable[\s\S]*?\nconst qaFlagKey[^\n]*\n/)[0] + pageSrc.match(/function qaFindings\(\) \{[\s\S]*?\n\}\n/)[0];
  const run = (decisions) => new Function('qaRun', src + 'return qaFindings();')({ R: { findings: F }, decisions, items: [], verdicts: {} });
  const key = f => f.id + '|' + (f.detail || f.note || '');
  const out = run({ [key(F[0])]: 'bad', [key(F[1])]: 'ok' });
  assert.equal(out[0].status, 'miss'); assert.equal(out[0].severity, 'hard');
  assert.equal(out[1].status, 'pass'); assert.ok(!out[1].verify);
  assert.equal(run({})[0].status, 'verify');
});

test('the project ID is matched from the report address, and an unclear match is offered as a pick', () => {
  const rows = [
    { project: '2754BROT', address: '2754 Rue Sans Famille Raleigh, NC 27607' },
    { project: '2754SMIT', address: '2754 Oak Street Durham, NC 27701' },
    { project: '88ABCD', address: '88 Elm Drive Salem, OR 97301' }, { project: '88ABCD-1', address: '88 Elm Dr Salem, OR 97301' },
  ];
  const src = pageSrc.slice(pageSrc.indexOf('const QA_STREET_SKIP'), pageSrc.indexOf('// Fill the project ID from the report'));
  const find = new Function('allRows', 'isOpenQueue', src + 'return qaFindProjects;')(rows, () => false);
  assert.deepEqual(find('2754 Rue Sans Famille, Raleigh, NC 27607'), ['2754BROT']);
  assert.deepEqual(find('88 Elm Drive, Salem, OR 97301').sort(), ['88ABCD', '88ABCD-1']);
  assert.deepEqual(find('2754 Nowhere Road, Raleigh, NC 27607'), []);
});

test('the project box is highlighted, not explained, while it is empty', () => {
  assert.ok(/qaNeedsProject = \(\) => !!qaRun/.test(pageSrc));
  assert.ok(!/Required to save/.test(pageSrc));
});

test('a Radicl image folder is matched to report photos, cut captions included', () => {
  const pack = QA.indexRadiclPack([
    'Images/ExteriorElectrical_BreakerBox_ElectricalPanel#1—DeadFrontOn_0.jpg', 'Images/ExteriorElectrical_BreakerBox_ElectricalPanel#1—DeadFrontOn_1.jpg',
    'Images/ExteriorElectrical_BreakerBox_ElectricalPanel#1—DeadFrontOff_0.jpg',
    'Images/OutsidePhotosofHome_ExteriorPerimeterPhotos_0.jpg', 'Images/OutsidePhotosofHome_ExteriorPerimeterPhotos_1.jpg']);
  const mk = (section, label, ref) => ({ section, label, ref, instance: '1' });
  const cut = [mk('Exterior Electrical', 'Breaker Box / Electrical Panel #1 — Dead Front…', 'x'), mk('Exterior Electrical', 'Breaker Box / Electrical Panel #1 — Dead Front…', 'x'), mk('Exterior Electrical', 'Breaker Box / Electrical Panel #1 — Dead Front…', 'x')];
  const peri = [mk('Outside Photos of Home', 'Exterior Perimeter Photos', 'p'), mk('Outside Photos of Home', 'Exterior Perimeter Photos', 'p')];
  const S = { photos: [...cut, ...peri] };
  assert.deepEqual(cut.map(p => QA.radiclPackFile(S, pack, p).split('—')[1]), ['DeadFrontOn_0.jpg', 'DeadFrontOn_1.jpg', 'DeadFrontOff_0.jpg']);
  assert.match(QA.radiclPackFile(S, pack, peri[1]), /Perimeter.*_1\.jpg$/);
  // a count that does not add up is not guessed at
  assert.equal(QA.radiclPackFile({ photos: cut.slice(0, 2) }, pack, cut[0]), null);
  assert.equal(QA.crossCheckRadiclPack(S, pack).matched, 3);
});

test('the intake no longer asks which survey type it is, and takes photos for either', () => {
  const intake = pageSrc.match(/function _qaIntake\(\) \{[\s\S]*?\n\}\n/)[0];
  assert.ok(!/Survey type|qaSetVendor|Drive/.test(intake));
  assert.ok(/Photos/.test(intake) && /qaDropHtml\('zip'\)/.test(intake));
});

test('Start over lives on the review itself, not in the top bar, and a saved review can be changed', () => {
  const bar = pageSrc.match(/function _qaBar\(\) \{[\s\S]*?\n\}\n/)[0];
  assert.ok(!/qaStartOver/.test(bar));
  assert.ok(/class="qa-startover" onclick="qaStartOver\(\)"/.test(pageSrc));
  assert.ok(/async function qaUpdate\(\)/.test(pageSrc) && /qaApi\('PUT'/.test(pageSrc));
  assert.ok(!/run\.saved \? ' disabled'/.test(pageSrc));          // the status buttons stay live after a save
  assert.ok(/function qaEditRecord\(id\)/.test(pageSrc));
});

test('Settings can turn a check off or change its weight, and the checklist follows', () => {
  const S = survey('radicl', { entries: [] });
  const base = get(QA.evaluate(S, specs), 'roof_pitch');
  assert.equal(base.severity, 'hard');
  assert.equal(get(QA.evaluate(S, specs, { checks: { roof_pitch: 'warn' } }), 'roof_pitch').severity, 'warn');
  assert.equal(QA.evaluate(S, specs, { checks: { roof_pitch: 'off' } }).findings.find(f => f.id === 'roof_pitch'), undefined);
  assert.equal(QA.checklist('radicl-v2', { roof_pitch: 'off' }).some(c => c.id === 'roof_pitch'), false);
  assert.equal(QA.checklist('radicl-v2', { roof_pitch: 'warn' }).find(c => c.id === 'roof_pitch').severity, 'warn');
  assert.ok(QA.allChecks().every(c => c.vendors.length >= 1));
});

test('check settings live in the app Settings page, and the heading reads Expected surveys', () => {
  const idx = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(/id="qa-set-host"/.test(idx) && /_qaSettings\(\)/.test(idx));
  assert.ok(/function _qaSettings\(\)/.test(pageSrc) && !/btn\('settings'/.test(pageSrc));
  assert.ok(pageSrc.includes('Expected surveys') && !pageSrc.includes('Likely to review'));
});

test('alarm-only checks appear only when they fail, and Settings can promote or silence them', () => {
  const ok = survey('sitecapture', { entries: [{ ref: 'x', key: 'office_feedback_were_any', value: 'No', instance: null }] });
  const has = (res, id) => res.findings.some(f => f.id === id);
  assert.equal(has(QA.evaluate(ok, specs), 'resource_match'), false);                      // nothing to compare: silent
  const wrong = QA.evaluate(ok, specs, { sfResource: 'Radicl Services' });
  const f = wrong.findings.find(x => x.id === 'resource_match');
  assert.ok(f && f.alarm && f.status === 'miss' && f.severity === 'warn');
  assert.equal(has(QA.evaluate(ok, specs, { sfResource: 'SunPower Surveyor' }), 'resource_match'), false);   // passes: silent
  assert.equal(has(QA.evaluate(ok, specs, { sfResource: 'Radicl Services', checks: { resource_match: 'off' } }), 'resource_match'), false);
  const promoted = QA.evaluate(ok, specs, { sfResource: 'SunPower Surveyor', checks: { resource_match: 'warn' } }).findings.find(x => x.id === 'resource_match');
  assert.ok(promoted && promoted.status === 'pass');
});

test('photos taken far from the Salesforce address are flagged, near ones pass, and a report with no GPS is left alone', () => {
  const at = (lat, lon) => survey('sitecapture', { photos: [{ ref: 'p', instance: null, page: 1, loc: { lat, lon } }, { ref: 'p', instance: null, page: 1, loc: { lat, lon } }] });
  const run = (S, geo) => QA.evaluate(S, specs, { sfAddress: '1 Main St', sfGeo: geo }).findings.find(x => x.id === 'address_photos');
  const home = { lat: 45.5, lon: -122.5 };
  assert.equal(run(at(45.5002, -122.5), home).status, 'pass');
  assert.equal(run(at(45.5, -122.5), home).status, 'pass');
  assert.equal(run(at(45.5015, -122.5), home).status, 'verify');          // ~170 m
  assert.equal(run(at(45.51, -122.5), home).status, 'miss');              // ~1.1 km
  assert.equal(run(at(45.5, -122.5), null).status, 'verify');             // address not found
  assert.equal(run(survey('sitecapture', { photos: [{ ref: 'p', instance: null, page: 1 }] }), home).status, 'na');
  assert.equal(run(at(45.5, -122.5), undefined).status, 'na');            // not looked up yet
});

test('a finding links the page where the answer is printed, not the page where its label starts', () => {
  const S = survey('radicl', { entries: [
    { ref: 'Electric Service Type', value: null, page: 3, instance: null },       // the label at the foot of one page
    { ref: 'Electric Service Type', value: 'Underground', page: 4, instance: null }] });   // the answer at the head of the next
  const f = QA.evaluate(S, specs).findings.find(x => x.id === 'service_entrance');
  assert.equal(f.found, 'Underground');
  assert.equal(f.page, 4);
});

test('checks that only apply sometimes say when, in the checklist and in Settings', () => {
  const all = QA.allChecks(), by = id => all.find(c => c.id === id);
  assert.ok(/solar already exists/.test(by('existing_equipment').when));
  assert.ok(/battery/.test(by('battery_location').when));
  assert.equal(by('roof_pitch').when, '');
  assert.ok(QA.checklist('radicl-v2').find(c => c.id === 'existing_equipment').when);
  assert.equal(by('attic_photos').zeroHard, true);
});

test('the checklist lives on the Templates tab, not the Review tab, and marks what the template lacks', () => {
  assert.ok(!/function _qaChecklist/.test(pageSrc) && !/What we check/.test(pageSrc));
  assert.ok(/What we review/.test(pageSrc) && /Add to template/.test(pageSrc));
  // a check the template cannot capture is listed with its fix
  const lacking = QA.checklist('sitecapture-v13').filter(c => !c.inTemplate).map(c => c.id);
  const fixes = new Set(QA.templateChanges('sitecapture-v13').map(c => c.id));
  assert.ok(lacking.length && lacking.some(id => fixes.has(id)));
});

test('Site Capture: a group photo captioned without its instance ("Proposed Walls / ...") still counts', () => {
  // The battery groups print "9.5 - Battery Backup / Proposed Walls / <field>" with no wall name,
  // unlike "Mounting Plane MP1 / <field>". Read as unmatched, every battery photo was lost and
  // each required one came out a hard miss.
  const pages = [page(1, [
    blk('9.5 - Battery Backup', 18, 770),
    blk('Proposed Walls 1', 18, 740),
    blk('MW1 Identify Wall', 18, 720),
    blk('9.5 - Battery Backup / Proposed Walls / Garage Floor Cement Type', 18, 400),
    blk('9.5 - Battery Backup / Proposed Battery Install Location / Take photos of the entire room. Take two 360 degree photo sets', 315, 400),
  ])];
  const S = QA.parseSiteCapture(pages, SC);
  const wall = S.photos.find(p => /Cement/.test(p.label));
  assert.equal(wall.ref, 'garage_floor_cement_type');
  assert.equal(wall.instance, 'MW1');
  assert.equal(S.photos.find(p => /entire room/.test(p.label)).ref, 'take_photos_of_the_entire');
  const R = QA.evaluate(S, specs, {});
  assert.ok(!R.findings.some(f => f.id === 'tpl:garage_floor_cement_type'), 'the wall photo counts for MW1');
});

test('Radicl: no pitch written but pitch photos in the report asks for a look, not a hard miss', () => {
  // RD-06 and RD-08: the pitch field is blank, the pitch-gauge photos are there. RD-09, which
  // wrote "Unable to access roof", already got a look; a blank answer with photos is no worse.
  const S = survey('radicl', { photos: [{ ref: 'Roof Pitch / Slope', instance: null, page: 31 }] });
  const f = get(QA.evaluate(S, specs), 'roof_pitch');
  assert.equal(f.status, 'verify'); assert.match(f.detail, /1 pitch photo/);
  assert.equal(get(QA.evaluate(survey('radicl'), specs), 'roof_pitch').status, 'miss');
});

test('Radicl: a bare pitch number has no unit and asks for a look; "panels" alone is not a second structure', () => {
  const run = v => get(QA.evaluate(survey('radicl', { entries: [{ ref: 'Roof Pitch / Slope Measurement', value: v, instance: null }] }), specs), 'roof_pitch');
  assert.equal(run('16').status, 'verify');                       // RD-04: 16/12 or 16 degrees?
  assert.equal(run('10 degrees confirmed on all roof planes where panels will be installed').status, 'pass');   // RD-02
  assert.equal(run('5 in 12 for house. Panels are going on the shop').status, 'verify');
});

test('Radicl: a breaker or bus rating with no number in it is not recorded', () => {
  // RD-08: "Unknown", "No labels", "Unknown. No label. Box closed not able to open" all passed.
  const S = cleanRadicl();
  S.entries = S.entries.filter(e => !/Rating/.test(e.ref)).concat(
    { ref: 'Breaker Box — Main Breaker Rating', value: 'Unknown', instance: '1' }, { ref: 'Breaker Box — Max Bus Rating', value: 'No labels', instance: '1' });
  const R = QA.evaluate(S, specs);
  assert.equal(get(R, 'main_breaker_rating').status, 'miss'); assert.match(get(R, 'main_breaker_rating').detail, /Unknown/);
  assert.equal(get(R, 'bus_rating').status, 'miss');
  assert.equal(get(QA.evaluate(cleanRadicl(), specs), 'main_breaker_rating').status, 'pass');
});

test('a battery-only survey is not held to the roof and attic checks', () => {
  // RD-03 (3219SCHR - Battery Only): no roof was surveyed, and it read Failed for no pitch and no eave.
  const R = QA.evaluate(survey('radicl'), specs, { sfSurveyType: 'Battery Only Survey' });
  for (const id of ['roof_pitch', 'roof_overhang', 'attic_photos', 'attic_framing']) assert.equal(get(R, id).status, 'na', id);
  assert.equal(get(QA.evaluate(survey('radicl'), specs, { sfSurveyType: 'Site Survey + Battery' }), 'roof_pitch').status, 'miss');
});

test('Radicl: no attic access is shown for a look with the surveyor\'s note, not passed over', () => {
  const S = survey('radicl', { entries: [{ ref: 'Is there attic access?', value: 'No', instance: null }, { ref: 'No Attic Access Notes', value: 'Attic not accessible per HO', instance: null }] });
  const f = get(QA.evaluate(S, specs), 'attic_framing');
  assert.equal(f.status, 'verify'); assert.match(f.detail, /not accessible per HO/);
  assert.equal(get(QA.evaluate(S, specs), 'attic_photos').status, 'na');
});

test('Radicl: the page header is never read as a photo caption, however long the address', () => {
  // RD-01: an address long enough to start left of x 400 was read as a caption on every photo
  // page, so the customer's address became an "unknown photo" and was saved in newToSpec.
  const pages = [page(1, [blk('SITE SURVEY REPORT radicl', 32, 808)]), page(2, [
    blk('1411 Long Street Name Rd Klamath Falls, OR 97601', 372, 819), blk('radicl', 32, 812),
    blk('Roof Photos — Photos (1/2)', 32, 767), blk('Roof Pitch / Slope', 37, 733)]),
    // the next photo page: the header comes before its own heading, while the last section is still open
    page(3, [blk('1411 Long Street Name Rd Klamath Falls, OR 97601', 372, 819), blk('Roof Photos — Photos (2/2)', 32, 767), blk('Drip Edge Photo', 37, 733)])];
  const S = QA.parseRadicl(pages, { specId: 'radicl-v2' });
  assert.deepEqual(S.photos.map(p => p.label), ['Roof Pitch / Slope', 'Drip Edge Photo']);
});

test('a Radicl report with the new contents page over August pages is read as the August template', () => {
  // RD-08 (Sep 2): contents say "Exterior Electrical", every page after says "Outside Electrical Information".
  const pages = [page(1, [blk('SITE SURVEY REPORT radicl', 32, 808)]), page(2, [blk('Exterior Electrical', 68, 559)]),
    page(9, [blk('Outside Electrical Information — Photos (1/7)', 32, 767)])];
  assert.equal(QA.detectTemplate(pages, specs).specId, 'radicl-v1');
  assert.equal(QA.detectTemplate(pages.slice(0, 2), specs).specId, 'radicl-v2');
});

test('Radicl completeness runs from the reference reports and skips the roof on a battery-only survey', () => {
  const v2 = specs.find(s => s.id === 'radicl-v2');
  assert.ok(v2.inferredFrom >= 3 && v2.core.length > 10);
  const roofCore = v2.core.filter(c => /Roof Photos|Attic Info/.test(c.section)).length;
  assert.ok(roofCore > 0);
  const tpl = R => R.findings.filter(f => f.layer === 'A' && /Roof Photos|Attic Info/.test(f.area)).length;
  assert.equal(tpl(QA.evaluate(survey('radicl'), specs)), roofCore);
  assert.equal(tpl(QA.evaluate(survey('radicl'), specs, { sfSurveyType: 'Battery Only Survey' })), 0);
});

// The page, run for real: page.js in a VM with the few browser globals it touches at load.
import vm from 'node:vm';
function loadPage() {
  const noop = () => {};
  const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const ctx = { OpsQA: QA, console, setTimeout, clearTimeout, URL, Blob: class {}, localStorage: store(), sessionStorage: store(),
    location: { hash: '', origin: 'http://x', pathname: '/' }, window: { on: {}, addEventListener(t, f) { this.on[t] = f; } }, document: { addEventListener: noop, getElementById: () => null, querySelectorAll: () => [] },
    allRows: [], toast: noop, isOpenQueue: () => false };
  vm.createContext(ctx);
  vm.runInContext(pageSrc + '\n;this.__ = { set: (k, v) => { eval(k + " = v"); }, get: k => eval(k) };', ctx);
  return ctx;
}

test('a review cannot be saved as a pass while a flagged item is undecided', () => {
  // RD-03 in the browser: Passed was saveable with both Dead Front checks (Required) still
  // waiting for a call, and the summary said nothing about them.
  const P = loadPage();
  const S = survey('radicl', { entries: [{ ref: 'Roof Pitch / Slope Measurement', value: 'Unable to access roof', instance: null }] });
  const R = QA.evaluate(S, specs, {});
  const flagged = R.findings.filter(f => f.status === 'verify' || (f.status === 'pass' && f.verify));
  assert.ok(flagged.length >= 1);
  P.__.set('qaRun', { R, S, decisions: {}, items: [], verdicts: {}, status: 'Passed', override: '' });
  P.__.set('qaProj', '3219SCHR'); P.__.set('qaReviewer', 'Doug');
  assert.match(P.qaSaveBlock(), /Decide the \d+ flagged item/);
  P.__.get('qaRun').status = 'Failed - Gaps Found';
  assert.equal(P.qaSaveBlock(), '', 'a fail can be saved without settling every look');
  P.__.get('qaRun').status = 'Passed';
  for (const f of flagged) P.__.get('qaRun').decisions[P.__.get('qaFlagKey')(f)] = 'ok';
  assert.equal(P.qaSaveBlock(), '');
});

test('the address check says which numbers differ without writing either address into the review', () => {
  // A finding's detail is saved to the shared history, which promises never to hold the customer's address.
  const S = survey('radicl', { meta: { address: '21 Valley View Dr, Warren, PA 16365' } });
  const ok = get(QA.evaluate(S, specs, { sfAddress: '21 Valley View Dr, Warren, PA 16365' }), 'address_match');
  const bad = get(QA.evaluate(S, specs, { sfAddress: '23 Valley View Dr, Warren, PA 16365' }), 'address_match');
  assert.equal(ok.status, 'pass'); assert.equal(bad.status, 'miss');
  for (const f of [ok, bad]) assert.ok(!/Valley|Warren/.test(f.detail || ''), f.detail);
  assert.match(bad.detail, /21.*23/);
  // a one-digit house number is the house number, not a reason to compare ZIP codes
  const one = survey('radicl', { meta: { address: '5 Elm St, Warren, PA 16365' } });
  assert.equal(get(QA.evaluate(one, specs, { sfAddress: '7 Elm St, Warren, PA 16365' }), 'address_match').status, 'miss');
  assert.equal(get(QA.evaluate(one, specs, { sfAddress: '5 Elm St, Warren, PA 16365' }), 'address_match').status, 'pass');
});

test('a Radicl partial survey (a go back) is reviewed like a survey; an inspection report is named and refused', () => {
  // RD-11 is the full template under "PARTIAL SURVEY REPORT"; RD-10 is a 2-section inspection.
  const cover = t => [page(1, [blk(t, 400, 808), blk('radicl', 32, 817)]), page(2, [blk('Exterior Electrical', 68, 559)])];
  const partial = QA.detectTemplate(cover('PARTIAL SURVEY REPORT'), specs);
  assert.equal(partial.vendor, 'radicl'); assert.equal(partial.specId, 'radicl-v2'); assert.equal(partial.partial, true);
  assert.equal(QA.detectTemplate(cover('SITE SURVEY REPORT'), specs).partial, false);
  const insp = QA.detectTemplate(cover('INSPECTION REPORT'), specs);
  assert.equal(insp.vendor, 'unknown'); assert.match(insp.reason, /Radicl inspection report/);
  const S = QA.parseRadicl(cover('PARTIAL SURVEY REPORT'), { specId: 'radicl-v2', partial: true });
  assert.match(QA.summarize(QA.evaluate(S, specs, {})).text, /^QA review 1 · Radicl partial survey/);
});

test('Site Capture: a label wrapped at a slash still matches, so its answer is read', () => {
  // Every Site Capture report prints "...hookup\n/transfer switch..."; the template says
  // "hookup/transfer". The generator question read its own label tail as the answer, so a
  // generator was never seen (SC-11 has one).
  const pages = [page(1, [
    blk('1 - Customer Information', 18, 759),
    { text: 'Does the home have a\ngenerator or generator hookup\ninstalled? (If yes, photos of\nthe generator and hookup\n/transfer switch MUST be\nincluded in the electrical\nsection)', x0: 18, y0: 318, x1: 150, y1: 250 },
    { text: 'Yes', x0: 171, y0: 318, x1: 190, y1: 310 },
  ])];
  const S = QA.parseSiteCapture(pages, SC);
  assert.equal(S.value(/^does_the_home_have_a_generator/), 'Yes');
});

test('a review the coordinator fails lists its misses as the go back, even when none is Required', () => {
  // SC-08 saved as Failed with five Flagged misses read "Noted:" and never said what to go back for.
  const R = { template: { vendor: 'sitecapture' }, meta: {}, findings: [{ id: 'x', area: 'Attic', status: 'miss', severity: 'warn', title: 'Attic photographed for every plane', detail: 'MP2: 1 of 10+ photos' }] };
  assert.match(QA.summarize(R, { status: 'Failed - Gaps Found' }).text, /Needs go back \/ follow-up:\nAttic\n- Attic photographed/);
  assert.match(QA.summarize(R, { status: 'Passed' }).text, /Noted:\nAttic\n- Attic photographed/);
});

test('a failing server is not a wrong password, and nothing is saved to one browser behind the team\'s back', async () => {
  // Any reply but 200/401 used to drop into the browser-only log: a teammate's own password was
  // then "wrong" (signed out, sent away), and the shared password saved reviews into one browser.
  for (const status of [0, 500, 502]) {
    const P = loadPage(), toasts = [];
    P.toast = m => toasts.push(m); P.nav = () => toasts.push('nav');
    P.fetch = async () => { if (!status) throw new Error('offline'); return { status, json: async () => ({ error: 'server_error' }) }; };
    P.sessionStorage.setItem('ops_qa_pw', 'sunpower');
    assert.equal(await P.qaSync(), true);
    assert.equal(P.__.get('qaMode'), 'down', 'status ' + status);
    assert.ok(!toasts.includes('Wrong password') && !toasts.includes('nav'));
    assert.equal(await P.qaReady(), false);
  }
  // A local copy with no API at all still keeps reviews in the browser, as before.
  const L = loadPage(); L.fetch = async () => ({ status: 404, json: async () => { throw new Error('html'); } });
  L.sessionStorage.setItem('ops_qa_pw', 'sunpower'); L.toast = () => {};
  await L.qaSync(); assert.equal(L.__.get('qaMode'), 'local');
});

test('leaving the page with an unsaved review asks first', () => {
  const P = loadPage(), leave = () => { const e = { returnValue: undefined, preventDefault() { this.prevented = true; } }; P.window.on.beforeunload(e); return !!e.prevented; };
  assert.equal(leave(), false, 'nothing open');
  const R = QA.evaluate(survey('radicl'), specs, {});
  P.__.set('qaRun', { R, S: survey('radicl'), decisions: {}, items: [], verdicts: {}, status: null, override: '', summary: '', saved: null });
  assert.equal(leave(), true, 'an unsaved review');
  const run = P.__.get('qaRun'); run.saved = 'QA-X-1'; run.snap = P.qaSnap();
  assert.equal(leave(), false, 'saved and unchanged');
  run.status = 'Passed';
  assert.equal(leave(), true, 'saved, then changed');
});

test('the resource alarm stays quiet on a go back, where Salesforce still names the first survey\'s resource', () => {
  // RD-11 (3472IKRO): a Sales Rep survey in August, sent back by Design, re-done by Radicl.
  const S = QA.parseRadicl([page(1, [blk('PARTIAL SURVEY REPORT radicl', 32, 808)])], { specId: 'radicl-v2', partial: true });
  const alarm = ctx => QA.evaluate(S, specs, ctx).findings.find(f => f.id === 'resource_match');
  assert.equal(alarm({ sfResource: 'Sales Rep' }), undefined);
  assert.equal(alarm({ sfResource: 'Sales Rep', sfReopened: true }), undefined);
  const full = QA.parseRadicl([page(1, [blk('SITE SURVEY REPORT radicl', 32, 808)])], { specId: 'radicl-v2' });
  assert.equal(QA.evaluate(full, specs, { sfResource: 'Sales Rep' }).findings.find(f => f.id === 'resource_match').status, 'miss');
  assert.equal(QA.evaluate(full, specs, { sfResource: 'Sales Rep', sfReopened: true }).findings.find(f => f.id === 'resource_match'), undefined);
});

test('an unsettled check asks for the photos beside it on the summary, and none once it is decided', () => {
  // RD-07: 36 dead-front photos all had the yellow border, and kept it after the check was decided.
  const P = loadPage();
  const S = survey('radicl', { photos: Array.from({ length: 6 }, () => ({ ref: 'Breaker Box — Dead Front', instance: '1', page: 3 })) });
  const R = QA.evaluate(S, specs, {});
  const items = Array.from({ length: 6 }, (_, k) => ({ id: 'breaker', unit: '1', n: k + 1, url: 'blob:' + k }));
  P.__.set('qaRun', { R, S, decisions: {}, items, verdicts: {} });
  const look = P.__.get('qaNeedsLook');
  assert.deepEqual(items.map(look), [true, true, true, false, false, false]);
  // On and Off both rest on these photos here (Radicl cuts both captions to "Dead Front…").
  const key = id => P.__.get('qaFlagKey')(R.findings.find(x => x.id === id));
  P.__.get('qaRun').decisions[key('msp_dead_front_on')] = 'ok';
  assert.deepEqual(items.map(look), [true, true, true, false, false, false], 'Off is still open');
  P.__.get('qaRun').decisions[key('msp_dead_front_off')] = 'ok';
  assert.deepEqual(items.map(look), [false, false, false, false, false, false]);
});

test('panel location, dead front off, meter location and site map have photo rows, and their checks point at them', () => {
  const sc = (label, group) => SC.fields.find(f => label.test(f.label) && (!group || f.group === group)).key;
  const S = survey('sitecapture', { groups: { electrical_equipment: [{ idx: 1, id: 'MSP' }] }, photos: [
    { ref: sc(/^Dead Front Off - Full length/, 'electrical_equipment'), instance: 'MSP' },
    { ref: sc(/^Location - 1\.\) 5\+ photos showing entire wall/, 'electrical_equipment'), instance: 'MSP' },
    { ref: sc(/5\+ photo\(s\) of ENTIRE side of home the meter/, 'electrical_meter'), instance: 'Meter 1' },
    { ref: sc(/^Site Map/), instance: null }] });
  const ids = S => new Set(QA.keyPhotos(S, SC, { all: true }).map(k => k.id));
  for (const id of ['deadoff', 'location', 'meterloc', 'sitemap']) assert.ok(ids(S).has(id), 'sitecapture ' + id);
  const R = survey('radicl', { photos: [{ ref: 'Breaker Box — Dead Front Off', instance: 'in1' }, { ref: 'Breaker Box — Location Photos', instance: 'in1' },
    { ref: 'Electric Meter: Location Photos', instance: null }, { ref: 'Layout Map', instance: null }] });
  for (const id of ['deadoff', 'location', 'meterloc', 'sitemap']) assert.ok(ids(R).has(id), 'radicl ' + id);
  const P = loadPage(), cat = P.__.get('QA_FIND_CAT');
  assert.deepEqual([cat.msp_location, cat.meter_location, cat.site_map].map(c => [].concat(c)[0]), ['location', 'meterloc', 'sitemap']);
  assert.equal([].concat(cat.msp_dead_front_off)[0], 'deadoff');
  // and the checks read off a photo another row already holds
  assert.deepEqual([cat.attic_photos, cat.bus_rating, cat.service_entrance], ['attic', 'label', 'meterloc']);
  assert.ok(QA.KEY_PHOTOS.some(k => k.id === 'attic'));
});

test('the Salesforce summary groups its lines by area, in review order', () => {
  const R = { template: { vendor: 'radicl' }, meta: {}, suggestedStatus: 'Failed - Gaps Found', findings: [
    { id: 'a', area: 'Electrical', status: 'miss', severity: 'hard', title: 'Meter close-up', detail: 'no photos' },
    { id: 'b', area: 'Roof', status: 'miss', severity: 'hard', title: 'Roof pitch', detail: 'No roof pitch recorded' },
    { id: 'c', area: 'Electrical', status: 'miss', severity: 'hard', title: 'Dead front on', detail: 'no photos' },
    { id: 'd', area: 'Site', status: 'miss', severity: 'warn', title: 'Site map', detail: 'no photos' }] };
  const t = QA.summarize(R, { status: 'Passed' }).text;
  assert.match(t, /Needs go back \/ follow-up:\nRoof\n- Roof pitch: No roof pitch recorded\nElectrical\n- Meter close-up: no photos\n- Dead front on: no photos\nAlso noted:\nSite\n- Site map: no photos/);
});
