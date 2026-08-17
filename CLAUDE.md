# Survey Ops — Claude Code Context

## What this is
Internal ops dashboard + email generator for SunPower's Site Survey department.
Built by Doug Regehr (Site Survey Manager) to replace manual reporting done by David Richards (previous manager).

## Live URL
https://sunpower-survey-ops.vercel.app
Email generator: https://sunpower-survey-ops.vercel.app/compose

## Pages
Current · WIP · Performance · Trends · Quality · Map. WIP sits second because
it is the page the manager sits in; the order changed 2026-08-17.
**"Quality" is the nav label only** — the page id, the `#resurvey` hash, the
`renderResurvey()` function and every drill title are still `resurvey`, so
bookmarks and the Settings default-page picker keep working. Don't rename the id.

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
  - **compose's Monday chart line is `ssRatioForWeek` too.** It used to compute its own `wipEow / avgC` inline — the end-of-week definition this replaced — so the SS RATIO card and the line directly beneath it disagreed by up to 38% (week of 2026-08-02: card 1.02, line 1.41). Fixed 2026-08-14
  - **`api/generate.js` must describe the band correctly to Claude.** It said "ratio >1 is a concern" and passed the end-of-week WIP as the numerator, which had the model calling an ordinary week a problem. It now passes `stats.meanWip` and states ≤1 healthy / 1–2 normal / 2+ alarm
- **Backlog alarm** (`lib/metrics.cjs`, surfaced on Trends → Daily intake & clearance). The SS ratio is deliberately NOT an alarm — across 20 weeks it never exceeded 1.16, so any threshold either never fires or fires constantly:
  - `clearanceAlarm` — `rollingClearance()` (4wk completions ÷ starts) under 90% for two readings running. The 4wk figure held 89–103% for five months, so it is a tight baseline; the single-week version is useless (under 100% in 12 of 20 weeks). Threshold is fit to this team's own 20-week history — encodes "unusual for us", not an industry standard. Revisit after a quarter
  - `weeklyFloor()` is the lowest daily WIP across the week (Mon–Sun) — shown on the same card, no alarm attached. It used to sample a single day (the Monday after the weekend buildup drains) on the assumption that was always the week's low point; a sustained backlog climb broke that (WIP kept rising Mon→Sun rather than draining), so it was redefined 2026-08-07 to take the actual weekly minimum
  - `floorAlarm`/`floorBaseline` (weekly floor above 1.5× the trailing 16-week median) were dropped from the UI the same day — that design assumed a stable baseline with occasional spikes, but the trailing median chases a sustained multi-month climb instead of anchoring it, so the alarm flickered true/false with no real change in trajectory. Functions remain in `lib/metrics.cjs`, tested, pending a redesign that detects sustained direction (e.g. consecutive rising weeks) rather than a threshold vs. recent history
- Derived analytics also live in `lib/metrics.cjs`: businessDays (weekend rule), buildSegmentAvgs/lookupSegmentAvg, projectWeekTotal, bandFor (≤target/≤target+2 bands), trendLabel (TREND_BAND_AVG=0.1 dashboard avg-based, TREND_BAND_MED=0.3 compose median-based — two calculations on purpose)
- Tests: `npm test` (node:test) — three suites, run before changing any metric:
  - `test/metrics.test.js` — each function against hand-written cases
  - `test/snapshot.test.js` — every metric against a frozen real-data fixture (`test/fixtures/rows.json`, rebuilt by `scripts/build-fixture.cjs`). A definition change fails with a value diff; accept it deliberately with `UPDATE_SNAPSHOT=1 npm test`
  - `test/surfaces.test.js` — static cross-surface guards: no surface may reimplement the completion test, read a data.js const off `window`, band inline, redefine a shared definition, destructure a name metrics.cjs doesn't export, or leave a `TIP` entry unreferenced
