# Survey Ops — Claude Code Context

## What this is
Internal ops dashboard + email generator for SunPower's Site Survey department.
Built by Doug Regehr (Site Survey Manager) to replace manual reporting done by David Richards (previous manager).

## Live URL
https://sunpower-survey-ops.vercel.app
Email generator: https://sunpower-survey-ops.vercel.app/compose

## People
- **Doug Regehr** — Site Survey Manager, the user. Email: douglas.regehr@sunpower.com, Phone: 801-793-1861
- **Allie Morais** — Site Survey Senior Lead. allie.morais@sunpower.com. Doug's direct lead. Primary email recipient.
- **Spencer Jensen** — SVP Operations. spencer.jensen@sunpower.com. Reads emails in 45 seconds. Wants to know if there's a problem.
- **Rob Barker** — Director of Operations Pre-Install. robert.barker@sunpower.com. Email recipient.
- **David Richards** — Previous Site Survey Manager. Replaced by Doug. Used Albatross for reporting before Salesforce.
- **Kody Wilde** — Was on David's email list, not on Doug's.

## Key architectural decisions
- Data is baked into HTML files as `const RAW = [...]` until Salesforce API is live
- Metric definitions (DATA_CUTOFF, isComplete, isWIP, wipAgeFrom, avg/med/pct, hasResurveySig) live in `lib/metrics.cjs` — shared by index.html, compose/index.html, and api/morning-card.js. Change definitions there, nowhere else
- Main cycle metric: **Project Start Date → Site Survey Complete** (`ct_total`). Other intermediate dates (requested, scheduled) exist in the data but are unreliable — don't feature them in UI
- No weekly goals — data was "vibe coded" by previous manager, not building that out
- No historical data — starting fresh with current SF export
- New fields must not break old rows (import defaults missing sfCols to `''`)
- Only initial surveys for now — no resurvey tracking until Resource/Type of Survey fields are in SF

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

## Pending Salesforce fields (IT ticket in progress)
When these arrive, uncomment them in FIELDS registry in index.html:
- `resource` — who does the survey (Sunpower Surveyor / Sales Rep / Radicl)
- `survey_type` — kind of survey (Site Survey / Battery Only Survey / Resurvey)
- `resurvey_reason`, `resurvey_attributed` — FPY calculations

## Targets (Spec 12744)
- Median: 3 days | Avg: 4 days
- Cycle times are **calendar days**, not business days (confirmed by Doug 2026-06-10)
- FPY = (Completions – Internal Defects) / Completions
- Internal defects = Resurvey Attributed to SunPower Field or Radicl Agent

## Email generator password
Set via `const PASSWORD` in compose/index.html. Currently `sunpower`.

## Change list (next build)
- Resource breakdown on Regions page (auto-shows once `resource` field is active)
- FPY + Absolute FPY metrics (needs `resurvey_attributed` field)
