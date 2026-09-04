#!/usr/bin/env node
// scripts/build-epc.cjs — external EPC accounts (Salesforce report) → epc.json
//
// Usage: node scripts/build-epc.cjs <report.xls>
//
// These are projects sold through an external EPC. They never appear in the
// Site Survey export, because that report is scoped to SunPower's own survey
// tasks — but we still get billed for surveying them, so without this file
// every one of those charge lines reads as "No Salesforce record" and lands in
// the review pile. This is an ACCOUNT REGISTRY and nothing more: the export
// carries no survey resource and no survey dates, so an EPC-matched line can
// be costed but can never contribute to cycle time or first pass yield.
//
// Same shape as roster.json and overrides.json: hand-refreshed, committed, and
// read by the page at runtime rather than baked into it.
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/build-epc.cjs <report.xls>'); process.exit(1); }

// Salesforce "Export → Details Only" ships an HTML table with a .xls suffix,
// and escapes its free text, so an office arrives as "Solar&#39;s Dead".
const dec = s => s
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').trim();

const raw = fs.readFileSync(file, 'latin1');
const trs = raw.split(/<tr[^>]*>/i).slice(1);
let cols = null;
const rows = [];
for (const tr of trs) {
  const cells = (tr.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [])
    .map(c => dec(c.replace(/<[^>]+>/g, '')));
  if (!cells.length) continue;
  if (!cols) { cols = cells; continue; }
  if (cells.length < cols.length - 2) continue;
  const o = {};
  cols.forEach((k, i) => { o[k] = cells[i] || ''; });
  rows.push(o);
}

const pick = (o, ...names) => { for (const n of names) if (o[n]) return o[n]; return ''; };
const out = rows
  .map(r => ({
    project: pick(r, 'Project name', 'Project Name'),
    contact: pick(r, 'Customer Name', 'Primary Contact'),
    address: pick(r, 'Address', 'Installation Address'),
    project_status: pick(r, 'Project Status'),
    opp_stage: pick(r, 'Project Stage'),
    sales_rep: pick(r, 'Opportunity: Sales Rep Name', 'Seller'),
    financier: pick(r, 'Financier'),
  }))
  .filter(r => r.contact && r.address);

const dupes = out.length - new Set(out.map(r => r.project + '|' + r.address)).size;
const dest = path.join(__dirname, '..', 'epc.json');
fs.writeFileSync(dest, JSON.stringify({
  _comment: 'External EPC accounts. Built by scripts/build-epc.cjs from a Salesforce report; '
    + 'refresh it the same way and commit. Cost only — this export carries no survey resource '
    + 'or dates, so these accounts can never feed cycle time or first pass yield.',
  updated: new Date().toISOString().slice(0, 10),
  accounts: out,
}, null, 1));

console.error(`epc.json: ${out.length} accounts from ${rows.length} rows`
  + (dupes ? `, ${dupes} duplicate project/address pairs` : '')
  + (rows.length - out.length ? `, ${rows.length - out.length} dropped for a missing name or address` : ''));