- **`docs/METRICS.md` is the metric register** — every displayed number, its definition, and which surfaces read it. Update it when adding a metric
- parse-sf.js prints a non-blocking import sanity report to stderr (surveys predating the agreement, dup ids, unknown resources, rep-name casing, stale schedules, row-count swings); push.sh surfaces it automatically. It also **decodes HTML entities** — SF ships free text escaped, so offices arrive as `"Solar&#39;s Dead" - Dragons`
- **Sales office is a global filter** alongside Region, applied through `gfDim` **and `applyFilter`** so it reaches every page. It only ever lived in `gfDim`, which meant Performance — the one page reading `filtered` — showed an active button, a chip and identical numbers (fixed 2026-08-14). Both the filter and the Resurveys breakdown hide/fall back on exports predating 2026-08-06, which have no office field
- **One label scale, every page** (added 2026-08-17). A single 10px uppercase `.05em` style used to do four jobs at once, so four ranks of information read as one. The seven roles: section/KPI label 11/600/.07em uppercase `--muted` · panel title 13/700 sentence `--text` · panel subtitle 11/400 `--faint` · table header 11/700 sentence `--muted` · chart legend 11/400 `--muted` · axis tick 10/400 `--faint` · footnote 10/400 `--faint`. **10px survives only as axis ticks and footnotes**
- **Hover means "this opens something"** (added 2026-08-17). Lift and shadow are reserved for it — `.drill-tgt` cards and the `.wip-expand` caret. Panels (`.sec`) and plain KPI cards have no hover state at all; `.pill` does not scale (most pills are status readouts in table cells, not controls); filter chips darken their border one step with no transform. Row hover is one value, `var(--bg)`, not the three off-whites it was
- **One filter bar, every page** (`buildFBar`). WIP used to render a private bar against its own `wipF`, so a region chosen on Performance did not carry over and Office could not reach it at all. Region / Office / Status / Resource are shared; **Sales Rep and Install Type are WIP-only extras** in `wipF`, since nothing else cuts by either. WIP shows **no date range** — it is a live queue, and the hint says so. Don't reintroduce a second bar
- **There is no global Install Type filter.** `type` had filter state, a `gfDim`/`applyFilter` clause and a `?type=` URL param but no control anywhere, so a shared link could filter every page invisibly. Removed 2026-08-14; `FIELDS.type` is `filterable:false`. The WIP page's Type control is separate state
- **The WIP page's stat rail and bars follow the page filter**, not just the table. They read `wipFiltered()`; the SS ratio takes both numerator and denominator from `wipScoped()` so it never divides one population by another. Filtering to a region with no recent completions correctly shows "—", not a national figure
- **The WIP page is a stat rail + one queue panel** (rebuilt 2026-08-17):
  - Rail cells: Open now · Avg age · Over 15 days · Unscheduled · Open resurveys · SS ratio. Median age and On-track ≤4d were dropped with the five KPI cards. Cell padding must stay **uniform** — trimming the first and last cell's inner padding makes those two 18px narrower, because `flex-basis:0` sizes the content box and padding is added on top of an equal share rather than taken out of it. Active/hover state on the three filter cells therefore rides on background and an **inset** box-shadow: a border or a padding change would resize just that cell
  - **Three rail cells filter the queue** (2026-08-17): Over 15 days, Unscheduled and Open resurveys. Each drives a control that already exists below it — the age bands, the Unscheduled bracket, the view toggle — so the rail is a shortcut into the queue, not a fourth filter vocabulary, and clicking one lights up its twin below. The other three cells are readouts and stay inert
  - "Over 15 days" is **project age ≥15**, not >15, so it agrees with the 15–30d band directly beneath it. The threshold is read off `PA_MINS[WIP_OVER_BANDS[0]]` rather than written twice, so the number the cell shows and the bands its click selects are the same rows **by construction**. Moving it means moving `WIP_OVER_BANDS` to another band boundary — a cell reading "over 20 days" would have no band to select and would filter to something other than what it counted
  - The Unscheduled cell tests and selects only the unscheduled statuses that **have rows**, the same list the bracket uses and the list `wipQsSel` gets pruned to. Testing all of `QS_UNSCHED` meant the cell could never light up, because Likely cancel is empty most days
  - **Two filter rows, never three.** Schedule and Status are one hierarchy, not two dimensions: `wipQueueStatus()` reads the same `wipSchedDate` field `schedStatus()` does, returns Scheduled and Past due for the same two cases, then subdivides the third. Live data: Scheduled 55 / Past due 1 / Unscheduled 57 against chips of 37+2+7+5+6 = 57 — exact by construction. ANDing a Schedule row against a Status row returns zero rows for most pairs. The status bar carries the whole vocabulary in schedule order instead
  - **"Everything unscheduled" is a bracket under the bar**, not a legend group. A container around five of eight legend chips makes one wrapped line read as a different kind of object. The bracket also shows how much of the queue is unscheduled, which a legend box cannot. It aligns by `calc()` — the bar mixes fixed 2px gaps with proportional segments, so a mirrored flex row drifts
  - Age bands and status chips **cross-narrow**: each row counts within the other's selection, so no combination is ever offered that filters to nothing
  - Table is 8 columns; Reviewed By folds into Last reviewed as `Aug 14 · S. Mertz`. **`last_reviewed_date` is a timestamp, not an ISO date** — `fmtDateShort()` splits on `-` and prints "undefined NaN". Use `fmtReviewDay()`
  - Whole-row red/amber tinting is gone: the Open in SS figure and the status badge already carried it twice
  - The **"Rep day" pill stays.** The handoff has no slot for it, but printing `0d` would misreport whose clock is running
  - Under 640px rows stack two-line rather than scrolling sideways
