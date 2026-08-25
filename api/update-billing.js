// api/update-billing.js — import a vendor statement from the Billing page,
// committing the merged billing.json to GitHub the same way api/update.js
// commits data.js/data.json for a Salesforce export.
//
// POST { fileBase64, filename, vendor, password }
//
// Requires the same Vercel env vars api/update.js does — GITHUB_TOKEN and
// UPDATE_PASSWORD — since this is the same "coworkers push data to the
// dashboard" action, just for the invoice side instead of the survey side.
//
// Parsing and the merge rule (replace a statement's own lines, keep every
// other statement's) come from lib/statement-import.cjs — the same code
// path parse-radicl.js runs from the terminal, so an in-app import and a
// CLI import behave identically.
import XLSX from 'xlsx';
import OpsBilling from '../lib/billing.cjs';
import StatementImport from '../lib/statement-import.cjs';
const { parseWorkbookLines, mergeStatement, overlapWarnings } = StatementImport;

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

const OWNER = 'dregehr13';
const REPO = 'sunpower-survey-ops';

const gh = (path, token, opts = {}) =>
  fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { fileBase64, filename, vendor, password } = req.body || {};
  if (!fileBase64 || !filename) return res.status(400).json({ error: 'Missing fileBase64 or filename' });

  const expectedPw = process.env.UPDATE_PASSWORD;
  if (!expectedPw) return res.status(500).json({ error: 'UPDATE_PASSWORD env var not set' });
  if (password !== expectedPw) return res.status(401).json({ error: 'Incorrect password' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });

  const vendorId = vendor || OpsBilling.DEFAULT_VENDOR;
  if (!OpsBilling.VENDORS[vendorId]) return res.status(400).json({ error: `Unknown vendor "${vendorId}"` });

  let lines;
  try {
    const buf = Buffer.from(fileBase64, 'base64');
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    lines = parseWorkbookLines(wb, vendorId);
    if (!lines.length) throw new Error('no billable lines found in the statement');
  } catch (err) {
    return res.status(400).json({ error: `Could not parse "${filename}": ${err.message}` });
  }

  try {
    // 1. Read the current billing.json off GitHub — the live repo state, not
    //    whatever this function instance happens to have on disk.
    const getRes = await gh('/contents/billing.json?ref=main', token);
    if (!getRes.ok) throw new Error(`GET billing.json → ${getRes.status}`);
    const got = await getRes.json();
    const currentSha = got.sha;
    const history = JSON.parse(Buffer.from(got.content, 'base64').toString('utf8'));

    // 2. Merge — replaces this statement's own lines, keeps every other one.
    const { history: next, meta, replaced, charged } = mergeStatement(history, vendorId, filename, lines);
    const warnings = overlapWarnings(next);

    // 3. Commit the merged file back.
    const content = Buffer.from(JSON.stringify(next, null, 2) + '\n').toString('base64');
    const putRes = await gh('/contents/billing.json', token, {
      method: 'PUT',
      body: JSON.stringify({
        message: `Billing import: ${meta.id} (dashboard upload)`,
        content, sha: currentSha, branch: 'main',
      }),
    });
    if (!putRes.ok) {
      const detail = await putRes.json().catch(() => ({}));
      throw new Error(`PUT billing.json → ${putRes.status} ${detail.message || ''}`);
    }
    const putJson = await putRes.json();

    res.status(200).json({
      ok: true,
      history: next,
      report: { id: meta.id, lines: lines.length, replaced, from: meta.from, to: meta.to,
        charged, usd: OpsBilling.usd(charged, vendorId) },
      warnings,
      commit: putJson.commit && putJson.commit.sha ? putJson.commit.sha.slice(0, 7) : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
