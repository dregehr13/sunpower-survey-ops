// test/surfaces.test.js — Phase 4 of the metrics audit: cross-surface guards.
//
// The dashboard, the compose email, and api/morning-card.js all render the same
// concepts. Every drift bug we have hit came from one of them quietly growing
// its own copy of a definition — three SS ratios that disagreed by 34% on the
// same week, a Trends line testing !r.complete instead of isComplete().
//
// These are static checks over the source files rather than value comparisons:
// index.html is a 243KB HTML document, not an importable module, so the durable
// guard is "no surface reimplements a shared definition" — enforced by grep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SURFACES = ['index.html', 'compose/index.html'];

// Strip block/line comments so a rule documented in prose doesn't trip its own check.
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const linesMatching = (src, re) => stripComments(src)
  .split('\n')
  .map((line, i) => ({ n: i + 1, line: line.trim() }))
  .filter(({ line }) => re.test(line));

test('no surface reimplements the completion test', () => {
  // isComplete() requires a date AND list==='Complete'. A bare !r.complete or
  // r.complete check silently treats Holding/Reopened rows as finished.
  const bad = [];
  for (const f of SURFACES) {
    linesMatching(read(f), /(^|[^.\w])!\s*r\.complete\b(?!_)/)
      .forEach(({ n, line }) => bad.push(`${f}:${n}  ${line.slice(0, 90)}`));
  }
  assert.deepEqual(bad, [], `use isComplete(r) from lib/metrics.cjs:\n${bad.join('\n')}`);
});

test('no surface reads a data.js const off window', () => {
  // DATA_TS and RAW are top-level consts in data.js, so they are NOT properties
  // of window. `window.DATA_TS` is always undefined and silently falls through
  // to the wall clock — it shipped that way in three places.
  const bad = [];
  for (const f of SURFACES) {
    linesMatching(read(f), /window\.(DATA_TS|RAW)\b/)
      .forEach(({ n, line }) => bad.push(`${f}:${n}  ${line.slice(0, 90)}`));
  }
  assert.deepEqual(bad, [], `use a bare typeof guard instead:\n${bad.join('\n')}`);
});

test('status bands are never computed inline', () => {
  // Colour must come from bandFor()/ssRatioBand(), which band on the DISPLAYED
  // value. An inline threshold against a raw value re-opens the "card reads
  // 4.0d but is coloured amber" bug.
  const bad = [];
  for (const f of SURFACES) {
    linesMatching(read(f), /Math\.round\([^)]*\*\s*10\s*\)\s*\/\s*10\s*[<>]/)
      .forEach(({ n, line }) => bad.push(`${f}:${n}  ${line.slice(0, 90)}`));
  }
  assert.deepEqual(bad, [], `band via lib/metrics.cjs:\n${bad.join('\n')}`);
});

test('shared definitions are imported, not redefined, on every surface', () => {
  // Each surface must pull its definitions from lib/metrics.cjs rather than
  // declaring a local function of the same name.
  const SHARED = ['isComplete', 'isWIP', 'wipAgeFrom', 'ssDaysOpen', 'ssRatioForWeek', 'ssRatioLive'];
  const bad = [];
  for (const f of SURFACES) {
    const src = stripComments(read(f));
    assert.ok(/OpsMetrics/.test(src), `${f} does not reference OpsMetrics`);
    for (const name of SHARED) {
      const redefined = new RegExp(`function\\s+${name}\\s*\\(`);
      if (redefined.test(src)) bad.push(`${f} redefines ${name}()`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('first pass yield is never computed inline', () => {
  // FPY had six hand-written copies of (n - defects) / n * 100 inside
  // renderResurvey alone, which is how "Total Resurveys" once read 385 while
  // FPY counted 434 on the same screen. It is fpy() in lib/metrics.cjs now.
  //
  // Structural, not name-based: an earlier name-matching version missed
  // (w.n - w.d) and (c.length - c.filter(isResurveyDefect).length) — two of
  // the six — and name-matching is what let two more copies hide on the
  // Current page as lwFpy/pwFpy. This matches the shape instead: a
  // parenthesised subtraction, divided, scaled to 100.
  const SHAPE = /\((?:[^()]|\([^()]*\))*-(?:[^()]|\([^()]*\))*\)\s*\/[^;*]*\*\s*100/;
  // A subtraction-over-total percentage is not always FPY — the Current page
  // computes a week-over-week volume change the same way. Only flag lines
  // whose subtrahend is a defect/resurvey count.
  const DEFECTISH = /def|resur|fpy|yield/i;
  const bad = [];
  for (const f of SURFACES) {
    linesMatching(read(f), SHAPE)
      .filter(({ line }) => DEFECTISH.test(line))
      .forEach(({ n, line }) => bad.push(`${f}:${n}  ${line.slice(0, 90)}`));
  }
  assert.deepEqual(bad, [], `use fpy() from lib/metrics.cjs:\n${bad.join('\n')}`);
});

test('metrics.cjs exports everything the surfaces destructure from it', () => {
  // A surface destructuring a name that metrics.cjs does not export gets
  // undefined and fails at call time, not load time — so it survives a smoke test.
  const mod = read('lib/metrics.cjs');
  // Capture only the inside of the module-level `return { ... };` — the inner
  // `return {`s belong to helper functions and must not be picked up.
  const exportBlock = (mod.match(/\n  return \{([\s\S]*?)\};/) || [, ''])[1];
  assert.ok(exportBlock, 'could not locate the metrics.cjs export block');
  const exported = new Set(
    exportBlock.split(',').map(t => t.trim().split(':')[0].trim()).filter(Boolean),
  );
  assert.ok(exported.has('isComplete'), 'export parser drifted — isComplete not found');
  const bad = [];
  for (const f of SURFACES) {
    const src = read(f);
    const blocks = src.match(/const\s*\{[^}]*\}\s*=\s*OpsMetrics/g) || [];
    assert.ok(blocks.length > 0, `${f} has no OpsMetrics destructure`);
    for (const block of blocks) {
      block.replace(/^const\s*\{|\}\s*=\s*OpsMetrics$/g, '')
        .split(',').map(s => s.trim()).filter(Boolean)
        .forEach(name => { if (!exported.has(name)) bad.push(`${f} destructures "${name}" which metrics.cjs does not export`); });
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('every TIP entry is referenced by a card', () => {
  // A stale TIP is a tooltip describing behaviour the code no longer has —
  // TIP.wip outlived the rep grace day by a full release.
  const src = read('index.html');
  const tipBlock = (src.match(/const TIP=\{[\s\S]*?\n\};/) || [''])[0];
  assert.ok(tipBlock, 'could not locate the TIP dictionary');
  const keys = [...tipBlock.matchAll(/^\s{2}([a-zA-Z0-9_]+)\s*:/gm)].map(m => m[1]);
  assert.ok(keys.length > 5, `only found ${keys.length} TIP keys — parser drifted`);
  const body = src.replace(tipBlock, '');
  const unused = keys.filter(k => !new RegExp(`TIP\\.${k}\\b`).test(body));
  assert.deepEqual(unused, [], `unused TIP entries (stale or a card lost its tooltip): ${unused.join(', ')}`);
});
