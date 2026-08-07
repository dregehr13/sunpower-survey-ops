# Survey Ops — Claude Code Context

## What this is
Internal ops dashboard + email generator for SunPower's Site Survey department.
Built by Doug Regehr (Site Survey Manager) to replace manual reporting done by David Richards (previous manager).

## Live URL
https://sunpower-survey-ops.vercel.app
Email generator: https://sunpower-survey-ops.vercel.app/compose

## People
- **Doug Regehr** — Site Survey Manager, the user. douglas.regehr@sunpower.com · 801-793-1861
- **Chelsea Herrin** — Doug's manager (as of July 2026). Chelsea.Herrin@sunpower.com. Default email recipient.
- **Allie Morais** — Site Survey Senior Lead. allie.morais@sunpower.com. Doug's direct lead. Default email recipient.
- **Spencer Jensen** — SVP Operations. spencer.jensen@sunpower.com. Reads emails in 45 seconds. Wants to know if there's a problem. (Not on default list as of July 2026.)
- **Rob Barker** — Director of Operations Pre-Install. robert.barker@sunpower.com. (Not on default list as of July 2026.)
- **David Richards** — Previous Site Survey Manager. Replaced by Doug. Used Albatross for reporting before Salesforce.

## Key architectural decisions
- Data is baked into HTML files as `const RAW = [...]` until Salesforce API is live
- Metric definitions (DATA_CUTOFF, isComplete, isWIP, everCompleted, effectiveComplete, wipAgeFrom, ssDaysOpen/hasRepGrace/inRepGrace, avg/med/pct, hasResurveySig, isResurveyDefect, isOpenResurvey) live in `lib/metrics.cjs` — shared by index.html, compose/index.html, and api/morning-card.js. Change definitions there, nowhere else
- **Two different age metrics — don't conflate them:**
  - `wipAgeFrom(r)` returns the *anchor date* and drives cycle-time math (`ct_total`, `projCt`, `estComplete`). Never shift it — Spec 12744 reporting depends on it
  - `ssDaysOpen(r, asOf)` is the *queue triage* number shown as "Days Open in SS". It subtracts a **rep grace day**: when a rep elects to do the survey they have until the next calendar day before SS starts working it. Blank resource counts as rep (SF corrects it if untrue); only surveys that went straight to Radicl/SunPower with no `requested` skip the grace; open resurveys get none. `inRepGrace()` flags rows still in that first day — the WIP table shows a "Rep day" pill instead of a number
- `requested` is only populated when a rep declines, so it doubles as the rep→field/Radicl handoff date (~99% coverage on Radicl/SunPower Surveyor rows vs 13% on Sales Rep)
- **SS Ratio has two variants in `lib/metrics.cjs` — they answer different questions, don't merge them:**
  - `ssRatioForWeek(rows, weekEnd)` — the reported weekly number (Trends line, Monday recap). WIP is the **7-day mean across the week**, not the Sunday close: intake spikes Fri/Sat (342 in vs 52 done) while Monday clears ~210, so a week-close snapshot samples the weekly maximum every time and overstates backlog by ~a third
  - `ssRatioLive(rows, asOf)` — "what's on my desk right now" for the WIP page card. Denominator anchors on `lastCompleteWeekEnd()` so a part-finished week can't deflate it. This one legitimately reads high on a Monday morning — that's the real queue before the day's clearing
  - Both count WIP with `isComplete()`. The old Trends line used `!r.complete`, which silently treated Holding/Reopened rows as finished and understated the ratio
  - Partial weeks are never plotted on the Trends line — the week end is in the future, so WIP counts every open row while the denominator averages in a barely-started week
  - `ssRatioBand()` is shared by both surfaces: **≤1.0 green, 1–2 uncoloured, ≥2.0 amber**. The 1–2 range is the normal operating band and is deliberately not coloured — intake arrives over the weekend while the team is off, so an elevated reading is usually the rhythm. Two weeks of backlog is the real alarm
  - Called "SS ratio" everywhere (was "Pipeline ratio" in places). Every KPI card across all six pages carries a hoverable definition via `kinfo(TIP.x)` — keep `TIP` in index.html as the single source for that wording
