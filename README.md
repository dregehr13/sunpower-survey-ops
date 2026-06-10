# Survey Ops

Internal operations dashboard + email generator for SunPower's Site Survey department.

- **Dashboard:** https://sunpower-survey-ops.vercel.app
- **Email generator:** https://sunpower-survey-ops.vercel.app/compose

## Architecture

Deliberately build-less. Two self-contained HTML pages (inline CSS + JS, Chart.js
via CDN) plus a handful of Vercel serverless functions. Data is baked into static
files until the Salesforce API integration lands.

```
index.html            Dashboard — Current / Performance / Trends / WIP / Resurveys / Data / Settings
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
api/send-teams.js     Posts an Adaptive Card to the Teams webhook
```

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

- **Row scope:** `project_status` ∈ {In Progress, Change Order} and `start ≥ DATA_CUTOFF` (2025-12-29).
- **Cycle time (`ct_total`):** Project Start Date → Site Survey Complete, calendar days.
  Intermediate dates (requested/scheduled) exist but are unreliable — not featured.
- **Complete:** requires *both* a Site Survey Complete date *and* `List = 'Complete'`.
- **WIP:** has a start date and is not complete.
- **WIP age:** from `resurvey_requested` if present, else `complete + 2 days`, else `start`.
- **Targets:** median 3 days, average 4 days (Spec 12744).
- **SS / pipeline ratio:** end-of-week WIP ÷ average completions of the 3 most recent
  full weeks — "weeks of backlog". Above 1.0 is a concern.
- **`ct_full`:** `ct_total + ct_resurvey`.
- **FPY (pending SF fields):** (Completions − internal defects) / Completions, where
  internal defects are resurveys attributed to SunPower Field or Radicl agents.

Full field registry and parsing rules: `FIELDS` in `index.html` and `parse-sf.js`.
