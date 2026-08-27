// api/update.js — Save updated SF data to GitHub, triggering a Vercel redeploy
// POST { rows: [...], password: "..." }, optionally gzipped (x-encoding: gzip)
//
// THE BODY ARRIVES GZIPPED, and it has to. Vercel caps a function's request
// body at 4.5MB — a platform limit ahead of the function, so `sizeLimit` here
// never applied and raising it changes nothing. The report change took the 
// payload over 4.5MB, causing FUNCTION_PAYLOAD_TOO_LARGE. gzip drops the 
// payload size significantly on the wire.
//
// The body parser is off so the raw stream is readable; a plain JSON body
// still works (curl, older browser with no CompressionStream), held to 4.5MB.
//
// Requires Vercel env vars:
//   GITHUB_TOKEN    — Personal access token with `contents:write` on the repo
//   UPDATE_PASSWORD — Shared password coworkers use to save data

import { gunzipSync } from 'zlib';

export const config = { api: { bodyParser: false } };

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let buf = Buffer.concat(chunks);
  if ((req.headers['x-encoding'] || '') === 'gzip') buf = gunzipSync(buf);
  return JSON.parse(buf.toString('utf8'));
}

const OWNER = 'dregehr13';
const REPO  = 'sunpower-survey-ops';

const gh = (path, token, opts = {}) =>
  fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', ...(opts.headers||{}) }
  });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let body;
  try { body = await readBody(req); }
  catch (e) { return res.status(400).json({ error: 'Could not read request body: ' + e.message }); }

  const { rows, password } = body || {};
  if (!rows || !Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Missing rows' });

  const expectedPw = process.env.UPDATE_PASSWORD;
  if (!expectedPw) return res.status(500).json({ error: 'UPDATE_PASSWORD env var not set' });
  if (password !== expectedPw) return res.status(401).json({ error: 'Incorrect password' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });

  const date = new Date().toISOString().slice(0, 10);
  // Match push.sh's DATA_TS format: 'YYYY-MM-DD HH:MM' in Mountain Time
  const ts = new Date().toLocaleString('sv-SE', { timeZone: 'America/Denver' }).slice(0, 16);
  const json = JSON.stringify(rows);
  // data.json must stay in sync — /api/morning-card computes its stats from it
  const FILE_CONTENT = {
    'data.js': `const RAW = ${json};\nconst DATA_TS = '${ts}';\n`,
    'data.json': json,
  };

  try {
    // 1. Get latest commit SHA on main
    const refRes = await gh('/git/refs/heads/main', token);
    if (!refRes.ok) throw new Error(`GET ref → ${refRes.status}`);
    const { object: { sha: latestCommitSha } } = await refRes.json();

    // 2. Get the tree SHA of that commit
    const commitRes = await gh(`/git/commits/${latestCommitSha}`, token);
    if (!commitRes.ok) throw new Error(`GET commit → ${commitRes.status}`);
    const { tree: { sha: baseTreeSha } } = await commitRes.json();

    // 3. Build data.js + data.json content directly — no regex on large file
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

    // 4. Create new tree
    const treeRes = await gh('/git/trees', token, {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries })
    });
    if (!treeRes.ok) throw new Error(`POST tree → ${treeRes.status}`);
    const { sha: newTreeSha } = await treeRes.json();

    // 5. Create commit
    const newCommitRes = await gh('/git/commits', token, {
      method: 'POST',
      body: JSON.stringify({
        message: `Data update ${date} (dashboard upload)`,
        tree: newTreeSha,
        parents: [latestCommitSha]
      })
    });
    if (!newCommitRes.ok) throw new Error(`POST commit → ${newCommitRes.status}`);
    const { sha: newCommitSha } = await newCommitRes.json();

    // 6. Update ref
    const updateRefRes = await gh('/git/refs/heads/main', token, {
      method: 'PATCH',
      body: JSON.stringify({ sha: newCommitSha })
    });
    if (!updateRefRes.ok) throw new Error(`PATCH ref → ${updateRefRes.status}`);

    res.status(200).json({ ok: true, rows: rows.length, commit: newCommitSha.slice(0, 7) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
