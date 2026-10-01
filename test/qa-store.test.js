// test/qa-store.test.js — the QA review history, against a real Postgres.
//
// PGlite is Postgres compiled to WASM, so these run the production SQL — the
// INSERT ... SELECT that numbers a review, the jsonb columns, the unique-id
// retry — rather than a mock of it. Nothing needs a network or a database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
const require = createRequire(import.meta.url);
const Store = require('../lib/qa-store.cjs');

const fresh = async () => { const pg = new PGlite(); const db = { query: (t, p) => pg.query(t, p) }; await Store.ensureSchema(db); return db; };
const hash = c => c.repeat(64);
const review = (o = {}) => ({
  project: '2321LOPE', status: 'Failed - Gaps Found', reviewer: 'Doug Regehr', template: 'sitecapture-v13', vendor: 'sitecapture',
  file: { name: 'r.pdf', size: 1234, hash: hash('a') }, counts: { missHard: 1, missWarn: 2 }, summary: 'QA review 1',
  findings: [{ id: 'roof_pitch', layer: 'B', area: 'Roof', status: 'miss', severity: 'hard', standing: false, title: 'Pitch', detail: 'No tilt reading for MP2' }],
  sf: { task_id: 'a03US', resource: 'SunPower Surveyor', status: 'In Progress', address: '23210 NE Village Ct' }, ...o,
});
const save = (db, o) => { const v = Store.validate(review(o)); assert.ifError(v.error && new Error(v.error)); v.rec.created = null; return Store.insert(db, v.rec); };

test('the schema can be created twice', async () => {
  const db = await fresh();
  await Store.ensureSchema(db);
  assert.deepEqual(await Store.list(db), []);
});

test('a saved review comes back whole, with the server assigning id and number', async () => {
  const db = await fresh();
  const a = await save(db, { id: 'client-chose-this', n: 99 });
  assert.equal(a.id, 'QA-2321LOPE-1'); assert.equal(a.n, 1);
  assert.equal(a.file.hash, hash('a')); assert.equal(a.counts.missHard, 1);
  assert.equal(a.findings[0].detail, 'No tilt reading for MP2');
  assert.deepEqual((await Store.list(db)).map(r => r.id), ['QA-2321LOPE-1']);
});

test('the review number counts the account, not the table', async () => {
  const db = await fresh();
  assert.equal((await save(db)).n, 1);
  assert.equal((await save(db, { project: 'OTHER1' })).n, 1);
  assert.equal((await save(db)).n, 2);
  assert.equal((await save(db)).id, 'QA-2321LOPE-3');
});

test('two reviews of one account saved at the same instant get different numbers', async () => {
  const db = await fresh();
  const out = await Promise.all([save(db), save(db), save(db), save(db)]);
  assert.deepEqual(out.map(r => r.n).sort(), [1, 2, 3, 4]);
});

test('a colliding id is retried with the next number', async () => {
  const db = await fresh();
  let tripped = false;
  const flaky = { query: async (t, p) => { if (!tripped && /INSERT INTO qa_reviews/.test(t)) { tripped = true; const e = new Error('duplicate key'); e.code = '23505'; throw e; } return db.query(t, p); } };
  const v = Store.validate(review()); v.rec.created = null;
  assert.equal((await Store.insert(flaky, v.rec)).id, 'QA-2321LOPE-1');
  assert.equal(tripped, true);
});

test('the summary opens with the number the server assigned', async () => {
  const db = await fresh();
  await save(db); await save(db);
  const third = await save(db, { summary: 'QA review 1 · Site Capture · report 09/25/2026\nNoted:' });
  assert.equal(third.n, 3);
  assert.ok(third.summary.startsWith('QA review 3 · Site Capture'));
  assert.equal((await save(db, { project: 'ZZZ999', summary: 'something else entirely' })).summary, 'something else entirely');
});

