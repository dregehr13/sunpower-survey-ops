// api/update.js — Save updated SF data to GitHub, triggering a Vercel redeploy
// POST { rows: [...], password: "..." }
//
// Requires Vercel env vars:
//   GITHUB_TOKEN    — Personal access token with `contents:write` on the repo
//   UPDATE_PASSWORD — Shared password coworkers use to save data

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

const OWNER = 'dregehr13';
const REPO  = 'sunpower-survey-ops';
const FILES = ['data.js'];

const gh = (path, token, opts = {}) =>
  fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', ...(opts.headers||{}) }
  });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { rows, password } = req.body || {};
  if (!rows || !Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Missing rows' });

  const expectedPw = process.env.UPDATE_PASSWORD;
  if (!expectedPw) return res.status(500).json({ error: 'UPDATE_PASSWORD env var not set' });
  if (password !== expectedPw) return res.status(401).json({ error: 'Incorrect password' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });

  const date = new Date().toISOString().slice(0, 10);
  const rawJS = `const RAW = ${JSON.stringify(rows)};`;

  try {
    // 1. Get latest commit SHA on main
    const refRes = await gh('/git/refs/heads/main', token);
    if (!refRes.ok) throw new Error(`GET ref → ${refRes.status}`);
    const { object: { sha: latestCommitSha } } = await refRes.json();

    // 2. Get the tree SHA of that commit
    const commitRes = await gh(`/git/commits/${latestCommitSha}`, token);
    if (!commitRes.ok) throw new Error(`GET commit → ${commitRes.status}`);
    const { tree: { sha: baseTreeSha } } = await commitRes.json();

    // 3. Fetch and update each file, create blobs
    const treeEntries = [];
    for (const file of FILES) {
      const fileRes = await gh(`/contents/${file}`, token);
      if (!fileRes.ok) throw new Error(`GET ${file} → ${fileRes.status}`);
      const { content: b64 } = await fileRes.json();
      let content = Buffer.from(b64.replace(/\n/g, ''), 'base64').toString('utf8');
      content = content.replace(/const RAW = \[[\s\S]*?\];/, rawJS);
      content = content.replace(/const DATA_TS = '[^']*';/, `const DATA_TS = '${date}';`);

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
