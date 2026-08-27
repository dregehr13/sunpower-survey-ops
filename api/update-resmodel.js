// api/update-resmodel.js — save the Resource page's capacity and cost model,
// committing resmodel.json to GitHub the way api/update-outlook.js commits
// outlook.json and api/update-billing.js commits billing.json.
//
// POST { model, cost, by, password }  →  { ok, resmodel, commit }
//
// WHY THIS IS A COMMITTED FILE AND NOT localStorage. Every capacity figure on
// the Resource page — the modelled ceiling, the utilisation percentage, the
// break-even against the vendor — scales with these numbers, and the page
// exists to make a staffing case to somebody else. A model kept in one browser
// is one that disappears with a new laptop and that nobody else is looking at.
// The dashboard has been here before: the WIP "needs attention" dismissals
// lived in localStorage and made the badge disagree with Salesforce for anyone
// who had clicked one.
//
// Requires the same Vercel env vars api/update.js does — GITHUB_TOKEN and
// UPDATE_PASSWORD. No new configuration.

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };

const OWNER = 'dregehr13';
const REPO = 'sunpower-survey-ops';
const FILE = 'resmodel.json';

// Closed vocabularies, mirroring RES_MODEL_FIELDS / RES_COST_FIELDS in
// index.html. An unknown key is DROPPED rather than rejected: the page is the
// only writer, so an unrecognised key means a rename mid-deploy, and losing one
// knob is better than refusing the save that carries the other eight. Bounds
// are wide — they exist to keep a typo out of the file, not to second-guess a
// number Doug has actually observed.
const MODEL_KEYS = {
  fieldHoursPerDay:     [1, 16],
  dailyOverheadMinutes: [0, 480],
  onSiteMinutes:        [5, 480],
  adminMinutesPerJob:   [0, 240],
  avgSpeedMph:          [5, 80],
  roadFactor:           [1, 3],
  hopMi:                [0, 60],
  maxOneWayMi:          [10, 250],
  daysAvailable:        [1, 7],
};
const COST_KEYS = {
  surveyorAnnual: [0, 400000],
  mileageRate:    [0, 5],
  mileageDayMi:   [0, 500],
  mileageBonus:   [0, 5],
  vehicleMonthly: [0, 10000],
};

// Only finite numbers inside the bounds survive. Everything else is dropped,
// which is also how a knob gets put BACK to its shipped value: the page sends
// the key absent, and an absent key is the whole meaning of "not overridden".
function clean(input, spec) {
  const out = {};
  Object.entries(input || {}).forEach(([k, v]) => {
    const bounds = spec[k];
    if (!bounds) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < bounds[0] || n > bounds[1]) return;
    out[k] = n;
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

  const { model, cost, by, password } = req.body || {};

  const expectedPw = process.env.UPDATE_PASSWORD;
  if (!expectedPw) return res.status(500).json({ error: 'UPDATE_PASSWORD env var not set' });
  if (password !== expectedPw) return res.status(401).json({ error: 'Incorrect password' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });

  const nextModel = clean(model, MODEL_KEYS);
  const nextCost = clean(cost, COST_KEYS);
  const author = String(by || '').trim().slice(0, 60) || 'Doug';

  try {
    // Read the live file off GitHub rather than off this instance's disk, so
    // two browsers saving cannot clobber each other — the rule every other
    // write endpoint here follows.
    const getRes = await gh(`/contents/${FILE}?ref=main`, token);
    if (!getRes.ok) throw new Error(`GET ${FILE} → ${getRes.status}`);
    const got = await getRes.json();
    const current = JSON.parse(Buffer.from(got.content, 'base64').toString('utf8'));

    const at = new Date().toISOString().slice(0, 10);
    const next = { ...current, updated: at, by: author, model: nextModel, cost: nextCost };

    const n = Object.keys(nextModel).length + Object.keys(nextCost).length;
    const content = Buffer.from(JSON.stringify(next, null, 2) + '\n').toString('base64');
    const putRes = await gh(`/contents/${FILE}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        message: `Resource model: ${n ? `${n} knob${n === 1 ? '' : 's'} set` : 'back to the shipped estimate'} (dashboard)`,
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
      resmodel: next,
      commit: putJson.commit && putJson.commit.sha ? putJson.commit.sha.slice(0, 7) : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