test('a deleted review leaves the list but its number is never reused', async () => {
  const db = await fresh();
  const a = await save(db); await save(db);
  assert.equal(await Store.remove(db, a.id, 'Doug'), true);
  assert.equal(await Store.remove(db, a.id, 'Doug'), false);                 // already gone
  assert.deepEqual((await Store.list(db)).map(r => r.id), ['QA-2321LOPE-2']);
  assert.equal((await save(db)).id, 'QA-2321LOPE-3');
});

test('a Radicl photo folder link is kept, and only a Drive link is accepted', async () => {
  const db = await fresh();
  const link = 'https://drive.google.com/drive/folders/1oARphFZ9aJkC1imYTjY_G8831pBWuCbx';
  assert.equal((await save(db, { photoLink: link })).photoLink, link);
  assert.equal((await save(db)).photoLink, '');
  assert.match(Store.validate(review({ photoLink: 'https://evil.example/x' })).error, /Drive/);
  assert.match(Store.validate(review({ photoLink: 'javascript:alert(1)' })).error, /Drive/);
});

test('the customer address is never stored', async () => {
  const db = await fresh();
  await save(db);
  const { rows } = await db.query('SELECT sf FROM qa_reviews');
  assert.equal(JSON.stringify(rows[0].sf).includes('Village'), false);
  assert.equal(rows[0].sf.task_id, 'a03US');
});

test('validation refuses what the page should never send', () => {
  const bad = (o, re) => { const v = Store.validate(review(o)); assert.match(v.error || '', re); };
  bad({ status: 'Done' }, /status/);
  bad({ project: 'x' }, /project/);
  bad({ reviewer: '  ' }, /reviewer/);
  bad({ vendor: 'acme' }, /vendor/);
  bad({ source: 'Robot' }, /source/);
  bad({ file: { hash: 'nope' } }, /SHA-256/);
  bad({ status: 'Passed with Override', override: 'no' }, /override/);
  assert.equal(Store.validate(null).error, 'review must be an object');
});

test('validation caps what it keeps', () => {
  const v = Store.validate(review({ findings: Array.from({ length: 900 }, () => ({ title: 't'.repeat(900) })), summary: 's'.repeat(50000) }));
  assert.equal(v.rec.findings.length, 400);
  assert.equal(v.rec.findings[0].title.length, 200);
  assert.equal(v.rec.summary.length, 20000);
  assert.equal(v.rec.project, '2321LOPE');
});

test('importing a browser log keeps ids, skips what is already here, renumbers a clash', async () => {
  const db = await fresh();
  const mine = { ...review(), id: 'QA-2321LOPE-1', n: 1, created: '2026-09-01T10:00:00Z' };
  const out1 = await Store.importMany(db, [mine, { ...mine, id: 'QA-2321LOPE-2', n: 2, file: { ...mine.file, hash: hash('b') } }]);
  assert.deepEqual(out1, { inserted: 2, skipped: 0, renumbered: 0 });
  assert.equal((await Store.list(db)).find(r => r.id === 'QA-2321LOPE-1').created, '2026-09-01T10:00:00.000Z');
  // the same two again: nothing new
  assert.deepEqual(await Store.importMany(db, [mine]), { inserted: 0, skipped: 1, renumbered: 0 });
  // another browser also called its first review of the account number 1, for a different report
  const theirs = { ...mine, file: { ...mine.file, hash: hash('c') } };
  assert.deepEqual(await Store.importMany(db, [theirs]), { inserted: 1, skipped: 0, renumbered: 1 });
  assert.deepEqual((await Store.list(db)).map(r => r.id).sort(), ['QA-2321LOPE-1', 'QA-2321LOPE-2', 'QA-2321LOPE-3']);
  // junk is skipped, not fatal
  assert.deepEqual(await Store.importMany(db, [{ nonsense: true }]), { inserted: 0, skipped: 1, renumbered: 0 });
});

// ── The endpoint ──
const env = { QA_PASSWORD: 'open-sesame', QA_USERS: JSON.stringify({ 'spwr-banks': 'Kendall Banks', 'spwr-mertz': 'Skylar Mertz' }) };
const call = (db, method, o = {}, e = env) => Store.handle({ method, query: o.query, body: o.body, headers: { 'x-qa-password': o.pw === undefined ? 'open-sesame' : o.pw } }, e, db);

