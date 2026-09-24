// lib/parse-sf-core.cjs — Shared Salesforce row extraction.
//
// Used by parse-sf.js (manual .xls report export) and, when the JWT/Analytics
// API path is wired up, a fetch-based equivalent — see api/refresh-sf.js and
// lib/sf-report.cjs. Both sides only need to produce a plain 2D array of
// string cells (a header row containing FIELDS' sfCol labels, plus data rows)
// and hand it to parseRows(); everything downstream — field extraction, cycle
// math, anchor overrides, the import sanity report — runs identically either
// way, so the two ingestion paths can never drift into producing different
// data.json shapes.
'use strict';
const OpsMetrics = require('./metrics.cjs');

// Must mirror the FIELDS registry in index.html
const FIELDS = [
  { key:'project_status',       sfCol:'Project Status',                                          type:'text' },
  { key:'opp_stage',            sfCol:'Project Event : Opportunity : Stage',                     type:'text' },
  { key:'contact',              sfCol:'Primary Contact',                                         type:'text' },
  { key:'contact_phone',        sfCol:'TaskRay Project : Primary Contact : Phone',               type:'text' },
  { key:'contact_email',        sfCol:'TaskRay Project : Primary Contact : Email',               type:'text' },
  { key:'project',              sfCol:'Project Name',                                            type:'text' },
  { key:'address',              sfCol:'Installation Address',                                    type:'text' },
  { key:'region',               sfCol:'Sales Region',                                            type:'text' },
  { key:'sales_office',        sfCol:'Sales Office Name',                                       type:'text' },
  { key:'type',                 sfCol:'Project Installation Type',                               type:'text' },
  { key:'sales_rep',            sfCol:'Sales Rep Name',                                          type:'text' },
  { key:'sales_rep_phone',      sfCol:'Project Event : Opportunity : Sales Rep Mobile Number',   type:'text' },
  { key:'sales_rep_email',      sfCol:'Project Event : Opportunity : Sales Rep Email',           type:'text' },
  { key:'agreement_signed',    sfCol:'Agreement Signed',                                        type:'date' },
  { key:'start',                sfCol:'Project Start Date',                                      type:'date' },
  { key:'opened',               sfCol:'Open date',                                               type:'date' },
  { key:'requested',            sfCol:'Site Survey Requested',                                   type:'date' },
  { key:'scheduled',            sfCol:'Site Survey Scheduled',                                   type:'date' },
  { key:'complete',             sfCol:'Site Survey Complete',                                    type:'date' },
  { key:'resource',             sfCol:'Site Survey Resource',                                    type:'text' },
  { key:'survey_type',         sfCol:'Site Survey Type',                                         type:'text' },
  { key:'reviewed_by',          sfCol:'Reviewed By',                                             type:'text' },
  { key:'last_reviewed_date',   sfCol:'Last Reviewed',                                           type:'text' },
  { key:'last_reviewed_subject',sfCol:'Last Reviewed Subject',                                   type:'text' },
  { key:'holding_reason',       sfCol:'Holding Reason',                                         type:'text' },
  { key:'last_comment',         sfCol:'Last Reviewed Comments',                                  type:'text' },
  { key:'list',                 sfCol:'List',                                                    type:'text' },
  { key:'task_id',             sfCol:'TaskRay Task ID',                                          type:'text' },
  { key:'owner',               sfCol:'Owner: Full Name',                                         type:'text' },
  { key:'reopened_by_design',  sfCol:'Reopened by Design',                                       type:'text' },
  { key:'resurvey_reason',     sfCol:'Resurvey Reason',                                          type:'text' },
  { key:'resurvey_attributed', sfCol:'Resurvey Attributed To',                                   type:'text' },
  { key:'resurvey_requested',  sfCol:'Resurvey Requested Date',                                  type:'date' },
  { key:'resurvey_scheduled',  sfCol:'Resurvey Scheduled',                                       type:'date' },
  { key:'resurvey_complete',   sfCol:'Resurvey Complete Date',                                   type:'date' },
  { key:'resurvey_details',    sfCol:'Resurvey Request Details',                                 type:'text' },
  { key:'field_survey_scheduled', sfCol:'Field Site Survey Scheduled',                           type:'date' },
  { key:'field_survey_complete',  sfCol:'Field Site Survey Complete',                            type:'date' },
  { key:'m1a_approved',        sfCol:'M1A Approved',                                            type:'date' },
  { key:'gross_price',         sfCol:'Opportunity: Gross Price',                                type:'number' },
  { key:'dealer_fee',          sfCol:'Project Event : Opportunity : Dealer Fee Amount',         type:'number' },
];

