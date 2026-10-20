# Survey Ops — Claude Code Context

## What this is
Internal ops dashboard + email generator for SunPower's Site Survey department.
Built by Doug Regehr (Site Survey Manager) to replace manual reporting done by David Richards (previous manager).

## Live URL
https://sunpower-survey-ops.vercel.app
Email generator: https://sunpower-survey-ops.vercel.app/compose

## Pages
Nav groups (2026-10-05, Doug): a **This Week / Last Week** segmented toggle on top (one `week` page, two views), then **Ops** (WIP · QA · Resource · Billing — what the team works in) and **Analysis** (Performance · Trends · Resurveys · Map). Mobile bar keeps the toggle, WIP, Performance, Trends and Resurveys; the rest sit in More. The Settings landing-page picker is built from the nav tabs.
**The nav label is "Quality"** (back from Resurveys 2026-10-06, Doug: it houses QA and resurvey content). The page id, `#resurvey` hash and `renderResurvey()` stay as they are. The hero opens on two rail cells: **First pass yield (Design)** = the customer measure, completions Design did not send back as a resurvey, and **First pass yield (Site survey complete)** = the internal measure, QA pass rate over QA-reviewed completions (overrides, go backs and go back rate beside it). The resurvey cost lines sit in the card beneath.

## People
- **Doug Regehr** — Site Survey Manager, the user. douglas.regehr@sunpower.com · 801-793-1861
- **Chelsea Herrin** — Doug's manager (as of July 2026). Chelsea.Herrin@sunpower.com. Default email recipient.
- **Allie Morais** — Site Survey Senior Lead. allie.morais@sunpower.com. Doug's direct lead. Default email recipient.
- **Spencer Jensen** — SVP Operations. spencer.jensen@sunpower.com. Reads emails in 45 seconds. Wants to know if there's a problem. (Not on default list as of July 2026.)
- **Rob Barker** — Director of Operations Pre-Install. robert.barker@sunpower.com. (Not on default list as of July 2026.)
- **David Richards** — Previous Site Survey Manager. Replaced by Doug. Used Albatross for reporting before Salesforce.


## Working rules (the short version)
The full design history is in [`docs/DESIGN-NOTES.md`](docs/DESIGN-NOTES.md), one section per page or
subsystem, each with its "things not to undo". **Read the relevant section before changing a page, a
metric or a shared library** — most of what looks like cruft there is a fix for a bug that was found
the hard way. `docs/METRICS.md` is the metric register; `docs/QA.md` covers the QA tool.

- Metric definitions live only in `lib/metrics.cjs` (surveys), `lib/coverage.cjs` (reach, capacity),
  `lib/billing.cjs` (vendor invoices) and `lib/qa.cjs` (QA). Surfaces import them; none reimplements one.
  Run `npm test` before changing any metric. `UPDATE_SNAPSHOT=1 npm test` accepts a deliberate change
- Completion is terminal and WIP is initial surveys only. `isComplete(r)` is `!!r.complete`; resurveys
  and cancellations are tracked separately and never erase a completion
- `r.start` has exactly two writers in index.html, `applyOverrides` and `applyAnchor`. Cycle time and
  queue age are anchor-blind in `lib/metrics.cjs`
- Two age metrics: `wipAgeFrom` (cycle-time anchor, never shift) and `ssDaysOpen` (queue triage)
- Two SS ratios on purpose: `ssRatioForWeek` (reported) and `ssRatioLive` (WIP card). Both initial only
- One filter bar for every page (`buildFBar`, `fbShow`, `fbHint`). No second bar, no global Install Type
- Notes and tooltips state what a number IS, not why it was built that way. Doug is the only reader
- Every drill target goes through `drillAttrs()`. Hover lift is reserved for things that open something
- Glass only for layers floating over the page. Never cards, panels, rails or tables
- `index.html` has a second "REDESIGN SKIN" stylesheet near the bottom that wins over earlier CSS
- `FPY` counts every completed survey, canceled projects included. Settled, do not reopen
- Billing is public by decision; the update endpoints keep `UPDATE_PASSWORD`; outlook and resmodel do not
- Rep surveys were phased out 2026-10-01; no code changed, history is kept


