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
      ...ph('Electrical Meter: Close Up'), ...ph('Electric Meter: Location Photos'), ...ph('Layout Map'), ...ph('Eave/Soffit Measurement Photo')],
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
  assert.ok(by(sc, 'photos_deleted') && !by(rd, 'photos_deleted'));  // vendor-specific checks only appear for their vendor
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

test('the QA page keeps reports in the browser: nothing posts a file anywhere', () => {
  assert.equal(/method:\s*['"]POST['"]/.test(pageSrc), false);
  assert.equal(/\.send\(/.test(pageSrc), false);
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

test('the five review steps exist and each has a renderer', () => {
  for (const fn of ['_qaFindings', '_qaPhotosStep', '_qaReportStep', '_qaSummaryStep', '_qaStatusStep', '_qaChecklist', '_qaIntake']) {
    assert.ok(new RegExp('function\\s+' + fn + '\\b').test(pageSrc), fn);
  }
  assert.ok(/const QA_STEPS = \['Findings', 'Photos', 'Report', 'Summary', 'Status & save'\]/.test(pageSrc));
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
  const src = pageSrc.match(/const qaIsFlagged[\s\S]*?\nconst qaFlagKey[^\n]*\n/)[0] + pageSrc.match(/function qaFindings\(\) \{[\s\S]*?\n\}\n/)[0];
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