// "2/4/2026, 3:30 PM" or "2/4/2026" → "2026-02-04"
function cleanDate(s) {
  if (!s) return '';
  const datePart = String(s).split(',')[0].trim();
  const m = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return '';
  const yr = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${yr}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
}

function subtractDays(dateStr, n) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m-1, d - n);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

function dDiff(a, b) {
  if (!a || !b) return null;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((new Date(by, bm-1, bd) - new Date(ay, am-1, ad)) / 86400000 * 10) / 10;
}

// The report carries HTML entities in free-text fields — sales offices come
// through as "Solar&#39;s Dead" - Dragons — which then render literally in
// every table and dropdown that shows them.
const ENTITIES = { '&#39;': "'", '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
function decodeEntities(t) {
  return t.replace(/&#39;|&quot;|&amp;|&lt;|&gt;|&nbsp;|&#(\d+);/g,
    (m, num) => num ? String.fromCharCode(+num) : ENTITIES[m]);
}

function normalizeCell(val) {
  // Excel exports booleans as TRUE/FALSE strings; normalize to 1/0
  if (val === true  || val === 'TRUE'  || val === 'True')  return '1';
  if (val === false || val === 'FALSE' || val === 'False') return '0';
  return decodeEntities(String(val || '').replace(/\s+/g, ' ').trim());
}

// allData: array of arrays of raw cell values (any type — the header row and
// every data row). overrides: parsed overrides.json's `.rows` map. prevRows:
// the current data.json's rows (for the swing/drift/reactivation checks), or
// null if there isn't one to compare against yet.
function parseRows(allData, { overrides = {}, prevRows = null } = {}) {
  const FIELD_COLS = new Set(FIELDS.map(f => f.sfCol));
  const headerRowIdx = allData.findIndex(row =>
    row.filter(cell => FIELD_COLS.has(String(cell).trim())).length >= 3
  );
  if (headerRowIdx === -1) throw new Error('No header row found — none of the FIELDS column labels matched.');

  const headers = allData[headerRowIdx].map(h => String(h).trim());
  const colIdx = {};
  FIELDS.forEach(f => { const i = headers.indexOf(f.sfCol); if (i >= 0) colIdx[f.key] = i; });
  if (!Object.keys(colIdx).length) {
    throw new Error('No matching columns found.\nHeaders found: ' + headers.join(', '));
  }

  const rows = [];
  allData.slice(headerRowIdx + 1).forEach((row, i) => {
    const cells = row.map(normalizeCell);
    if (cells.every(c => c === '')) return; // skip blank rows
    const r = { id: i, ct_s2r: null, ct_r2s: null, ct_total: null, ct_open: null, ct_resurvey: null, ct_full: null };
    FIELDS.forEach(f => {
      if (colIdx[f.key] === undefined) { r[f.key] = f.type === 'number' ? null : ''; return; }
      const raw = cells[colIdx[f.key]] || '';
      if (f.type === 'date') r[f.key] = cleanDate(raw);
      else if (f.type === 'number') r[f.key] = raw === '' ? null : Number(raw);
      else r[f.key] = raw;
    });
    if (!r.region && !r.project && !r.address && !r.task_id) return;
    if (!r.resource && r.complete) r.resource = 'Sales Rep';
    const _ov = r.task_id && overrides[r.task_id];
    if (_ov && _ov.start) { r.start = _ov.start; r.opened = _ov.start; }
    r.ct_s2r      = dDiff(r.start, r.requested);
    r.ct_r2s      = dDiff(r.requested, r.scheduled);
    r.ct_total    = dDiff(r.start, OpsMetrics.effectiveComplete(r));
    if (r.ct_total === null && !r.requested && r.field_survey_complete)
      r.ct_total  = dDiff(r.start, subtractDays(r.field_survey_complete, 2));
    if (r.ct_total != null && r.ct_total < 0) r.ct_total = 0;
    r.ct_open = dDiff(r.opened, OpsMetrics.effectiveComplete(r));
    if (r.ct_open != null && r.ct_open < 0) r.ct_open = 0;
    r.ct_resurvey = dDiff(r.resurvey_requested, r.resurvey_complete);
    if (r.ct_resurvey != null && r.ct_resurvey < 0) r.ct_resurvey = 0;
    r.ct_full     = (r.ct_total != null && r.ct_resurvey != null) ? Math.round((r.ct_total + r.ct_resurvey) * 10) / 10 : null;
    rows.push(r);
  });

  if (!rows.length) throw new Error('No rows parsed — check that the source is a Salesforce report export.');

  // ── Import sanity report ─────────────────────────────────────────────
  const warnings = [];
  const sample = (arr, fmt, n = 3) => arr.slice(0, n).map(fmt).join('; ') + (arr.length > n ? '; …' : '');
  const label = r => r.project || r.address || r.task_id || 'row ' + r.id;

  const backwards = rows.filter(r => r.agreement_signed && r.complete && r.complete < r.agreement_signed);
  if (backwards.length) warnings.push(`${backwards.length} row(s) surveyed before the agreement was signed (re-signed account reusing an old survey?): ${sample(backwards, r => `${label(r)} (signed ${r.agreement_signed}, surveyed ${r.complete})`)}`);
  const rsBackwards = rows.filter(r => r.resurvey_requested && r.resurvey_complete && r.resurvey_complete < r.resurvey_requested);
  if (rsBackwards.length) warnings.push(`${rsBackwards.length} row(s) resurvey complete before requested: ${sample(rsBackwards, r => `${label(r)} (${r.resurvey_requested} → ${r.resurvey_complete})`)}`);

  const SF_TASK = 'https://ambia.lightning.force.com/lightning/r/TASKRAY__Project_Task__c/';
  const bareFlag = rows.filter(r => r.reopened_by_design === '1' && !r.resurvey_reason && !r.resurvey_attributed && !r.resurvey_requested && !r.resurvey_scheduled && !r.resurvey_complete && !r.resurvey_details);
  if (bareFlag.length) warnings.push(`${bareFlag.length} row(s) counted as a resurvey on the Reopened by Design flag alone — no reason, no dates, no details (untick it in SF, or set the reason): ${sample(bareFlag, r => `${label(r)}${r.task_id ? ' ' + SF_TASK + r.task_id + '/view' : ''}`)}`);

  const noRegion = rows.filter(r => !r.region);
  if (noRegion.length) warnings.push(`${noRegion.length} row(s) missing Sales Region (kept; fix in SF to restore region grouping): ${sample(noRegion, label)}`);

  const idCounts = {};
  rows.forEach(r => { if (r.task_id) idCounts[r.task_id] = (idCounts[r.task_id] || 0) + 1; });
  const dupIds = Object.entries(idCounts).filter(([, n]) => n > 1);
  if (dupIds.length) warnings.push(`${dupIds.length} duplicate project id(s): ${sample(dupIds, ([id, n]) => `${id} ×${n}`)}`);

  const openByProject = {};
  rows.forEach(r => { if (r.project && !OpsMetrics.isComplete(r)) (openByProject[r.project] = openByProject[r.project] || []).push(r); });
  const dupProjects = Object.entries(openByProject).filter(([, rs]) => rs.length > 1);
  if (dupProjects.length) warnings.push(`${dupProjects.length} project(s) with more than one open survey task (possible SF duplicate): ${sample(dupProjects, ([p, rs]) => `${p} (${rs.map(r => SF_TASK + r.task_id + '/view').join(' , ')})`)}`);

  const KNOWN_RESOURCES = new Set(['', 'Sales Rep', 'Radicl Services', 'SunPower Surveyor']);
  const badResources = [...new Set(rows.map(r => r.resource))].filter(v => !KNOWN_RESOURCES.has(v));
  if (badResources.length) warnings.push(`${badResources.length} unrecognized resource value(s): ${sample(badResources, v => `"${v}"`)}`);

  const repCasings = {};
  rows.forEach(r => { if (r.sales_rep) (repCasings[r.sales_rep.toLowerCase()] ??= new Set()).add(r.sales_rep); });
  const casingClashes = Object.values(repCasings).filter(s => s.size > 1);
  if (casingClashes.length) warnings.push(`${casingClashes.length} rep name(s) with casing variants: ${sample(casingClashes, s => [...s].join(' / '))}`);

  const today = new Date(); today.setHours(12, 0, 0, 0);
  const cutoff60 = new Date(today); cutoff60.setDate(cutoff60.getDate() - 60);
  const stale = `${cutoff60.getFullYear()}-${String(cutoff60.getMonth() + 1).padStart(2, '0')}-${String(cutoff60.getDate()).padStart(2, '0')}`;
  const staleSched = rows.filter(r => !OpsMetrics.isComplete(r) && r.scheduled && r.scheduled < stale);
  if (staleSched.length) warnings.push(`${staleSched.length} open row(s) with scheduled dates >60 days past: ${sample(staleSched, r => `${label(r)} (${r.scheduled})`)}`);

  const noOpen = rows.filter(r => !r.opened);
  if (noOpen.length) warnings.push(`${noOpen.length} row(s) with no Open date — these carry no cycle time while the anchor is set to Open date: ${sample(noOpen, r => label(r))}`);

  const openedLate = rows.filter(r => r.opened && r.complete && r.complete < r.opened);
  if (openedLate.length) warnings.push(`${openedLate.length} row(s) whose task opened AFTER the survey completed (retroactive task record): ${sample(openedLate, r => `${label(r)} (opened ${r.opened}, surveyed ${r.complete})`)}`);

  if (Array.isArray(prevRows) && prevRows.length) {
    const swing = (rows.length - prevRows.length) / prevRows.length;
    if (Math.abs(swing) > 0.2) warnings.push(`row count swung ${(swing * 100).toFixed(0)}% vs current data.json (${prevRows.length.toLocaleString()} → ${rows.length.toLocaleString()}) — check the report filters`);

    const was = new Map(prevRows.filter(r => r.task_id).map(r => [r.task_id, r.opened]));
    const drifted = rows.filter(r => r.task_id && !overrides[r.task_id] && was.get(r.task_id) && r.opened && was.get(r.task_id) !== r.opened);
    if (drifted.length) warnings.push(`${drifted.length} row(s) Open date MOVED since the last export — it is not a stable anchor, check the Settings toggle: ${sample(drifted, r => `${label(r)} (${was.get(r.task_id)} → ${r.opened})`)}`);

    const wasStatus = new Map(prevRows.filter(r => r.task_id).map(r => [r.task_id, r.project_status]));
    const reactivated = rows.filter(r =>
      r.task_id && !overrides[r.task_id] && r.complete &&
      wasStatus.get(r.task_id) === 'Canceled' && r.project_status !== 'Canceled' &&
      r.ct_total != null && r.ct_total > 21);
    if (reactivated.length) warnings.push(`${reactivated.length} row(s) reactivated after cancellation with a >21d cycle — the original start counts the cancelled gap. Add an anchor override if the survey was quick: ${sample(reactivated, r => `${label(r)} (${r.ct_total}d, ${SF_TASK}${r.task_id}/view)`)}`);
  }

  // Informational, not counted in the warnings total below (parity with the
  // original single-file parser: "override: ..." lines print on their own).
  const overrideLog = [];
  const ovIds = Object.keys(overrides);
  if (ovIds.length) {
    const byTask = new Map(rows.filter(r => r.task_id).map(r => [r.task_id, r]));
    ovIds.forEach(tid => {
      const ov = overrides[tid], r = byTask.get(tid);
      if (!r) { warnings.push(`anchor override for ${ov.project || tid} points at a task no longer in the export — remove it from overrides.json`); return; }
      if (ov.project && r.project && ov.project !== r.project) warnings.push(`anchor override ${tid} is labelled "${ov.project}" but that task is now "${r.project}" — check overrides.json`);
      overrideLog.push(`override: ${r.project || tid} start → ${ov.start} (${r.ct_total != null ? r.ct_total + 'd cycle' : 'no completion'})`);
    });
  }

  return { rows, warnings, overrideLog };
}

module.exports = { FIELDS, parseRows, cleanDate, decodeEntities, normalizeCell };
