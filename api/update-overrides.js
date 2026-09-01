// api/update-overrides.js — save the manual cycle-time anchor overrides,
// committing overrides.json to GitHub the way api/update.js commits
// data.js/data.json and api/update-resmodel.js commits resmodel.json.
//
// POST { rows, by, password }  →  { ok, overrides, commit }
//
// WHY THIS IS A COMMITTED FILE AND NOT localStorage. An override changes the
// start date every cycle time and every queue age measures a row from — the
// same class of thing api/update.js writes. A correction kept in one browser
// disappears with a new laptop and is invisible to compose and the morning
// card, both of which read the baked data.js. parse-sf.js reads this file at
// import and bakes the swap in; this endpoint is how the file gets there when
// the fix is made in the app rather than by hand.
//
// KEEPS THE UPDATE PASSWORD — unlike api/update-resmodel.js and
// api/update-outlook.js, which dropped theirs (audit finding A1) because they
// only write assumptions on one page. This writes a correction to the dataset,
// so it stays in the same class as api/update.js and api/update-billing.js.
//
// What it will accept is still tightly bounded: a key must look like a
// TaskRay id, `start` must be an ISO date, `reason` is trimmed to 280 chars,
// and every other field on an entry is dropped. The client sends the full
// desired map each time, so this replaces `rows` wholesale.
//
// Requires GITHUB_TOKEN and UPDATE_PASSWORD, the same vars api/update.js uses.

export const config = { api: { bodyParser: { sizeLimit: '64kb' } } };

const OWNER = 'dregehr13';
const REPO = 'sunpower-survey-ops';
const FILE = 'overrides.json';

const TASK_RE = /^[A-Za-z0-9]{15,18}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REASON_MAX = 280;

// Only entries that pass every check survive; anything malformed is dropped
// rather than failing the save that carries the good ones.
function clean(rows) {
  const out = {};
  Object.entries(rows || {}).forEach(([k, v]) => {
    if (!TASK_RE.test(k)) return;
    if (!v || typeof v !== 'object') return;
    const start = String(v.start || '');
    if (!DATE_RE.test(start) || Number.isNaN(Date.parse(start))) return;
    out[k] = {
      start,
      project: String(v.project || '').trim().slice(0, 40),
      reason: String(v.reason || '').trim().slice(0, REASON_MAX),
    };
  });
  return out;
}

const gh = (path, token, opts = {}) =>
  fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { rows, by, password } = req.body || {};

  const expectedPw = process.env.UPDATE_PASSWORD;
  if (!expectedPw) return res.status(500).json({ error: 'UPDATE_PASSWORD env var not set' });
  if (password !== expectedPw) return res.status(401).json({ error: 'Incorrect password' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });

  const nextRows = clean(rows);
  const author = String(by || '').trim().slice(0, 60) || 'Doug';

  try {
    // Read the live file off GitHub, not this instance's disk, so two saves
    // cannot clobber each other — the rule every write endpoint here follows.
    const getRes = await gh(`/contents/${FILE}?ref=main`, token);
    if (!getRes.ok) throw new Error(`GET ${FILE} → ${getRes.status}`);
    const got = await getRes.json();
    const current = JSON.parse(Buffer.from(got.content, 'base64').toString('utf8'));

    const at = new Date().toISOString().slice(0, 10);
    const next = { ...current, updated: at, by: author, rows: nextRows };

    const n = Object.keys(nextRows).length;
    const content = Buffer.from(JSON.stringify(next, null, 2) + '\n').toString('base64');
    const putRes = await gh(`/contents/${FILE}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        message: `Anchor overrides: ${n} row${n === 1 ? '' : 's'} (dashboard)`,
        content,
        sha: got.sha,
        branch: 'main',
      }),
    });
    if (!putRes.ok) {
      const detail = await putRes.json().catch(() => ({}));
      throw new Error(`PUT ${FILE} → ${putRes.status} ${detail.message || ''}`);
    }
    const putJson = await putRes.json();

    res.status(200).json({
      ok: true,
      overrides: next,
      commit: putJson.commit && putJson.commit.sha ? putJson.commit.sha.slice(0, 7) : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
