// api/update-outlook.js — save Doug's own read on an area from the Resource
// page, committing outlook.json to GitHub the same way api/update.js commits
// data.js/data.json and api/update-outlook.js's sibling commits billing.json.
//
// POST { state, flag, note, by }  →  { ok, outlook, commit }
//
// WHY THIS IS A COMMITTED FILE AND NOT localStorage. The Resource page exists
// to make a staffing case to somebody else, so a note only the author's browser
// can see does not do the job. The dashboard has also already been burned by
// the local version: the WIP "needs attention" badge kept its dismissals in
// localStorage and was removed in August 2026 because those dismissals made the
// badge disagree with Salesforce for anyone who had clicked one. A judgement
// that changes what a shared page says has to live where the page lives.
//
// NO PASSWORD — Doug's call 2026-08-26. This endpoint takes any POST and
// commits it. What it can write is bounded to the point of being dull: a
// two-letter state code, one of four flags, and 280 characters of note, into
// one file that no metric reads. Weighed against a password prompt on every
// two-word judgement, on a page one person opens, he chose the prompt goes.
//
// It is now in the same class as /api/send-teams and /api/team-opener, which
// have never had auth (audit finding A1). The honest fix for all three is
// Vercel Deployment Protection in front of the deployment, not a secret in a
// static page — which is public by definition and would only look like one.
// The other two writers, api/update.js and api/update-billing.js, KEEP their
// password: those commit the dataset and the invoice history.
//
// Requires GITHUB_TOKEN, the same var api/update.js uses. No new configuration.

export const config = { api: { bodyParser: { sizeLimit: '64kb' } } };

const OWNER = 'dregehr13';
const REPO = 'sunpower-survey-ops';
const FILE = 'outlook.json';

// A flag is a small closed vocabulary, not free text, so the page can band it
// and so two people writing "slowing down" and "winding down" do not produce
// two categories. The note carries everything a flag cannot.
const FLAGS = ['growing', 'steady', 'winding_down', 'unknown'];
const NOTE_MAX = 280;
const STATE_RE = /^[A-Z]{2}$/;

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

  const { state, flag, note, by } = req.body || {};

  const st = String(state || '').trim().toUpperCase();
  if (!STATE_RE.test(st)) return res.status(400).json({ error: 'state must be a two-letter code' });

  const fl = String(flag || 'unknown').trim();
  if (!FLAGS.includes(fl)) return res.status(400).json({ error: `flag must be one of ${FLAGS.join(', ')}` });

  // Trimmed rather than rejected: a note running long is a person typing, not
  // an error worth throwing their words away over.
  const text = String(note == null ? '' : note).trim().slice(0, NOTE_MAX);
  const author = String(by || '').trim().slice(0, 60) || 'Doug';

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });

  try {
    // 1. Read the live file off GitHub, not off this function instance's disk —
    //    the same rule api/update-billing.js follows, so two people saving from
    //    two browsers cannot clobber each other's states.
    const getRes = await gh(`/contents/${FILE}?ref=main`, token);
    if (!getRes.ok) throw new Error(`GET ${FILE} → ${getRes.status}`);
    const got = await getRes.json();
    const current = JSON.parse(Buffer.from(got.content, 'base64').toString('utf8'));

    const at = new Date().toISOString().slice(0, 10);
    const states = { ...(current.states || {}) };

    // Clearing a note AND setting the flag back to unknown removes the entry
    // outright, so an area with nothing to say carries no stale byline.
    if (!text && fl === 'unknown') delete states[st];
    else states[st] = { flag: fl, note: text, by: author, at };

    const next = { ...current, updated: at, states };

    // 2. Commit it back.
    const content = Buffer.from(JSON.stringify(next, null, 2) + '\n').toString('base64');
    const putRes = await gh(`/contents/${FILE}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        message: `Outlook: ${st} — ${text ? fl : 'cleared'} (dashboard)`,
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
      outlook: next,
      commit: putJson.commit && putJson.commit.sha ? putJson.commit.sha.slice(0, 7) : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
