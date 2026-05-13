#!/usr/bin/env node
// parse-sf.js — Parse Salesforce XLS export → RAW data array
// Usage: node parse-sf.js <path-to-report.xls>
// Outputs: JSON array to stdout

import { readFileSync } from 'fs';

const file = process.argv[2];
if (!file) { console.error('Usage: node parse-sf.js <report.xls>'); process.exit(1); }

const content = readFileSync(file, 'latin1');

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
  { key:'reviewed_by',          sfCol:'Reviewed By',                                             type:'text' },
  { key:'last_reviewed_date',   sfCol:'Last Reviewed',                                           type:'text' },
  { key:'last_reviewed_subject',sfCol:'Last Reviewed Subject',                                   type:'text' },
  { key:'last_comment',         sfCol:'Last Reviewed Comments',                                  type:'text' },
  { key:'list',                 sfCol:'List',                                                    type:'text' },
];

// Parse headers
const headerRowMatch = content.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i);
if (!headerRowMatch) { console.error('ERROR: No header row found in file.'); process.exit(1); }
const headers = [...headerRowMatch[1].matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/gi)].map(m => m[1].trim());

const colIdx = {};
FIELDS.forEach(f => { const i = headers.indexOf(f.sfCol); if (i >= 0) colIdx[f.key] = i; });
if (!Object.keys(colIdx).length) {
  console.error('ERROR: No matching columns found.\nHeaders found: ' + headers.join(', '));
  process.exit(1);
}

// "2/4/2026, 3:30 PM" or "2/4/2026" → "2026-02-04"
function cleanDate(s) {
  if (!s) return '';
  const datePart = s.split(',')[0].trim();
  const m = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
}

function dDiff(a, b) {
  if (!a || !b) return null;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((new Date(by, bm-1, bd) - new Date(ay, am-1, ad)) / 86400000 * 10) / 10;
}

const allRows = [...content.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
const rows = [];

allRows.slice(1).forEach((rowHtml, i) => {
  const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1].replace(/\s+/g,' ').trim());
  if (!cells.length) return;
  const r = { id: i, ct_s2r: null, ct_r2s: null, ct_total: null };
  FIELDS.forEach(f => {
    r[f.key] = colIdx[f.key] !== undefined
      ? (f.type === 'date' ? cleanDate(cells[colIdx[f.key]] || '') : (cells[colIdx[f.key]] || ''))
      : '';
  });
  if (!r.region) return;
  if (!r.resource && r.complete) r.resource = 'Sales Rep';
  r.ct_s2r   = dDiff(r.start, r.requested);
  r.ct_r2s   = dDiff(r.requested, r.scheduled);
  r.ct_total = dDiff(r.start, r.complete);
  rows.push(r);
});

if (!rows.length) { console.error('ERROR: No rows parsed — check that the file is a Salesforce report export.'); process.exit(1); }

process.stdout.write(JSON.stringify(rows));
