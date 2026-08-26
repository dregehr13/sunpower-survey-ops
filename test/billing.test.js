// test/billing.test.js — invoice reconciliation rules.
//
// The rules here decide whether Doug disputes an invoice line, so the cases
// that exist because a rule was once wrong are marked as such. Two of them
// caught real false positives on the first live statement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const B = require('../lib/billing.cjs');

const line = (o = {}) => ({ vendor: 'radicl', name: 'Jane Smith', address: '123 Main St, Springfield',
  date: '2026-07-01', type: 'Survey', subtype: 'Base', units: -14.2, statement: 'radicl/s1', line: 1, ...o });
const survey = (o = {}) => ({ contact: 'Jane Smith', address: '123 Main St Springfield, IL 62704',
  resource: 'Radicl Services', ...o });

test('unit price and travel adder come from the vendor spec', () => {
  assert.equal(B.usd(14.2), 284);
  assert.equal(B.usd(9), 180);
  assert.equal(B.vendor('radicl').travelAdderUnits, 9);
  // An unknown id falls back rather than throwing — a statement should never
  // fail to load because of a typo in a vendor flag.
  assert.equal(B.vendor('nope').id, 'radicl');
});

test('line kinds follow the vendor taxonomy', () => {
  assert.equal(B.lineKind(line({ subtype: 'Base' })), B.KINDS.WORK);
  assert.equal(B.lineKind(line({ subtype: 'Partial Survey' })), B.KINDS.WORK);
  assert.equal(B.lineKind(line({ subtype: 'Go Back' })), B.KINDS.WORK);
  assert.equal(B.lineKind(line({ subtype: 'Travel', units: -9 })), B.KINDS.TRAVEL);
  assert.equal(B.lineKind(line({ subtype: 'Demob', units: -4.45 })), B.KINDS.OTHER);
  assert.equal(B.lineKind(line({ type: 'Credits Added', subtype: '', units: 1000 })), B.KINDS.TOPUP);
});

test('a top-up is never counted as a charge', () => {
  const top = line({ type: 'Credits Added', subtype: '', units: 1000 });
  assert.equal(B.isCharge(top), false);
  const s = B.summarize([top]);
  assert.equal(s.usd, 0, 'a statement of nothing but top-ups has spent nothing');
  assert.equal(s.surveys, 0);
  assert.equal(s.toppedUp, 1000, 'the top-up is still counted, as a top-up');
});

test('subtype roles separate a first visit from cleanup and rework', () => {
  assert.equal(B.subtypeRole(line({ subtype: 'Base' })), 'first');
  assert.equal(B.subtypeRole(line({ subtype: 'Partial Survey' })), 'cleanup');
  assert.equal(B.subtypeRole(line({ subtype: 'Go Back' })), 'rework');
});

test('matching survives the formatting gap between the two systems', () => {
  // Billing: "123 Main St, Springfield". Salesforce: "123 Main St Springfield, IL 62704".
  assert.ok(B.scoreMatch(line(), survey()) >= B.MATCH_THRESHOLD);
  // Same street number, different street and person — must not match.
  assert.equal(B.scoreMatch(line(), survey({ contact: 'Bob Jones', address: '123 Oak Ave Peoria, IL 61602' })), 0 + 0);
  // Different street number cannot match at any name similarity.
  assert.equal(B.scoreMatch(line(), survey({ address: '999 Main St Springfield, IL 62704' })), 0);
});

test('accountKey is stable against duplicated surnames and formatting', () => {
  // A real statement wrote "Dominic Catalano Catalano".
  assert.equal(B.accountKey('Dominic Catalano Catalano', '2707 Bald Eagle Cir, Eagleville'),
               B.accountKey('Dominic Catalano', '2707 Bald Eagle Cir Eagleville, PA 19403'));
  assert.equal(B.accountKey('Ruth Ann  Hopps', '2118 SE Dussault Rd, Madras'),
               B.accountKey('RUTH ANN HOPPS', '2118 SE Dussault Rd Madras, OR 97741'));
});

test('own-defect rework needs BOTH attribution and who held the original', () => {
  // The false positive this exists for: Salesforce attributes a REP-performed
  // survey to "Surveyor" too — meaning the rep. Reading attribution alone
  // turned 1 real case into an apparent 4 on the first live statement.
  const rework = line({ subtype: 'Go Back' });
  assert.equal(B.isOwnDefectRebill(rework, survey({ resurvey_attributed: 'Surveyor', resource: 'Radicl Services' })), true);
  assert.equal(B.isOwnDefectRebill(rework, survey({ resurvey_attributed: 'Surveyor', resource: 'Sales Rep' })), false);
  assert.equal(B.isOwnDefectRebill(rework, survey({ resurvey_attributed: 'Design', resource: 'Radicl Services' })), false);
  // A first visit is never own-defect rework, whatever the attribution says.
  assert.equal(B.isOwnDefectRebill(line({ subtype: 'Base' }), survey({ resurvey_attributed: 'Surveyor' })), false);
});

test('a first visit followed by a return is a sequence, not a duplicate', () => {
  // The second false positive: Base → Go Back on one account is the normal
  // shape of a repeat visit. Flagging it as a duplicate charge cried wolf on
  // every legitimate return and would have buried the real ones.
  const rows = [survey()];
  const out = B.reconcile([
    line({ subtype: 'Base', date: '2026-07-13', line: 1 }),
    line({ subtype: 'Go Back', date: '2026-07-23', line: 2 }),
  ], rows);
  assert.ok(out[1].flags.includes('repeat_visit'));
  assert.ok(!out[1].flags.includes('duplicate_charge'), 'Base then Go Back must not read as a duplicate');
});

