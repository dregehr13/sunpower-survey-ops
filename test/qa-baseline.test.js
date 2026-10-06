// test/qa-baseline.test.js — the baseline carries ids and statuses only, and diff names what moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Base = require('../lib/qa-baseline.cjs');

const det = { specId: 'rep-v1', vendor: 'rep' };
const R = findings => ({ suggestedStatus: 'Failed - Gaps Found', counts: { missHard: 1 }, findings });
const f = (id, status, extra) => Object.assign({ id, status, title: 'T ' + id, detail: '12 Main St' }, extra);

test('an entry holds no titles or details, and skips n/a findings', () => {
  const e = Base.entryOf(det, R([f('b', 'pass'), f('a', 'miss', { severity: 'hard' }), f('c', 'na')]));
  assert.deepEqual(e.findings, [{ k: 'a', s: 'miss', v: 'hard' }, { k: 'b', s: 'pass', v: '' }]);
  assert.ok(!JSON.stringify(e).includes('Main St'));
});

test('diff is empty for the same run and names status, new, changed and gone findings', () => {
  const was = Base.entryOf(det, R([f('a', 'miss', { severity: 'hard' }), f('b', 'pass')]));
  assert.deepEqual(Base.diff(was, was), []);
  const now = Base.entryOf(det, Object.assign(R([f('a', 'miss', { severity: 'warn' }), f('c', 'verify')]), { suggestedStatus: 'Needs review' }));
  assert.deepEqual(Base.diff(was, now), ['status Failed - Gaps Found → Needs review', 'changed: a miss hard → miss warn', 'new: c (verify)', 'gone: b']);
});
