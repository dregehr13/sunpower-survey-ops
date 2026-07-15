#!/usr/bin/env node
// parse-sf.js — Parse Salesforce XLS/XLSX export → RAW data array
// Usage: node parse-sf.js <path-to-report.xls>
// Outputs: JSON array to stdout

import XLSX from 'xlsx';
import { readFileSync } from 'fs';
import OpsMetrics from './lib/metrics.cjs';

const file = process.argv[2];
if (!file) { console.error('Usage: node parse-sf.js <report.xls>'); process.exit(1); }

// Must mirror the FIELDS registry in index.html
const FIELDS = [
  { key:'project_status',       sfCol:'Project Status',                                          type:'text' },
  { key:'contact',              sfCol:'Primary Contact',                                         type:'text' },
  { key:'contact_phone',        sfCol:'TaskRay Project : Primary Contact : Phone',               type:'text' },
  { key:'contact_email',        sfCol:'TaskRay Project : Primary Contact : Email',               type:'text' },
  { key:'project',              sfCol:'Project Name',                                            type:'text' },
  { key:'address',              sfCol:'Installation Address',                                    type:'text' },
  { key:'region',               sfCol:'Sales Region',                                            type:'text' },
  { key:'type',                 sfCol:'Project Installation Type',                               type:'text' },
  { key:'sales_rep',            sfCol:'Sales Rep Name',                                          type:'text' },
  { key:'sales_rep_phone',      sfCol:'Project Event : Opportunity : Sales Rep Mobile Number',   type:'text' },
  { key:'sales_rep_email',      sfCol:'Project Event : Opportunity : Sales Rep Email',           type:'text' },
  { key:'start',                sfCol:'Project Start Date',                                      type:'date' },
  { key:'requested',            sfCol:'Site Survey Requested',                                   type:'date' },
  { key:'scheduled',            sfCol:'Site Survey Scheduled',                                   type:'date' },
  { key:'complete',             sfCol:'Site Survey Complete',                                    type:'date' },
  { key:'resource',             sfCol:'Site Survey Resource',                                    type:'text' },
  { key:'survey_type',         sfCol:'Site Survey Type',                                         type:'text' },
  { key:'reviewed_by',          sfCol:'Reviewed By',                                             type:'text' },
  { key:'last_reviewed_date',   sfCol:'Last Reviewed',                                           type:'text' },
  { key:'last_reviewed_subject',sfCol:'Last Reviewed Subject',                                   type:'text' },
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
];

const workbook = XLSX.readFile(file);
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const allData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

// Find the header row — first row with 3+ matching SF column names
const FIELD_COLS = new Set(FIELDS.map(f => f.sfCol));
const headerRowIdx = allData.findIndex(row =>
  row.filter(cell => FIELD_COLS.has(String(cell).trim())).length >= 3
);
if (headerRowIdx === -1) { console.error('ERROR: No header row found in file.'); process.exit(1); }

const headers = allData[headerRowIdx].map(h => String(h).trim());

const colIdx = {};
FIELDS.forEach(f => { const i = headers.indexOf(f.sfCol); if (i >= 0) colIdx[f.key] = i; });
if (!Object.keys(colIdx).length) {
  console.error('ERROR: No matching columns found.\nHeaders found: ' + headers.join(', '));
  process.exit(1);
}

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

function normalizeCell(val) {
  // Excel exports booleans as TRUE/FALSE strings; normalize to 1/0
  if (val === true  || val === 'TRUE'  || val === 'True')  return '1';
  if (val === false || val === 'FALSE' || val === 'False') return '0';
  return String(val || '').replace(/\s+/g, ' ').trim();
}

const rows = [];
allData.slice(headerRowIdx + 1).forEach((row, i) => {
  const cells = row.map(normalizeCell);
  if (cells.every(c => c === '')) return; // skip blank rows
  const r = { id: i, ct_s2r: null, ct_r2s: null, ct_total: null, ct_resurvey: null, ct_full: null };
  FIELDS.forEach(f => {
    r[f.key] = colIdx[f.key] !== undefined
      ? (f.type === 'date' ? cleanDate(cells[colIdx[f.key]] || '') : (cells[colIdx[f.key]] || ''))
      : '';
  });
  // Keep real records even when Salesforce's Sales Region field is blank
  // (happens in newer markets not yet mapped to a region). Only skip rows
  // with no identifying info at all — i.e. report artifacts, not surveys.
  if (!r.region && !r.project && !r.address && !r.task_id) return;
  if (!r.resource && r.complete) r.resource = 'Sales Rep';
  r.ct_s2r      = dDiff(r.start, r.requested);
  r.ct_r2s      = dDiff(r.requested, r.scheduled);
  r.ct_total    = dDiff(r.start, r.complete);
  if (r.ct_total === null && !r.requested && r.field_survey_complete)
    r.ct_total  = dDiff(r.start, subtractDays(r.field_survey_complete, 2));
  if (r.ct_total != null && r.ct_total < 0) r.ct_total = 0;
  r.ct_resurvey = dDiff(r.resurvey_requested, r.resurvey_complete);
  if (r.ct_resurvey != null && r.ct_resurvey < 0) r.ct_resurvey = 0;
  r.ct_full     = (r.ct_total != null && r.ct_resurvey != null) ? Math.round((r.ct_total + r.ct_resurvey) * 10) / 10 : null;
  rows.push(r);
});