- **The nav badge beside WIP is the open count**, neutral grey. It was the "needs attention" count until 2026-08-17, when that whole concept came out: `attnItems()`, `attnKey()`, `dismissAttn()`, the per-row "Reviewed ✓" buttons and the `ops_dismissed` localStorage store are gone. It was a saved filter dressed as a view — every row it held is reachable from Past due plus the age bands — and the dismissals made the badge disagree with Salesforce for anyone who had clicked one. Its toggle slot went to **Open resurveys**, a population with no live home before then. Grey, not red: an open queue is the normal state, and a red badge on every page load teaches you to ignore red
- Main cycle metric: **Project Start Date → Site Survey Complete** (`ct_total`). Other intermediate dates (requested, scheduled) exist in the data but are unreliable — don't feature them in UI
- No weekly goals — data was "vibe coded" by previous manager, not building that out
- No historical data — starting fresh with current SF export
- New fields must not break old rows (import defaults missing sfCols to `''`)
- **Quality page** (rebuilt 2026-08-06, restructured 2026-08-17). Reads as quality first, then queue: FPY + a weekly yield chart, why they come back, who is at fault, breakdowns, then the open queue. Things not to undo:
  - One population — `isResurveyDefect` for yield everywhere on the page. It used to run a second local definition alongside it, so "Total Resurveys" read 385 while FPY counted 434 on the same screen
  - It has **no time control of its own**. A `Date Range / Currently Open` toggle used to blank every FPY figure and delete the By Sales Rep section with nothing explaining why. The filter bar owns time
  - The yield chart marks weeks under `RS_MATURE_DAYS` (21) as provisional. Defects keep arriving for weeks — only 57% within 7 days, p90 41 — so recent weeks read high. A single trend arrow was tried and removed: it reported "down 7.7 pts" during the clearest improvement in the data
  - `resurvey_reason` is the actionable field (96% populated; 66% is "Survey Incomplete"), and `resurvey_details` names the specific missing photo or measurement on 92% of those
  - Default breakdown is **sales office**, toggleable to region
  - **Daily intake lives on Current, not here** (`renderRsReq()`, added 2026-08-07): "Resurveys requested", left column, Mon–Sun by request date, expandable per day to the reason + `resurvey_details`, following the Last Week / This Week toggle. It anchors on `resurvey_requested` — the only thing on Current that does — and it keeps Unnecessary Request rows, greyed, because it is an inbox rather than a yield measure
  - Per-survey resource still only covers the initial survey — future SF survey objects will fix that (see memory "Come back to" list)
  - **Yield hero** (300px) replaced the four-KPI strip: FPY at 52px, the sentence, a progress track with the 95% target marked *on* it, then Cost of a resurvey / Resurvey cycle / Median as a definition list. Under `RS_MIN_CELL` completions it prints `n=` rather than a confident percentage
  - **The yield chart is temporarily built in two forms** behind a Bars/Trend toggle (`rsChartMode`), pending Doug's decision. They share one target rule and one immature-week convention. The tradeoff: bars must sit on a zero baseline, so 0–100% flattens a series living between 80 and 95, while the line auto-scales and shows the variation — which is the argument the 4-week rolling average was added to win. **Delete the loser once chosen**
  - **Resurvey rate by group** heads the region/office section and follows its toggle; the detail table beneath is "<group> detail" and no longer carries its own. One ranking of one fact, not two
  - Rate bands are the **mirror of `fpyPill`**: <5% green, 5–15% amber, 15%+ red, ceiling line at 5% because the target is 95%. At a 15.6% national rate most groups read red — that is the honest reading against a 95% target, not a scale fault
  - **No "worst office per region" column**, though the handoff specifies one: only 2 of 28 regions contain an office clearing the 10-completion floor, so it would be blank on most rows, and filling it from n=3 would name a real org unit off noise. The column carries the sample size instead, so no rate is read without its n
  - **Reasons sit left of attribution.** Attribution is the more tempting panel and the less actionable one
  - **Status is not in this page's filter bar** — every row here is already complete
  - "Open now" is not on this page. It was a live count sitting under a date filter it ignored; it lives on the WIP rail as Open resurveys, and the WIP queue's second view lists exactly those rows
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