test('the same charge type twice on one account IS a duplicate', () => {
  const out = B.reconcile([
    line({ subtype: 'Base', date: '2026-07-13', line: 1 }),
    line({ subtype: 'Base', date: '2026-07-20', line: 2 }),
  ], [survey()]);
  assert.ok(out[1].flags.includes('duplicate_charge'));
  assert.equal(out[1].priorLines.length, 1);
  assert.equal(out[1].priorLines[0].date, '2026-07-13');
});

test('the same charge on the same date across two statements is not flagged', () => {
  // Statement periods overlap, so a charge is routinely re-reported. Doug's
  // call 2026-08-26: that is not a double bill and must not read as one. The
  // import stores one copy of it (dedupeHistory), so an identical pair should
  // not reach reconcile at all — this pins the rule for the case where it does.
  const out = B.reconcile([
    line({ subtype: 'Base', date: '2026-07-13', statement: 'radicl/july', line: 1 }),
    line({ subtype: 'Base', date: '2026-07-13', statement: 'radicl/august', line: 1 }),
  ], [survey()]);
  assert.ok(!out[1].flags.includes('cross_statement'));
});

test('the same charge on two statements under different dates is flagged', () => {
  // Neither statement shows the other, so this is the shape a double bill
  // takes. A genuine second visit looks the same, which is why the earlier
  // line travels with it as priorLines.
  const out = B.reconcile([
    line({ subtype: 'Base', date: '2026-07-13', statement: 'radicl/july', line: 1 }),
    line({ subtype: 'Base', date: '2026-07-20', statement: 'radicl/august', line: 1 }),
  ], [survey()]);
  assert.ok(out[1].flags.includes('cross_statement'));
  assert.equal(out[1].priorLines[0].statement, 'radicl/july');
});

test('two dates within ONE statement are a duplicate, never a cross-statement one', () => {
  const out = B.reconcile([
    line({ subtype: 'Base', date: '2026-07-13', statement: 'radicl/july', line: 1 }),
    line({ subtype: 'Base', date: '2026-07-20', statement: 'radicl/july', line: 2 }),
  ], [survey()]);
  assert.ok(out[1].flags.includes('duplicate_charge'));
  assert.ok(!out[1].flags.includes('cross_statement'));
});

test('billed work with no Salesforce row is flagged', () => {
  const out = B.reconcile([line({ name: 'Nobody Here', address: '404 Ghost Rd, Nowhere' })], [survey()]);
  assert.ok(out[0].flags.includes('no_sf_match'));
  assert.equal(out[0].match, null);
});

test('cleanup is reported as cost, not as an error', () => {
  const out = B.reconcile([line({ subtype: 'Partial Survey' })], [survey({ resource: 'Sales Rep' })]);
  assert.ok(out[0].flags.includes('cleanup_of_other'));
  assert.equal(out[0].cleanupOrigin, 'Sales Rep');
  assert.equal(B.exceptionMeta('cleanup_of_other').sev, B.SEVERITY.INFO);
  assert.equal(B.isDispute('cleanup_of_other'), false);
  assert.equal(B.isDispute('own_defect_rebill'), true);
});

test('summarize reports positive money and splits cleanup from rework', () => {
  const s = B.summarize(B.reconcile([
    line({ subtype: 'Base', line: 1 }),
    line({ subtype: 'Partial Survey', line: 2, name: 'A B', address: '2 Elm St, Springfield' }),
    line({ subtype: 'Go Back', line: 3, name: 'C D', address: '3 Elm St, Springfield' }),
    line({ subtype: 'Travel', units: -9, line: 4 }),
  ], [survey()]));
  assert.equal(s.surveys, 3);
  assert.ok(s.usd > 0, 'money is reported positive even though the statement stores charges negative');
  assert.equal(s.cleanupN, 1);
  assert.equal(s.reworkN, 1);
  assert.equal(s.travelUsd, 180);
  assert.ok(Math.abs(s.travelRate - 1 / 3) < 1e-9);
});

test('byAccount totals every line one account drew', () => {
  const acc = B.byAccount(B.reconcile([
    line({ subtype: 'Base', line: 1 }),
    line({ subtype: 'Travel', units: -9, line: 2 }),
    line({ subtype: 'Go Back', line: 3 }),
    line({ subtype: 'Travel', units: -9, line: 4 }),
  ], [survey()]));
  assert.equal(acc.length, 1);
  assert.equal(acc[0].visits, 2);
  assert.equal(acc[0].usd, B.usd(14.2 * 2 + 18));
});

test('byFlag lists every rule, including the ones that did not fire', () => {
  const f = B.byFlag(B.reconcile([line()], [survey()]));
  assert.equal(f.length, B.EXCEPTIONS.length);
  assert.ok(f.every(x => typeof x.n === 'number' && typeof x.why === 'string'));
});

test('a second vendor needs a spec, not a second code path', () => {
  // Doug, 2026-08-25: build it so another subcontractor is easy to add. The
  // guard is that nothing outside VENDORS hardcodes Radicl's numbers.
  const src = require('node:fs').readFileSync(new URL('../lib/billing.cjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('const vendor ='));
  assert.ok(!/Radicl/.test(body.replace(/\/\/.*$/gm, '')),
    'rules below the vendor registry must not name a vendor');
  assert.ok(!/\b14\.2\b|\bunitUsd\s*[:=]\s*20\b/.test(body), 'no vendor price may be hardcoded in the rules');
});
