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

// ── Cost by project outcome ────────────────────────────────────────────────
// Added 2026-08-26, when the SF export started carrying canceled projects. The
// cut is only meaningful because of that: before it, one canceled row was in
// scope and every dollar looked like it had been spent on a live deal.
test('byOutcome cuts spend by the matched survey project status', () => {
  const rows = [
    survey({ contact: 'Jane Smith',  address: '123 Main St Springfield, IL 62704', project_status: 'In Progress' }),
    survey({ contact: 'Bob Jones',   address: '9 Oak Ave Dayton, OH 45402',        project_status: 'Canceled' }),
    survey({ contact: 'Amy Fisher',  address: '77 Elm Rd Akron, OH 44301',         project_status: 'Canceled' }),
  ];
  const lines = [
    line({ name: 'Jane Smith', address: '123 Main St, Springfield' }),
    line({ name: 'Bob Jones',  address: '9 Oak Ave, Dayton',  line: 2 }),
    line({ name: 'Amy Fisher', address: '77 Elm Rd, Akron',   line: 3 }),
    line({ name: 'Amy Fisher', address: '77 Elm Rd, Akron',   subtype: 'Travel', units: -9, line: 4 }),
  ];
  const out = B.byOutcome(B.reconcile(lines, rows));
  const by = Object.fromEntries(out.map(o => [o.status, o]));

  assert.equal(by.Canceled.visits, 2, 'two survey visits on canceled projects');
  assert.equal(by.Canceled.n, 3, 'travel adders count as spend on that outcome too');
  assert.equal(by.Canceled.accounts, 2);
  assert.equal(by.Canceled.usd, 284 + 284 + 180);
  assert.equal(by.Canceled.dead, true);
  assert.equal(by['In Progress'].dead, false, 'only a settled outcome is dead');

  // Doug, 2026-08-26: At-Risk is a project on its way somewhere, not a loss.
  // Folding it in would report a number that moves as those projects resolve.
  const atRisk = B.byOutcome(B.reconcile([line()], [survey({ project_status: 'At-Risk' })]));
  assert.equal(atRisk[0].dead, false);
});

test('byOutcome reconciles with summarize and its shares sum to one', () => {
  const rows = [
    survey({ contact: 'Jane Smith', address: '123 Main St Springfield, IL 62704', project_status: 'In Progress' }),
    survey({ contact: 'Bob Jones',  address: '9 Oak Ave Dayton, OH 45402',        project_status: 'Canceled' }),
  ];
  // A line that matches nothing must not be dropped, or the parts stop adding
  // up to the invoiced total — it is the same population no_sf_match counts.
  const lines = [
    line({ name: 'Jane Smith', address: '123 Main St, Springfield' }),
    line({ name: 'Bob Jones',  address: '9 Oak Ave, Dayton', line: 2 }),
    line({ name: 'Nobody Here', address: '1 Nowhere Ln, Atlantis', line: 3 }),
    line({ type: 'Credits Added', subtype: '', units: 1000, line: 4 }),   // top-up, never a charge
  ];
  const rec = B.reconcile(lines, rows);
  const out = B.byOutcome(rec);

  // summarize() converts units to dollars once over the whole set; the cut
  // converts per group, so the two differ in the last float bit, not in money.
  assert.ok(Math.abs(out.reduce((s, o) => s + o.usd, 0) - B.summarize(rec).usd) < 1e-6,
    'the outcome cut must add up to the invoiced total');
  assert.ok(Math.abs(out.reduce((s, o) => s + o.share, 0) - 1) < 1e-9);
  assert.ok(out.some(o => o.status === B.OUTCOME_UNMATCHED && o.matched === false),
    'unmatched lines get their own bucket rather than being dropped');
  assert.ok(!out.some(o => o.n === 0), 'an outcome with no lines is never emitted');
});

test('byOutcome never reads the opportunity stage', () => {
  // Stage disagrees with project_status on 4 rows in 3,791 and on 2 billed
  // lines out of 624, so cutting by it would draw the same picture from a
  // field with no history behind it.
  const src = require('node:fs').readFileSync(new URL('../lib/billing.cjs', import.meta.url), 'utf8')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!/opp_stage/.test(src), 'billing must cut by project_status, not opp_stage');
  assert.ok(/project_status/.test(src), 'and it must actually read project_status');
});

// ── Service lines ─────────────────────────────────────────────────────────
// A vendor can bill more than one book of business. Averaging O&M visits into
// a per-survey figure overstates what a survey costs, which is the whole
// reason the Billing page opens on the survey segment.
test('service lines come from the vendor spec, and top-ups are not one', () => {
  assert.equal(B.lineService(line({ type: 'Survey' })), 'survey');
  assert.equal(B.lineService(line({ type: 'O&M', subtype: 'Quality Check' })), 'om');
  assert.equal(B.lineService(line({ type: 'Credits Added', units: 1000 })), 'topup');
  // An unrecognised service becomes its own segment rather than being absorbed
  // into the survey book, where it would quietly move the per-survey cost.
  assert.equal(B.lineService(line({ type: 'Rooftop Cleaning' })), 'other');
  assert.equal(B.isSurveyService(line({ type: 'O&M' })), false);
});

// ── External EPC accounts ─────────────────────────────────────────────────
// Projects sold through an external EPC never reach the Site Survey export, so
// without the registry every line we were billed for one reads as a missing
// Salesforce record.
const epc = (o = {}) => ({ contact: 'Ada Vance', address: '77 Elm Ave', project: '77ELVANC',
  project_status: 'Canceled', ...o });

