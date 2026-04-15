// api/update.js — Save updated SF data to GitHub, triggering a Vercel redeploy
// POST { rows: [...], password: "..." }
//
// Requires Vercel env vars:
//   GITHUB_TOKEN    — Personal access token with `contents:write` on the repo
//   UPDATE_PASSWORD — Shared password coworkers use to save data

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

const OWNER = 'dregehr13';
const REPO  = 'sunpower-survey-ops';
const FILES = ['index.html', 'compose/index.html'];

async function ghGet(path, token) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
  });
  if (!res.ok) throw new Error(`GitHub GET ${path} → ${res.status}`);
  return res.json(); // { sha, content (base64) }
}

async function ghPut(path, content, sha, message, token) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: Buffer.from(content).toString('base64'), sha })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub PUT ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { rows, password } = req.body || {};
  if (!rows || !Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Missing rows' });

  const expectedPw = process.env.UPDATE_PASSWORD;
  if (!expectedPw) return res.status(500).json({ error: 'UPDATE_PASSWORD env var not set' });
  if (password !== expectedPw) return res.status(401).json({ error: 'Incorrect password' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });

  const rawJS = `const RAW = ${JSON.stringify(rows)};`;
  const date = new Date().toISOString().slice(0, 10);
  const commitMsg = `Data update ${date} (dashboard upload)`;

  try {
    for (const file of FILES) {
      const { sha, content: b64 } = await ghGet(file, token);
      const current = Buffer.from(b64.replace(/\n/g, ''), 'base64').toString('utf8');
      let updated = current.replace(/const RAW = \[[\s\S]*?\];/, rawJS);
      updated = updated.replace(/const DATA_TS = '[^']*';/, `const DATA_TS = '${date}';`);
      if (updated === current) throw new Error(`RAW pattern not found in ${file}`);
      await ghPut(file, updated, sha, commitMsg, token);
    }
    res.status(200).json({ ok: true, rows: rows.length, message: commitMsg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
