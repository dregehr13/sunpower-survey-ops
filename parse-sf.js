#!/usr/bin/env node
// parse-sf.js — Parse Salesforce XLS/XLSX export → RAW data array
// Usage: node parse-sf.js <path-to-report.xls>
// Outputs: JSON array to stdout

import XLSX from 'xlsx';

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
  const m = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
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
  if (!r.region) return;
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

process.stdout.write(JSON.stringify(rows));
