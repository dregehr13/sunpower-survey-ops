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
- Metric definitions (DATA_CUTOFF, isComplete, isWIP, wipAgeFrom, ssDaysOpen/hasRepGrace/inRepGrace, avg/med/pct, hasResurveySig) live in `lib/metrics.cjs` — shared by index.html, compose/index.html, and api/morning-card.js. Change definitions there, nowhere else
- **Two different age metrics — don't conflate them:**
  - `wipAgeFrom(r)` returns the *anchor date* and drives cycle-time math (`ct_total`, `projCt`, `estComplete`). Never shift it — Spec 12744 reporting depends on it
  - `ssDaysOpen(r, asOf)` is the *queue triage* number shown as "Days Open in SS". It subtracts a **rep grace day**: when a rep elects to do the survey they have until the next calendar day before SS starts working it. Blank resource counts as rep (SF corrects it if untrue); only surveys that went straight to Radicl/SunPower with no `requested` skip the grace; open resurveys get none. `inRepGrace()` flags rows still in that first day — the WIP table shows a "Rep day" pill instead of a number
- `requested` is only populated when a rep declines, so it doubles as the rep→field/Radicl handoff date (~99% coverage on Radicl/SunPower Surveyor rows vs 13% on Sales Rep)
- Derived analytics also live in `lib/metrics.cjs`: businessDays (weekend rule), buildSegmentAvgs/lookupSegmentAvg, projectWeekTotal, bandFor (≤target/≤target+2 bands), trendLabel (TREND_BAND_AVG=0.1 dashboard avg-based, TREND_BAND_MED=0.3 compose median-based — two calculations on purpose)
- Tests: `npm test` (node:test, `test/metrics.test.js`) locks down every definition above — run it before changing metrics
- parse-sf.js prints a non-blocking import sanity report to stderr (backwards dates, dup ids, unknown resources, rep-name casing, stale schedules, row-count swings); push.sh surfaces it automatically
- Main cycle metric: **Project Start Date → Site Survey Complete** (`ct_total`). Other intermediate dates (requested, scheduled) exist in the data but are unreliable — don't feature them in UI
- No weekly goals — data was "vibe coded" by previous manager, not building that out
- No historical data — starting fresh with current SF export
- New fields must not break old rows (import defaults missing sfCols to `''`)
- Resurvey tracking is live (Resurveys tab: FPY, attribution, open queue). Per-survey resource still only covers the initial survey — future SF survey objects will fix that (see memory "Come back to" list)

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

## Targets (Spec 12744)
- Median: 3 days | Avg: 4 days
- Cycle times are **calendar days**, not business days (confirmed by Doug 2026-06-10)
- FPY = (Completions – Internal Defects) / Completions
- Internal defects = Resurvey Attributed to SunPower Field or Radicl Agent

## Email generator password
Set via `const PASSWORD` in compose/index.html. Currently `sunpower`.

## Change list (next build)
- (empty — FPY and resource breakdowns shipped; see memory "Come back to" list for deferred items)