test('the endpoint refuses without a known password, and says so when none is set up', async () => {
  const db = await fresh();
  assert.equal((await call(db, 'GET', { pw: 'wrong' })).status, 401);
  assert.equal((await Store.handle({ method: 'GET', headers: {} }, env, db)).status, 401);
  assert.equal((await call(db, 'GET', {}, {})).status, 503);                        // nothing configured
  assert.equal((await call(null, 'GET')).status, 503);                              // no database
  assert.equal((await call(null, 'GET')).body.error, 'not_configured');
});

test('each person is identified by their own password', async () => {
  const db = await fresh();
  assert.equal((await call(db, 'GET', { pw: 'spwr-banks' })).body.user, 'Kendall Banks');
  assert.equal((await call(db, 'GET', { pw: 'spwr-mertz' })).body.user, 'Skylar Mertz');
  assert.equal((await call(db, 'GET', { pw: 'open-sesame' })).body.user, 'Douglas Regehr');
  assert.equal((await call(db, 'GET', { pw: 'spwr-banks ' })).status, 401);          // exact, not close
  assert.equal(Store.identify('SPWR-BANKS', env), null);
  assert.equal(Store.identify('spwr-banks', { QA_USERS: '{not json' }), null);       // an unreadable list grants nobody
  assert.equal(Store.identify('x', { QA_PASSWORD: 'x', QA_PASSWORD_NAME: 'Allie Morais' }).name, 'Allie Morais');
});

test('a review is stamped with the password owner, whatever the page sent', async () => {
  const db = await fresh();
  const out = await call(db, 'POST', { pw: 'spwr-banks', body: { review: review({ reviewer: 'Someone Else' }) } });
  assert.equal(out.status, 201);
  assert.equal(out.body.review.reviewer, 'Kendall Banks');
  const del = await call(db, 'DELETE', { pw: 'spwr-mertz', query: { id: out.body.review.id, by: 'Spoofed' } });
  assert.equal(del.status, 200);
  const { rows } = await db.query('SELECT deleted_by FROM qa_reviews');
  assert.equal(rows[0].deleted_by, 'Skylar Mertz');
});

test('the endpoint saves, lists and deletes', async () => {
  const db = await fresh();
  const bad = await call(db, 'POST', { body: { review: review({ status: 'x' }) } });
  assert.equal(bad.status, 400);
  const ok = await call(db, 'POST', { body: { review: review() } });
  assert.equal(ok.status, 201); assert.equal(ok.body.review.id, 'QA-2321LOPE-1');
  const all = await call(db, 'GET');
  assert.equal(all.body.reviews.length, 1);
  assert.equal((await call(db, 'DELETE', { query: { id: 'nope' } })).status, 404);
  assert.equal((await call(db, 'DELETE', { query: { id: 'QA-2321LOPE-1' } })).status, 200);
  assert.equal((await call(db, 'GET')).body.reviews.length, 0);
  assert.equal((await call(db, 'PUT')).status, 405);
});

test('the server stamps the time, not the browser', async () => {
  const db = await fresh();
  const out = await call(db, 'POST', { body: { review: review({ created: '1999-01-01T00:00:00Z' }) } });
  assert.ok(new Date(out.body.review.created).getFullYear() >= 2026);
});

test('password comparison is exact', () => {
  assert.equal(Store.passwordOk('a', 'a'), true);
  assert.equal(Store.passwordOk('a', 'b'), false);
  assert.equal(Store.passwordOk('', ''), false);
  assert.equal(Store.passwordOk(undefined, 'x'), false);
  assert.equal(Store.passwordOk('open-sesame ', 'open-sesame'), false);
});

test('Salesforce project names with a suffix or a dot are accepted', async () => {
  for (const p of ['350VPITT - Battery Only', '5460S.OR - Battery Only', '2639REES-1']) {
    const v = Store.validate(review({ project: p }));
    assert.ok(!v.error, p + ' ' + v.error);
  }
});