- **Backlog alarms** (`lib/metrics.cjs`, surfaced on Trends → Daily intake & clearance). The SS ratio is deliberately NOT an alarm — across 20 weeks it never exceeded 1.16, so any threshold either never fires or fires constantly:
  - `floorAlarm` — weekly floor (`weeklyFloor()`, WIP after the weekend buildup drains) above 1.5× `floorBaseline()` (median of the prior 16 weeks). The **early** signal: it moved a month before the ratio did. The 16wk window is deliberate — a short window absorbs a regime shift within a month and the alarm silences itself while the problem persists
  - `clearanceAlarm` — `rollingClearance()` (4wk completions ÷ starts) under 90% for two readings running. The **confirmation**: the 4wk figure held 89–103% for five months, so it is a tight baseline; the single-week version is useless (under 100% in 12 of 20 weeks)
  - Both thresholds are fit to this team's own 20-week history — they encode "unusual for us", not an industry standard. Revisit after a quarter
- Derived analytics also live in `lib/metrics.cjs`: businessDays (weekend rule), buildSegmentAvgs/lookupSegmentAvg, projectWeekTotal, bandFor (≤target/≤target+2 bands), trendLabel (TREND_BAND_AVG=0.1 dashboard avg-based, TREND_BAND_MED=0.3 compose median-based — two calculations on purpose)
- Tests: `npm test` (node:test) — three suites, run before changing any metric:
  - `test/metrics.test.js` — each function against hand-written cases
  - `test/snapshot.test.js` — every metric against a frozen real-data fixture (`test/fixtures/rows.json`, rebuilt by `scripts/build-fixture.cjs`). A definition change fails with a value diff; accept it deliberately with `UPDATE_SNAPSHOT=1 npm test`
  - `test/surfaces.test.js` — static cross-surface guards: no surface may reimplement the completion test, read a data.js const off `window`, band inline, redefine a shared definition, destructure a name metrics.cjs doesn't export, or leave a `TIP` entry unreferenced
- **`docs/METRICS.md` is the metric register** — every displayed number, its definition, and which surfaces read it. Update it when adding a metric
- parse-sf.js prints a non-blocking import sanity report to stderr (surveys predating the agreement, dup ids, unknown resources, rep-name casing, stale schedules, row-count swings); push.sh surfaces it automatically. It also **decodes HTML entities** — SF ships free text escaped, so offices arrive as `"Solar&#39;s Dead" - Dragons`
- **Sales office is a global filter** alongside Region, applied through `gfDim` so it reaches every page. Both the filter and the Resurveys breakdown hide/fall back on exports predating 2026-08-06, which have no office field
- Main cycle metric: **Project Start Date → Site Survey Complete** (`ct_total`). Other intermediate dates (requested, scheduled) exist in the data but are unreliable — don't feature them in UI
- No weekly goals — data was "vibe coded" by previous manager, not building that out
- No historical data — starting fresh with current SF export
- New fields must not break old rows (import defaults missing sfCols to `''`)
- **Resurveys page** (rebuilt 2026-08-06). Reads as quality first, then queue: FPY + a weekly yield chart, why they come back, who is at fault, breakdowns, then the open queue. Things not to undo:
  - One population — `isResurveyDefect` for yield everywhere on the page. It used to run a second local definition alongside it, so "Total Resurveys" read 385 while FPY counted 434 on the same screen
  - It has **no time control of its own**. A `Date Range / Currently Open` toggle used to blank every FPY figure and delete the By Sales Rep section with nothing explaining why. The filter bar owns time
  - The yield chart marks weeks under `RS_MATURE_DAYS` (21) as provisional. Defects keep arriving for weeks — only 57% within 7 days, p90 41 — so recent weeks read high. A single trend arrow was tried and removed: it reported "down 7.7 pts" during the clearest improvement in the data
  - `resurvey_reason` is the actionable field (96% populated; 66% is "Survey Incomplete"), and `resurvey_details` names the specific missing photo or measurement on 92% of those
  - Default breakdown is **sales office**, toggleable to region
  - **Daily intake lives on Current, not here** (`renderRsReq()`, added 2026-08-07): "Resurveys requested", left column, Mon–Sun by request date, expandable per day to the reason + `resurvey_details`, following the Last Week / This Week toggle. It anchors on `resurvey_requested` — the only thing on Current that does — and it keeps Unnecessary Request rows, greyed, because it is an inbox rather than a yield measure
  - Per-survey resource still only covers the initial survey — future SF survey objects will fix that (see memory "Come back to" list)