test('Salesforce always wins: the EPC registry is only tried where SF has nothing', () => {
  // Same account present on both sides. The SF row carries the resource and the
  // dates; the EPC row carries neither, so matching the EPC one would lose
  // information the page needs.
  const l = line({ name: 'Jane Smith', address: '123 Main St, Springfield' });
  const out = B.reconcile([l], [survey()], [epc({ contact: 'Jane Smith', address: '123 Main St' })]);
  assert.equal(out[0].matchSource, 'sf');
  assert.ok(!out[0].epc);
  assert.ok(!out[0].flags.includes('epc_account'));
});

test('the EPC chip covers every line the account drew, not just the visit', () => {
  // Work-only, the chip reported $9,203 against the $11,077 the outcome lens
  // showed for the same population. no_sf_match beside it stays work-only on
  // purpose: that rule asks whether a survey exists, which only a visit can
  // answer, where this one says whose project the account is.
  const out = B.reconcile([
    line({ name: 'Ada Vance', address: '77 Elm Ave, Rivertown', subtype: 'Base', line: 1 }),
    line({ name: 'Ada Vance', address: '77 Elm Ave, Rivertown', subtype: 'Travel', units: -9, line: 2 }),
    line({ name: 'Ada Vance', address: '77 Elm Ave, Rivertown', subtype: 'Demob', units: -4.45, line: 3 }),
  ], [survey()], [epc()]);
  assert.deepEqual(out.map(l => l.flags.includes('epc_account')), [true, true, true]);
  // and the chip's total is the group's total
  const flagged = out.filter(l => l.flags.includes('epc_account'));
  const groups = B.byOutcome(out);
  const g = groups.find(x => x.status === B.OUTCOME_EPC);
  assert.equal(flagged.length, g.n, 'chip and outcome group must count the same lines');
});

test('an EPC-matched line is matched, so it stops reading as a missing record', () => {
  const l = line({ name: 'Ada Vance', address: '77 Elm Ave, Rivertown' });
  const out = B.reconcile([l], [survey()], [epc()]);
  assert.equal(out[0].matchSource, 'epc');
  assert.equal(out[0].epc, true);
  assert.ok(out[0].flags.includes('epc_account'));
  assert.ok(!out[0].flags.includes('no_sf_match'), 'it has a project, just not a SunPower one');
});

test('with no registry, an EPC line still reads exactly as it did before', () => {
  const l = line({ name: 'Ada Vance', address: '77 Elm Ave, Rivertown' });
  for (const reg of [undefined, []]) {
    const out = B.reconcile([l], [survey()], reg);
    assert.ok(out[0].flags.includes('no_sf_match'));
    assert.ok(!out[0].epc);
  }
});

test('EPC spend is its own outcome group, not folded into the SunPower statuses', () => {
  // Both are Canceled. Mixing them would make "N% of spend went to canceled
  // projects" a statement about neither population.
  const out = B.reconcile([
    line({ name: 'Jane Smith', address: '123 Main St, Springfield', line: 1 }),
    line({ name: 'Ada Vance', address: '77 Elm Ave, Rivertown', line: 2 }),
  ], [survey({ project_status: 'Canceled' })], [epc()]);
  const groups = B.byOutcome(out);
  const names = groups.map(g => g.status);
  assert.ok(names.includes(B.OUTCOME_EPC));
  assert.ok(names.includes('Canceled'));
  const e = groups.find(g => g.status === B.OUTCOME_EPC);
  assert.equal(e.epc, true);
  assert.equal(e.dead, false, 'an EPC group is not a SunPower loss, whatever its own status says');
});

// ── Projects older than the dashboard's window ────────────────────────────
// A vendor bills in the month it surveys, not the month the project started,
// so a January statement carries work on projects sold the previous summer.
const old = (o = {}) => ({ task_id: 'a03OLD', contact: 'Otto Prewitt', address: '9 Kiln Rd',
  project: '9KIPREW', project_status: 'Complete', start: '2025-06-01', ...o });

test('the live export always wins over the archive', () => {
  // The archive row has no resurvey history and no resource; a line that can
  // match the live export must, or the page loses what it matched for.
  const l = line({ name: 'Jane Smith', address: '123 Main St, Springfield' });
  const out = B.reconcile([l], [survey()], [], [old({ contact: 'Jane Smith', address: '123 Main St' })]);
  assert.equal(out[0].matchSource, 'sf');
  assert.ok(!out[0].archived);
});

test('the archive is tried before the EPC registry', () => {
  // Both could match. An archived project is ours and carries a real status,
  // so it groups by outcome normally; an EPC one cannot.
  const l = line({ name: 'Otto Prewitt', address: '9 Kiln Rd, Millbrook' });
  const out = B.reconcile([l], [survey()], [epc({ contact: 'Otto Prewitt', address: '9 Kiln Rd' })], [old()]);
  assert.equal(out[0].matchSource, 'archive');
  assert.ok(!out[0].epc);
  assert.ok(out[0].flags.includes('archived_project'));
  assert.ok(!out[0].flags.includes('no_sf_match'));
});

test('an archived match groups by its own project status, not a bucket of its own', () => {
  const out = B.reconcile([line({ name: 'Otto Prewitt', address: '9 Kiln Rd, Millbrook' })],
    [survey()], [], [old({ project_status: 'Complete' })]);
  const g = B.byOutcome(out);
  assert.ok(g.some(x => x.status === 'Complete'));
  assert.ok(!g.some(x => x.status === B.OUTCOME_EPC));
});

test('both registries are optional and absent ones change nothing', () => {
  const l = line({ name: 'Otto Prewitt', address: '9 Kiln Rd, Millbrook' });
  for (const args of [[[l], [survey()]], [[l], [survey()], []], [[l], [survey()], [], []]]) {
    const out = B.reconcile(...args);
    assert.ok(out[0].flags.includes('no_sf_match'));
    assert.ok(!out[0].archived);
  }
});
