// api/refresh-sf.js — Scheduled Salesforce data refresh, no manual export.
//
// Fetches the Site Survey report via the JWT Bearer flow + Analytics REST
// API, parses it through the same lib/parse-sf-core.cjs as the manual .xls
// path, and commits data.js/data.json to GitHub exactly the way api/update.js
// does — so Vercel's auto-deploy picks it up the same as every other data
// update. Intended to be called by a Vercel Cron (see vercel.json's `crons`)
// on whatever cadence replaces the morning push.sh run, once the Connected
// App + pre-authorized integration user exist on the Salesforce side.
//
// NOT yet exercised against a live org. lib/sf-report.cjs's synchronous
// report call caps at 2,000 rows; the live report is ~4,700, so the async
// Report Instance API needs to be wired in there before this can run for
// real — see the note in that file. This endpoint is otherwise complete and
// ready to test as soon as credentials exist.
//
// Requires Vercel env vars:
//   SF_LOGIN_URL, SF_CLIENT_ID, SF_USERNAME, SF_PRIVATE_KEY, SF_REPORT_ID
//   GITHUB_TOKEN     — same token api/update.js uses (contents:write)
//   CRON_SECRET      — shared secret; Vercel Cron sends it as
//                      `Authorization: Bearer <CRON_SECRET>` automatically
//                      when set, so this rejects any other caller

import SfAuth from '../lib/sf-auth.cjs';
import SfReport from '../lib/sf-report.cjs';
import ParseSfCore from '../lib/parse-sf-core.cjs';

const { getAccessToken } = SfAuth;
const { fetchFullReport, reportToAllData } = SfReport;
const { parseRows } = ParseSfCore;

const OWNER = 'dregehr13';
const REPO  = 'sunpower-survey-ops';

const gh = (path, token, opts = {}) =>
  fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', ...(opts.headers||{}) }
  });

async function fetchGithubFile(path, token) {
  const res = await gh(`/contents/${path}`, token);
  if (!res.ok) return null;
  const { content } = await res.json();
  return JSON.parse(Buffer.from(content, 'base64').toString('utf8'));
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });
  const reportId = process.env.SF_REPORT_ID;
  if (!reportId) return res.status(500).json({ error: 'SF_REPORT_ID env var not set' });

  try {
    const { access_token, instance_url } = await getAccessToken();
    const reportJson = await fetchFullReport({ instanceUrl: instance_url, accessToken: access_token, reportId });
    const allData = reportToAllData(reportJson);

    const overridesFile = await fetchGithubFile('overrides.json', token);
    const overrides = (overridesFile && overridesFile.rows) || {};
    const prevRows = await fetchGithubFile('data.json', token);

    const { rows, warnings, overrideLog } = parseRows(allData, { overrides, prevRows });
    overrideLog.forEach(l => console.log(l));
    warnings.forEach(w => console.warn('WARN: ' + w));

    if (prevRows && JSON.stringify(rows) === JSON.stringify(prevRows)) {
      return res.status(200).json({ ok: true, changed: false, rows: rows.length, warnings: warnings.length });
    }

    const date = new Date().toISOString().slice(0, 10);
    const ts = new Date().toLocaleString('sv-SE', { timeZone: 'America/Denver' }).slice(0, 16);
    const json = JSON.stringify(rows);
    const FILE_CONTENT = {
      'data.js': `const RAW = ${json};\nconst DATA_TS = '${ts}';\n`,
      'data.json': json,
    };

    const refRes = await gh('/git/refs/heads/main', token);
    if (!refRes.ok) throw new Error(`GET ref → ${refRes.status}`);
    const { object: { sha: latestCommitSha } } = await refRes.json();

    const commitRes = await gh(`/git/commits/${latestCommitSha}`, token);
    if (!commitRes.ok) throw new Error(`GET commit → ${commitRes.status}`);
    const { tree: { sha: baseTreeSha } } = await commitRes.json();

    const treeEntries = [];
    for (const [file, content] of Object.entries(FILE_CONTENT)) {
      const blobRes = await gh('/git/blobs', token, {
        method: 'POST',
        body: JSON.stringify({ content, encoding: 'utf-8' })
      });
      if (!blobRes.ok) throw new Error(`POST blob ${file} → ${blobRes.status}`);
      const { sha: blobSha } = await blobRes.json();
      treeEntries.push({ path: file, mode: '100644', type: 'blob', sha: blobSha });
    }

    const treeRes = await gh('/git/trees', token, {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries })
    });
    if (!treeRes.ok) throw new Error(`POST tree → ${treeRes.status}`);
    const { sha: newTreeSha } = await treeRes.json();

    const newCommitRes = await gh('/git/commits', token, {
      method: 'POST',
      body: JSON.stringify({
        message: `Data update ${date} (Salesforce API refresh)`,
        tree: newTreeSha,
        parents: [latestCommitSha]
      })
    });
    if (!newCommitRes.ok) throw new Error(`POST commit → ${newCommitRes.status}`);
    const { sha: newCommitSha } = await newCommitRes.json();

    const updateRefRes = await gh('/git/refs/heads/main', token, {
      method: 'PATCH',
      body: JSON.stringify({ sha: newCommitSha })
    });
    if (!updateRefRes.ok) throw new Error(`PATCH ref → ${updateRefRes.status}`);

    res.status(200).json({ ok: true, changed: true, rows: rows.length, warnings: warnings.length, commit: newCommitSha.slice(0, 7) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