## Morning workflow
1. In Salesforce: run the Site Survey report → Export → Details Only → Excel format → save to Downloads
2. Terminal: `~/Projects/survey-ops/push.sh`
   - Finds the latest `report*.xls` in Downloads automatically
   - Parses it via `parse-sf.js`, writes data.js + data.json
   - Commits and pushes → Vercel auto-deploys in ~30s
3. For code-only deploys (no data update): `git push`

Note: Fully automated fetching (headless CDP/Playwright against the default
profile) was attempted but abandoned — Salesforce MFA triggers on every
untrusted session and Chrome 134+ blocks CDP on the default profile. That
blocker does NOT apply to the Claude in Chrome browser extension, which drives
Doug's real, already-authenticated Chrome as an installed extension rather than
a remote-debugging attach — confirmed working 2026-09-11, no MFA prompt, full
run in under 2 minutes.

**When Doug asks to update the data, do this instead of asking him to run
push.sh manually** — drive it directly with the Claude in Chrome tools:
1. `navigate` to `https://ambia.lightning.force.com/lightning/r/Report/00OUS00000AOYnZ2AX/view?queryScope=userFolders`
   (or read `S.sfInst`/`S.sfRid` from the dashboard's Settings/localStorage if
   the report ID ever changes) and wait ~3s for the report to render
2. **The report toolbar lives inside a same-origin Aura/VF iframe that
   `read_page`/`find` cannot see into** (confirmed by testing — the
   accessibility tree only shows the outer Lightning shell). Pixel clicks via
   `computer` are the only way in; DOM/JS injection (`javascript_tool`) can't
   reach it either. Screenshot first, don't assume prior-session coordinates —
   the toolbar's exact pixel position drifts with viewport width and whether
   the filter panel is open
3. Click the small **caret to the right of the "Edit" button** (top right of
   the report toolbar, NOT the funnel/filter icon — that one toggles a side
   panel and is a common miss-click since it sits a wide margin to the left of
   the real caret; zoom into just the "Edit ▾" pill first to get its precise
   position before clicking)
4. Click **Export** in the dropdown (below Save As / Save / Subscribe)
5. In the Export modal, click the **Details Only** card (Formatted Report is
   selected by default — wrong one). Format defaults to **Excel Format .xls**
   already, which is correct — leave it
6. Click the **Export** button. This opens and auto-closes a blank tab as the
   download fires — no further interaction needed
7. The file lands in Doug's real `~/Downloads` as `report<timestamp>.xls`
   (confirmed — this is his actual local Chrome, not a sandboxed one). Find it
   with `ls -t ~/Downloads/report*.xls | head -1`, then run
   `~/Projects/survey-ops/push.sh <path>` exactly as the manual flow does
8. `push.sh`'s autostash step can leave a stale `stash@{0}` behind if a rebase
   conflict occurs — check `git stash list` after and offer to drop it (don't
   drop without asking; it's someone else's call whether anything in it
   matters)

**The in-app modal's save is GZIPPED, and it has to be** (2026-08-27). Vercel
caps a function's request body at **4.5MB**, ahead of the function — the
`sizeLimit` in `api/update.js` never applied and raising it does nothing. The
2026-08-26 report change took the payload from 3.2MB to 5.9MB, so every save
through the modal returned `FUNCTION_PAYLOAD_TOO_LARGE`; push.sh was unaffected
because it commits the files itself. The client compresses with
`CompressionStream` and sets `x-encoding: gzip`; the endpoint runs with
`bodyParser:false` and gunzips the raw stream. ~7x on this data, 885KB on the
wire. A plain JSON body still parses (curl, a browser with no
`CompressionStream`) — it is just held to the 4.5MB cap. `api/update-billing.js`
carries the same cap on a base64 xlsx and would break at a ~3.3MB statement;
they run a few hundred KB today.

## Targets (Spec 12744)
- Median: 3 days | Avg: 4 days
- Cycle times are **calendar days**, not business days (confirmed by Doug 2026-06-10)
- FPY = (Completions – Internal Defects) / Completions
- A resurvey logged as **"Unnecessary Request"** is not a defect and is excluded
  from the Resurveys page entirely (`isResurveyDefect` in lib/metrics.cjs) —
  nothing was re-surveyed, so the survey did not fail. Doug's call 2026-08-06.
- Internal defects = Resurvey Attributed to SunPower Field or Radicl Agent

## Email generator password
Set via `const PASSWORD` in compose/index.html. Currently `sunpower`.