## The drill drawer (rebuilt 2026-08-17)
One drawer serves ~30 entry points across all six pages. Things not to undo:
- **Columns come from `drillCols()`, one spec list per mode** — header, sort,
  cells and copy all read from it. They used to be four separate template
  strings, which is exactly why nothing could be sorted: there was nothing to
  sort by. Adding a column means adding one spec, not editing four places
- **Sorting and grouping are alternatives, not layers.** Picking a column
  flattens a grouped (byDate / groupBy) view and the count line says so — a
  sort inside 40 day-groups answers a question nobody asked
- **Open-resurvey drills swap Cycle for Scheduled + Days open**, and open
  sorted oldest-first. `ct_resurvey` is null on every open resurvey, so that
  column was 42 dashes while the two facts you work the queue from were absent
- **Blanks sink in both sort directions.** A column of dashes at the top is
  never the answer to "sort by this"
- Search covers fields the active mode does not show, so the same query finds
  a rep whether or not Sales Rep is a column; matches highlight with `<mark>`
- **Copy is built from the specs, not scraped off the DOM.** Grouped views
  paste with a real Resource/Day column instead of ragged one-cell header rows,
  and the clamped details cell copies in full
- It is a real dialog: `role`/`aria-modal`/`aria-sort`, focus in on open and
  back on close, Tab trapped. Escape already closed it
- **`drillScopeNote()` states what scoped the population** — some entry points
  read `filtered` (date range applies), some read live rows (it does not), and
  that was invisible from inside. It prints "all dates" when the picker holds
  the dataset's own span, and carries years on cross-year ranges: `fmtDateShort`
  drops the year, so a 12-month range once printed as "Aug 8 – Aug 14"
- **No contact details in the drawer** — Doug's call 2026-08-17. The SF link on
  the project name is the way out to a phone number. The WIP row expand is the
  one place that carries contacts, because that is the page you work from
- Charts that drill share `drillHover` for the pointer cursor. Half of them
  were clickable with no cue
- **Not everything gets a drill.** Best week on Trends was built and removed
  the same day: "which surveys were in our highest-volume week" drives no
  decision, and that week's completions are already one click away in the
  Weekly detail table. Trend (3wk) and Avg weekly pace have no single
  population to open. A drill costs a hover-lift, which this app spends only
  on things worth opening

## Change list (next build)
- **Pick a yield-chart form on Quality** (Bars vs Trend) and delete the other,
  along with `rsChartMode`. Built both 2026-08-17 so the shape could be judged
  on real data rather than on the handoff's sample numbers
- The 5% resurvey-rate ceiling paints nearly every sales office red at the
  current 15.6% rate. Correct against a 95% target, but worth a look before it
  is treated as settled
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