- **Map page** (added 2026-08-06). All markets by town, four modes (Volume / Open WIP / Cycle / Resurvey), click a state nationally to open that market:
  - Location comes from the **ZIP in `address`, never `region`** — region is a sales territory, not a place, and reading the address also places the ~71 rows whose region is blank
  - Grouped by **town**, not ZIP: a ZIP is a postal artefact that split Glen Allen into two dots and buried Richmond's eight ZIPs entirely
  - It has **no time control of its own** either — same rule as Resurveys, and for the same reason (a stale scrubber once showed 167 jobs against a filter selecting 2458)
  - Geography lives in `geo/` (ZIP centroids, CONUS state outlines, top-1k cities, per-state counties), generated by `scripts/build-geo.cjs` and committed. Fetched on demand, never baked into the HTML — the page derives from data.js, which push.sh rewrites daily. Sources cache in `geo/.src` (gitignored). Rerun the script when a market opens in a state with no counties file
  - The old standalone `/va-map` is retired and redirects to `/#map`

## Morning workflow
1. In Salesforce: run the Site Survey report → Export → Details Only → Excel format → save to Downloads
2. Terminal: `~/Projects/survey-ops/push.sh`
   - Finds the latest `report*.xls` in Downloads automatically
   - Parses it via `parse-sf.js`, writes data.js + data.json
   - Commits and pushes → Vercel auto-deploys in ~30s
3. For code-only deploys (no data update): `git push`

Note: Fully automated fetching was attempted but abandoned — Salesforce MFA
triggers on every untrusted session and Chrome 134+ blocks CDP on the default
profile. Manual export + push.sh is the reliable workflow until the SF API
ticket is resolved.

## Salesforce fields (all live as of July 2026)
`resource`, `survey_type`, `resurvey_reason`, and `resurvey_attributed` are all
active in the FIELDS registry in index.html. FPY, attribution, and resource
breakdowns are built and shipping on the dashboard (Resurveys + Performance pages).

Added 2026-08-06 (Doug widened the SF report): `agreement_signed`,
`sales_office`, `m1a_approved`. All parsed and registered. `sales_office` is
live in the UI (global filter + default Resurveys breakdown); the other two are
context only and no UI reads them.
- **`agreement_signed` does NOT become the cycle-time anchor.** Cycle time stays
  on Project Start because that is when the job enters the Site Survey queue,
  which is what this team is accountable for. Agreement Signed is *context*:
  100% populated, same day as start on 87% of rows, and never later than it.
  Its job is explaining the 42 rows whose survey completes one day **before**
  project start — on 40 of those 42 the agreement was signed the same day the
  rep surveyed, and the project record starts the next morning. Those are not
  data errors and must not be "fixed". Only 3 rows are genuinely backwards
  (175–231 days), and those are cancelled accounts re-signed later whose
  original survey was still good — `effectiveComplete()` measures their cycle
  to the agreement date, giving zero, which is right: no survey work was
  needed. The concept does not apply to resurveys at all.
- `sales_office` is ~169 distinct values against 58 sales regions, and unlike
  `region` it is a real org unit rather than a geography stand-in. Yield across
  offices with 25+ completions runs 71% to 94% — a wider and more actionable
  spread than the same cut by region.
- `m1a_approved` is a downstream approval, not a booking date: median 0 days
  from project start and *earlier* than start on 43% of rows.

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

## Change list (next build)
- Doug is tagging ~19 accounts in SF as "Unnecessary Request" — bare
  `reopened_by_design` flags with no reason, no dates and review notes reading
  "RESURVEY NOT NEEDED". They fall out of FPY automatically once tagged
  (83.3% → ~84.1%); no code change needed
- Doug is backfilling the ~74 resurveys with no `resurvey_attributed`
- Not built, raised and parked: `survey_type` is unused everywhere and Battery
  Only surveys yield 75.8% against 84.1% for the rest (n=33, thin); the
  By Resource card mixes initial-survey FPY with resurvey cycle time and should
  say so; several dismissed requests were Design asking for utility bills or
  ownership docs, which is a Design-process conversation rather than a survey
  failure — worth quantifying once the tagging is done
