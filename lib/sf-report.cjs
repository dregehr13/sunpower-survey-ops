// lib/sf-report.cjs — Fetch a Salesforce report via the Analytics REST API
// and convert it into the same allData shape (array-of-arrays, header row +
// data rows) that parse-sf.js builds from an .xls export — so
// lib/parse-sf-core.cjs's parseRows() runs identically either way.
//
// Using the Analytics REST API (rather than raw SOQL) is deliberate: it reads
// the existing "Site Survey" report exactly as it's defined in Salesforce —
// same fields, same filters — so there's no separate query to keep in sync
// with whatever the report does. The tradeoff is a hard cap of 2,000 detail
// rows per response; the live report is currently ~4,700 rows (see
// CLAUDE.md's 2026-08-26 report-change note) so pagination is required — see
// fetchAllReportRows() below.
'use strict';

const DEFAULT_API_VERSION = 'v62.0';

async function fetchReportPage({ instanceUrl, accessToken, reportId, apiVersion = DEFAULT_API_VERSION }) {
  const url = `${instanceUrl}/services/data/${apiVersion}/analytics/reports/${reportId}?includeDetails=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`sf-report: report fetch failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// The synchronous /analytics/reports/<id> endpoint truncates at 2,000 rows
// and sets allData.length === maxRowsExceeded, with no cursor of its own.
// Salesforce's documented workaround for a large tabular/detail report is the
// *asynchronous* Report Instance API (POST to queue a run, poll GET until
// Success, then read factMap off the completed instance) — that returns the
// full row set in one instance, no manual paging. Left as a named TODO since
// it can't be verified without a live org; the synchronous call above is
// fine for reports under 2,000 rows and for a first end-to-end smoke test.
async function fetchFullReport(opts) {
  const json = await fetchReportPage(opts);
  const grp = json.factMap && json.factMap['T!T'];
  if (grp && grp.rows && json.allData && json.allData.maxRowsExceeded) {
    throw new Error(
      'sf-report: report exceeds the 2,000-row synchronous limit — switch to the ' +
      'asynchronous Report Instance API (POST .../analytics/reports/<id>/instances, ' +
      'poll for Success, then read factMap off the instance) before relying on this in production.'
    );
  }
  return json;
}

// Converts the Analytics API's report JSON into allData: [headerRow, ...dataRows],
// each cell a plain string, matching what lib/parse-sf-core.cjs expects from
// an XLSX sheet_to_json({header:1}) call.
//
// reportMetadata.detailColumns gives the ordered API field keys for a
// Tabular/Details-Only report; reportExtendedMetadata.detailColumnInfo maps
// each key to its display label — the same label text FIELDS' sfCol values in
// lib/parse-sf-core.cjs are written against, so no field-mapping duplication
// is needed on this side.
function reportToAllData(reportJson) {
  const cols = reportJson.reportMetadata && reportJson.reportMetadata.detailColumns;
  if (!cols || !cols.length) throw new Error('sf-report: reportMetadata.detailColumns is empty — confirm the report format is Tabular with Details Only (not Summary/Matrix).');

  const colInfo = (reportJson.reportExtendedMetadata && reportJson.reportExtendedMetadata.detailColumnInfo) || {};
  const headerRow = cols.map(k => (colInfo[k] && colInfo[k].label) || k);

  const grp = reportJson.factMap && reportJson.factMap['T!T'];
  if (!grp) throw new Error('sf-report: no ungrouped detail rows (factMap["T!T"]) — report may be Summary/Matrix format, not Tabular.');

  const dataRows = grp.rows.map(row => row.dataCells.map(cell => (cell && cell.label != null) ? String(cell.label) : ''));
  return [headerRow, ...dataRows];
}

module.exports = { fetchReportPage, fetchFullReport, reportToAllData, DEFAULT_API_VERSION };
