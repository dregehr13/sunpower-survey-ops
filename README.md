# Survey Ops

Internal operations dashboard + email generator for SunPower's Site Survey department.

- **Dashboard:** https://sunpower-survey-ops.vercel.app
- **Email generator:** https://sunpower-survey-ops.vercel.app/compose

## Architecture

Deliberately build-less. Two self-contained HTML pages (inline CSS + JS, Chart.js
via CDN) plus a handful of Vercel serverless functions. Data is baked into static
files until the Salesforce API integration lands.

```
index.html            Dashboard — Current / Performance / Trends / WIP / Resurveys / Map / Data / Settings
compose/index.html    Email + Teams card generator
data.js               const RAW = [...] — the dataset the browser pages load
data.json             Same rows as plain JSON — read by /api/morning-card
lib/metrics.cjs       Shared metric definitions (loaded by both pages and the API)
parse-sf.js           Salesforce XLS export → rows (mirrors the FIELDS registry in index.html)
push.sh               Parse latest SF export, write data files, commit + push (→ Vercel deploy)
api/update.js         Dashboard-upload path: commits data.js + data.json via GitHub API
api/generate.js       Claude-written email commentary options
api/morning-card.js   Stats + AI opener for the Teams morning card
api/team-opener.js    AI opener only (stats supplied by client)
api/_opener-prompt.js The opener prompt, shared by the two above
api/send-teams.js     Posts an Adaptive Card to the Teams webhook
api/upload-data.js    XLS → Supabase, for the /queues page only
docs/METRICS.md       The metric register — every displayed number and its definition
test/                 node:test suites (metrics, frozen snapshot, cross-surface guards)
scripts/              build-fixture.cjs (test fixture), build-geo.cjs (geo/)
geo/                  ZIP centroids, state outlines, top-1k cities, per-state counties
queues/index.html     Separate Supabase-backed queues page — see the note below
```

`queues/` is routed in `vercel.json` and has been untouched since June 2026. It
carries its own copy of the field registry and its own data path, and nothing
else in this repo depends on it. Either document it or retire it (page, routes,
`api/upload-data.js`, and the `@supabase/supabase-js` dependency).

## Daily data update

1. In Salesforce: run the Site Survey report → Export → **Details Only** → Excel format → save to Downloads.
2. Run `./push.sh` — finds the newest `report*.xls` in `~/Downloads`, parses it,
   writes `data.js` + `data.json`, commits, and pushes. Vercel deploys in ~30s.
3. Code-only deploys: plain `git push`.

Alternative: the **Update data** button in the dashboard nav accepts a dropped
`.xls` export and commits it through `/api/update` (requires the update password).

## Environment variables (Vercel)

| Var | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | generate, morning-card, team-opener |
| `UPDATE_PASSWORD` | update |
| `GITHUB_TOKEN` | update (contents:write on this repo) |
| `TEAMS_WEBHOOK_URL` | send-teams |

## Metric definitions

**[`docs/METRICS.md`](docs/METRICS.md) is the register** — every displayed number,
its definition, and which surfaces read it. The summary below is a pointer, not a
second source of truth; when the two disagree, the register and `lib/metrics.cjs`
win. (They have disagreed: this section carried the pre-2026 SS ratio for months,
and compose grew a copy of it.)

- **Row scope (`inScope`):** `start ≥ DATA_CUTOFF` (2025-12-29) **and** either the
  survey is complete — which counts even on an At-Risk or Canceled project, since
  the survey still happened — or the project is In Progress / Change Order.
- **Cycle time (`ct_total`):** Project Start Date → Site Survey Complete, calendar days.
  Intermediate dates (requested/scheduled) exist but are unreliable — not featured.
  `agreement_signed` is context, never the anchor.
- **Complete:** requires *both* a Site Survey Complete date *and* `List = 'Complete'`.
- **WIP:** has a start date and is not complete.
- **Two age metrics, never interchangeable:** `wipAgeFrom` is the cycle-time anchor
  (resurvey request → completion + 2 days → start); `ssDaysOpen` is queue triage,
  the same anchor minus one rep grace day.
- **Targets:** median 3 days, average 4 days (Spec 12744).
- **SS ratio — two variants on purpose:** `ssRatioForWeek` (the reported weekly
  number: **7-day mean WIP** across the week ÷ completions of the 3 most recent
  complete weeks) and `ssRatioLive` (open WIP right now, for the WIP page card).
  The numerator is a mean, not a Sunday close — intake keeps arriving Fri/Sat
  while the team is off, so a week-close snapshot samples the weekly maximum.
  Bands: **≤1.0 healthy · 1–2 the normal operating range, deliberately uncoloured
  · 2.0+ the alarm.**
- **`ct_full`:** `ct_total + ct_resurvey`.
- **FPY:** (Completions − internal defects) / Completions. Internal defects are
  resurveys attributed to SunPower Field or Radicl agents. A request logged as
  "Unnecessary Request" is not a defect — nothing was re-surveyed.

Full field registry and parsing rules: `FIELDS` in `index.html` and `parse-sf.js`.

## Tests

```
npm test                     # three suites, node:test — run before changing any metric
UPDATE_SNAPSHOT=1 npm test   # accept an intentional metric change, deliberately
```

- `test/metrics.test.js` — each function against hand-written cases.
- `test/snapshot.test.js` — every metric against a frozen real-data fixture; a
  definition change fails with a value diff.
- `test/surfaces.test.js` — static cross-surface guards (no surface reimplements
  a shared definition, bands are never inline, no stale `TIP` entries).
