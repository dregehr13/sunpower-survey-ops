// api/upload-data.js — Accept XLS upload, parse it, write rows to Supabase.
// Called by the Queues page drop zone. Does NOT touch data.js / push.sh.

import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };

const SUPABASE_URL = 'https://hoczpteqfpjkldcptwxo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_SB0ZkiA5C04EtcUtbexobA_nHbB05a4';

const FIELDS = [
  { key:'project_status',        sfCol:'Project Status',                                          type:'text' },
  { key:'contact',               sfCol:'Primary Contact',                                         type:'text' },
  { key:'contact_phone',         sfCol:'TaskRay Project : Primary Contact : Phone',               type:'text' },
  { key:'contact_email',         sfCol:'TaskRay Project : Primary Contact : Email',               type:'text' },
  { key:'project',               sfCol:'Project Name',                                            type:'text' },
  { key:'address',               sfCol:'Installation Address',                                    type:'text' },
  { key:'region',                sfCol:'Sales Region',                                            type:'text' },
  { key:'type',                  sfCol:'Project Installation Type',                               type:'text' },
  { key:'sales_rep',             sfCol:'Sales Rep Name',                                          type:'text' },
  { key:'sales_rep_phone',       sfCol:'Project Event : Opportunity : Sales Rep Mobile Number',   type:'text' },
  { key:'sales_rep_email',       sfCol:'Project Event : Opportunity : Sales Rep Email',           type:'text' },
  { key:'start',                 sfCol:'Project Start Date',                                      type:'date' },
  { key:'requested',             sfCol:'Site Survey Requested',                                   type:'date' },
  { key:'scheduled',             sfCol:'Site Survey Scheduled',                                   type:'date' },
  { key:'complete',              sfCol:'Site Survey Complete',                                    type:'date' },
  { key:'resource',              sfCol:'Site Survey Resource',                                    type:'text' },
  { key:'survey_type',           sfCol:'Site Survey Type',                                        type:'text' },
  { key:'reviewed_by',           sfCol:'Reviewed By',                                             type:'text' },
  { key:'last_reviewed_date',    sfCol:'Last Reviewed',                                           type:'text' },
  { key:'last_reviewed_subject', sfCol:'Last Reviewed Subject',                                   type:'text' },
  { key:'last_comment',          sfCol:'Last Reviewed Comments',                                  type:'text' },
  { key:'list',                  sfCol:'List',                                                    type:'text' },
  { key:'task_id',               sfCol:'TaskRay Task ID',                                         type:'text' },
  { key:'owner',                 sfCol:'Owner: Full Name',                                        type:'text' },
  { key:'reopened_by_design',    sfCol:'Reopened by Design',                                      type:'text' },
  { key:'resurvey_reason',       sfCol:'Resurvey Reason',                                         type:'text' },
  { key:'resurvey_attributed',   sfCol:'Resurvey Attributed To',                                  type:'text' },
  { key:'resurvey_requested',    sfCol:'Resurvey Requested Date',                                 type:'date' },
  { key:'resurvey_scheduled',    sfCol:'Resurvey Scheduled',                                      type:'date' },
  { key:'resurvey_complete',     sfCol:'Resurvey Complete Date',                                  type:'date' },
  { key:'resurvey_details',      sfCol:'Resurvey Request Details',                                type:'text' },
];

function cleanDate(s) {
  if (!s) return '';
  const datePart = String(s).split(',')[0].trim();
  const m = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return '';
  const yr = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${yr}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
}

function dDiff(a, b) {
  if (!a || !b) return null;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((new Date(by, bm-1, bd) - new Date(ay, am-1, ad)) / 86400000 * 10) / 10;
}

function normalizeCell(val) {
  if (val === true  || val === 'TRUE'  || val === 'True')  return '1';
  if (val === false || val === 'FALSE' || val === 'False') return '0';
  return String(val || '').replace(/\s+/g, ' ').trim();
}

function parseXls(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const allData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

  const FIELD_COLS = new Set(FIELDS.map(f => f.sfCol));
  const headerRowIdx = allData.findIndex(row =>
    row.filter(cell => FIELD_COLS.has(String(cell).trim())).length >= 3
  );
  if (headerRowIdx === -1) throw new Error('No header row found');

  const headers = allData[headerRowIdx].map(h => String(h).trim());
  const colIdx = {};
  FIELDS.forEach(f => { const i = headers.indexOf(f.sfCol); if (i >= 0) colIdx[f.key] = i; });

  const rows = [];
  allData.slice(headerRowIdx + 1).forEach((row, i) => {
    const cells = row.map(normalizeCell);
    if (cells.every(c => c === '')) return;
    const r = { id: i, ct_s2r: null, ct_r2s: null, ct_total: null, ct_resurvey: null };
    FIELDS.forEach(f => {
      r[f.key] = colIdx[f.key] !== undefined
        ? (f.type === 'date' ? cleanDate(cells[colIdx[f.key]] || '') : (cells[colIdx[f.key]] || ''))
        : '';
    });
    if (!r.region) return;
    if (!r.task_id) return; // need a stable ID for upserts
    if (!r.resource && r.complete) r.resource = 'Sales Rep';
    r.ct_s2r   = dDiff(r.start, r.requested);
    r.ct_r2s   = dDiff(r.requested, r.scheduled);
    r.ct_total = dDiff(r.start, r.complete);
    if (r.ct_total != null && r.ct_total < 0) r.ct_total = 0;
    r.ct_resurvey = dDiff(r.resurvey_requested, r.resurvey_complete);
    if (r.ct_resurvey != null && r.ct_resurvey < 0) r.ct_resurvey = 0;
    rows.push(r);
  });

  return rows;
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function localDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const buffer = await getRawBody(req);
    if (buffer.length < 100000) {
      return res.status(400).json({ error: 'File too small — use Details Only export from Salesforce.' });
    }

    const rows = parseXls(buffer);
    if (!rows.length) return res.status(400).json({ error: 'No rows parsed — check file format.' });

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const today = localDateStr();

    // Replace all rows — delete everything first so stale projects don't linger
    await supabase.from('survey_rows').delete().neq('task_id', '');
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map(r => ({ task_id: r.task_id, data: r }));
      const { error } = await supabase.from('survey_rows').insert(chunk);
      if (error) throw new Error('Supabase insert: ' + error.message);
    }

    // Update metadata
    await supabase.from('data_meta').upsert({ id: 1, last_uploaded: today, uploaded_at: new Date().toISOString(), row_count: rows.length });

    return res.status(200).json({ ok: true, rows: rows.length, date: today });
  } catch (err) {
    console.error('upload-data error:', err);
    return res.status(500).json({ error: err.message });
  }
}