if (!rows.length) { console.error('ERROR: No rows parsed — check that the file is a Salesforce report export.'); process.exit(1); }

// ── Import sanity report ─────────────────────────────────────────────
// Non-blocking: warnings go to stderr (stdout carries the JSON) and never
// fail the push. Each check emits at most one line.
const warnings = [];
const sample = (arr, fmt, n = 3) => arr.slice(0, n).map(fmt).join('; ') + (arr.length > n ? '; …' : '');
const label = r => r.project || r.address || r.task_id || 'row ' + r.id;

// Complete before start / negative resurvey cycle (raw dates — ct_total is clamped to 0 later)
const backwards = rows.filter(r => r.start && r.complete && r.complete < r.start);
if (backwards.length) warnings.push(`${backwards.length} row(s) complete before start: ${sample(backwards, r => `${label(r)} (${r.start} → ${r.complete})`)}`);
const rsBackwards = rows.filter(r => r.resurvey_requested && r.resurvey_complete && r.resurvey_complete < r.resurvey_requested);
if (rsBackwards.length) warnings.push(`${rsBackwards.length} row(s) resurvey complete before requested: ${sample(rsBackwards, r => `${label(r)} (${r.resurvey_requested} → ${r.resurvey_complete})`)}`);

// Real records missing a Sales Region (kept, but region-based groupings skip them)
const noRegion = rows.filter(r => !r.region);
if (noRegion.length) warnings.push(`${noRegion.length} row(s) missing Sales Region (kept; fix in SF to restore region grouping): ${sample(noRegion, label)}`);

// Duplicate project ids (TaskRay Task ID)
const idCounts = {};
rows.forEach(r => { if (r.task_id) idCounts[r.task_id] = (idCounts[r.task_id] || 0) + 1; });
const dupIds = Object.entries(idCounts).filter(([, n]) => n > 1);
if (dupIds.length) warnings.push(`${dupIds.length} duplicate project id(s): ${sample(dupIds, ([id, n]) => `${id} ×${n}`)}`);

// Unrecognized resource values
const KNOWN_RESOURCES = new Set(['', 'Sales Rep', 'Radicl Services', 'SunPower Surveyor']);
const badResources = [...new Set(rows.map(r => r.resource))].filter(v => !KNOWN_RESOURCES.has(v));
if (badResources.length) warnings.push(`${badResources.length} unrecognized resource value(s): ${sample(badResources, v => `"${v}"`)}`);

// Rep names that differ only by casing (split one rep's stats until normalized)
const repCasings = {};
rows.forEach(r => { if (r.sales_rep) (repCasings[r.sales_rep.toLowerCase()] ??= new Set()).add(r.sales_rep); });
const casingClashes = Object.values(repCasings).filter(s => s.size > 1);
if (casingClashes.length) warnings.push(`${casingClashes.length} rep name(s) with casing variants: ${sample(casingClashes, s => [...s].join(' / '))}`);

// Open rows with scheduled dates far in the past (likely stale in SF)
const today = new Date(); today.setHours(12, 0, 0, 0);
const cutoff60 = new Date(today); cutoff60.setDate(cutoff60.getDate() - 60);
const stale = `${cutoff60.getFullYear()}-${String(cutoff60.getMonth() + 1).padStart(2, '0')}-${String(cutoff60.getDate()).padStart(2, '0')}`;
const staleSched = rows.filter(r => !OpsMetrics.isComplete(r) && r.scheduled && r.scheduled < stale);
if (staleSched.length) warnings.push(`${staleSched.length} open row(s) with scheduled dates >60 days past: ${sample(staleSched, r => `${label(r)} (${r.scheduled})`)}`);

// Row-count swing vs the current data.json
try {
  const prev = JSON.parse(readFileSync(new URL('./data.json', import.meta.url), 'utf8'));
  if (Array.isArray(prev) && prev.length) {
    const swing = (rows.length - prev.length) / prev.length;
    if (Math.abs(swing) > 0.2) warnings.push(`row count swung ${(swing * 100).toFixed(0)}% vs current data.json (${prev.length.toLocaleString()} → ${rows.length.toLocaleString()}) — check the report filters`);
  }
} catch { /* no existing data.json — first import, nothing to compare */ }

warnings.forEach(w => console.error('WARN: ' + w));
console.error(`${rows.length.toLocaleString()} rows, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);

process.stdout.write(JSON.stringify(rows));
