# Metric register

Every number the app displays, where it is defined, and which surfaces read it.
The point of this document is to make **drift visible**: when the same concept is
computed in two places, it eventually disagrees. That has happened three times
(three SS ratios differing 34% on one week; a completion test that ignored List
status for five months; a colour band that disagreed with the number beside it).

**All definitions live in `lib/metrics.cjs`.** Surfaces destructure from
`OpsMetrics` and must not redefine them — `test/surfaces.test.js` enforces this.

## Surfaces

| surface | file | what it renders |
|---|---|---|
| Dashboard | `index.html` | Current / WIP / Performance / Trends / Quality / Map / Billing / Data / Settings |
| Compose | `compose/index.html` | Monday recap + daily email |
| Morning card | `api/morning-card.js` | Teams card (not adopted — see CLAUDE.md) |

## The metrics

### Scope & classification

| metric | definition | trap |
|---|---|---|
| `DATA_CUTOFF` | `2025-12-29`; all charts and row filters start here | — |
| `effectiveComplete(r)` | `agreement_signed` when the survey completed **before** it, else `complete` | Cycle time measures against this, not the raw date. A cancelled account re-signed months later keeps its original survey; the row carries a real completion 175–231 days before the new agreement, which is correct data and must not be "fixed" in SF. The survey was in hand when the job entered the queue, so the cycle is zero. Fires on 5 rows; a no-op for the 42 same-day rep surveys, whose `complete` equals `agreement_signed` rather than preceding it |
| `agreement_signed` | the customer's signature date, 100% populated | **Not the cycle-time anchor** — `ct_total` stays on `start`, which is when the job reaches the SS queue. Same day as `start` on 87% of rows and never later. Explains the 42 rows completing a day before start: the rep signed and surveyed the same day, and the project record starts the next morning. Meaningless for resurveys |
| `inScope(r)` | started ≥ cutoff **and** (complete **or** project active) | a finished survey counts even on an At-Risk/Canceled project; a *non-finished* one on such a project does not |
| `filterRows(raw)` | `inScope` + `normalizeName` on `sales_rep` | the only correct entry point — never filter raw rows by hand |
| `isComplete(r)` | completion date **AND** `list === 'Complete'` | **48 rows carry a date but are Holding/Reopened.** A bare `r.complete` test counts them as finished |
| `isWIP(r)` | `start` and not `isComplete` | complete + WIP partition the scoped rows exactly |
| `everCompleted(r)` | completion date, **regardless of current `list`** | first-time completion — for "how many closed out in week X", which must not shrink when a completed survey is later reopened for resurvey. Not a substitute for `isComplete` in WIP/backlog math |
| `normalizeName(n)` | title-cases fully-uppercase reps; keeps roman numerals | SF exports the same rep in mixed casings, splitting their stats |

### The two age metrics — never interchangeable

| metric | definition | used for |
|---|---|---|
| `wipAgeFrom(r)` | **anchor date**: resurvey request → completion +2d → project start | cycle-time math: `ct_total`, `projCt`, `estComplete`. **Never shift it** — Spec 12744 depends on it |
| `ssDaysOpen(r, asOf)` | days the survey has been SS's, = anchor → asOf **minus one rep grace day** | queue triage, the "Days Open in SS" column, attention rules |
| `hasRepGrace(r)` | blank resource counts as rep; straight-to-field skips it; open resurveys get none | `requested` is the rep→field handoff marker (99% coverage on Radicl/SPWR vs 13% on Sales Rep) |
| `isResurveyDefect(r)` | `hasResurveySig` **and** the reason picklist does not say "Unnecessary Request" | What counts against yield. A request raised and then dismissed is not a survey failure — nothing was re-surveyed — so those rows are excluded from the Resurveys page **entirely**, not merely from the percentage. FPY 81.3% → 83.3%. Keep `hasResurveySig` for "did a resurvey happen at all": cohorts, drill segments, the open queue |
| `fpy(completions)` | `(completions − isResurveyDefect) ÷ completions × 100`, or `null` on an empty set | First Pass Yield per Spec 12744. Takes an already-scoped array — the caller owns the population, this owns only the ratio. **Weighted, never a mean of rates**: the 4-week rolling line pools the window's rows in one call, because averaging four weekly percentages lets a 6-completion week pull as hard as a 130-one. Returns `null` rather than 0 on no completions — "no data" is not "perfect yield", and 0 would colour the card red. Lived inline in **eight** places before 2026-08-07 (six in `renderResurvey`, plus `lwFpy`/`pwFpy` on Current); `test/surfaces.test.js` now fails on any inline copy |
| `isOpenResurvey(r)` | resurvey requested, no resurvey-complete date, **and `list !== 'Complete'`** | **18 rows were resolved without the Resurvey Complete Date ever being filled in.** Testing only the dates counts those as still open. Powers the drill-drawer chips, the WIP schedule date, and the Resurveys open queue |
| `inRepGrace(r, asOf)` | still inside the rep's first day | WIP table shows a "Rep day" pill instead of a number |

"Proj Age" (`start → today`) is a *third* number, computed inline on the WIP page.
It is total elapsed age regardless of owner — use it for the age-distribution bar,
never for queue triage.

### SS ratio — two variants, deliberately

| metric | numerator | denominator | answers |
|---|---|---|---|
| `ssRatioForWeek(rows, weekEnd)` | **7-day mean WIP** across the week | 3 most recent complete weeks | "where did week N end" — Trends line, Monday recap |
| `ssRatioLive(rows, asOf)` | WIP right now | 3 weeks ending `lastCompleteWeekEnd()` | "what's on my desk today" — WIP page card |
| `ssRatioBand(v)` | ≤1.0 good · 1–2 uncoloured · ≥2.0 alarm | | shared by both surfaces |

The weekly numerator is a **mean, not a Sunday close**: intake keeps arriving
Fri/Sat while the team is off, so a week-close snapshot samples the weekly
maximum every time and overstates backlog by roughly a third.

Partial weeks are never plotted — the week end is in the future, so WIP counts
every open row while the denominator averages in a barely-started week.

### Flow & alarms

| metric | definition | notes |
|---|---|---|
| `rollingClearance(rows, weekEnd, 4)` | completions ÷ starts over 4 weeks | volume-normalised; the 1-week version is noise (under 100% in 12 of 20 weeks) |
| `weeklyFloor(rows, weekEnd)` | lowest daily WIP across the week (Mon–Sun) | used to assume Monday was always the low point (day after weekend buildup drains); a sustained backlog climb broke that — WIP now often keeps rising all week, so Monday could sit above the real minimum. Fixed 2026-08-07 to take the actual min |
| `clearanceAlarm(series)` | 4-wk clearance <90% twice running | confirmation |

`floorAlarm`/`floorBaseline` (trailing 16-week median × 1.5) were dropped from
the UI 2026-08-07 — the design assumed a stable baseline with occasional
spikes, but against a multi-month sustained climb the trailing median chases
the trend and the alarm flickered true/false with no real change in
trajectory. Functions remain in `lib/metrics.cjs` (tested) pending a redesign
that detects sustained direction instead of a threshold vs. recent history.

The clearance threshold is fit to this team's own 20-week history — it encodes
"unusual for us", not an industry standard. Revisit after a quarter.

### Cycle time & projection

| metric | definition |
|---|---|
| `avg` / `med` / `pct` | ignore null/negative/NaN; `avg` keeps **2dp** |
| `bandFor(v, target)` | ≤target good · ≤target+2 mid · else bad, **on the displayed value** |
| `queueAgeBand(d, targetAvg)` | ≤target good · ≤target+3 mid · else bad. For how long something has been **open**, not how long it took — hence +3 where `bandFor` uses +2. Bands the raw day count, since `ssDaysOpen` returns whole days |
| `buildShowRates(rows, asOf)` | measured per-resource completion-within-1-day rate; ≥5 samples, else global |
| `buildExpectedCt(recent)` | rep's own avg (≥3) → region\|resource segment → global |
| `projectWeekTotal(...)` | per-row: scheduled contribute show-rate, unscheduled contribute `min(daysLeft/ct, 1)` |
| `weekDaysRemaining(iso)` | fractional days left Mon–Sun; export day counts as half |
| `trendLabel(cur, prev, band)` | `TREND_BAND_AVG` 0.1 (dashboard) vs `TREND_BAND_MED` 0.3 (compose) — two calculations on purpose |
| Market clustering | `lib/coverage.cjs` `clusterByRadius()` → Map page | **Replaced grouping by town, 2026-08-25.** Town grouping made 833 places out of 2,446 jobs with 470 holding a single job and 73% holding two or fewer — a map of postal names, not of markets, and unable to answer the question the map exists for. A market is every job within a chosen radius of a densest seed, so it is literally "what one surveyor could cover from one base"; its centroid is therefore where a base would sit. Radius is a control (15/25/35mi, default 25) because it is a judgement call, not a constant. Greedy densest-seed, **not** k-means (no k is known — the count is the answer) and **not** DBSCAN (chaining would run Philadelphia into Allentown along a continuous suburb corridor). Deterministic on stable input order, so a market never renames itself between renders. A lat/lon grid picks which pairs to measure — 110ms of all-pairs haversines down to 17ms — and a test asserts the grid returns exactly what all-pairs would |
| Surveyor capacity | `lib/coverage.cjs` `jobsPerDayExact()` / `jobsPerDay()` / `weeklyCapacity()` / `dayBudget()` | A named-minutes budget rather than a lookup: `fieldHoursPerDay·60 − dailyOverheadMinutes − (2 × drive to market) − per job (onSiteMinutes + adminMinutesPerJob + hop)`. Written as a budget so every capacity figure decomposes back into minutes and can be argued with knob by knob. Defaults calibrated to Doug's observed ceiling — 3/day when tight, 2/day at 10–35mi, 1/day past 45 — and every one is overridable per surveyor. `ROAD_FACTOR` 1.3 converts straight-line to road miles: a stated assumption in one named place, not a measurement. **`weeklyCapacity` multiplies the EXACT daily rate, not the floored one** — flooring per day then multiplying charged a 2.9 job/day market as 10 a week when it runs ~14.5, understating close-in markets by a third |
| Invoice unit cost | `lib/billing.cjs` `VENDORS` → Billing page | Per-vendor spec, never hardcoded in the rules — a test asserts nothing below the vendor registry names a vendor or its price. Radicl: $20/credit, 14.2 credits ($284) for a survey visit, 9 credits ($180) travel adder beyond ~50mi. **Base, Partial Survey and Go Back all bill at the same 14.2** — a partial and a repeat cost exactly what a completed first survey costs, which is the most important and least visible fact on the invoice |
| All-in cost per survey | `lib/billing.cjs` `summarize()` → Billing rail | Total invoiced ÷ billed survey visits, so travel adders and demobilisation are inside it. Reads **$390** against a $284 base rate. This is the figure to compare an in-house surveyor against; the base rate alone understates by 37% |
| Cleanup cost | `lib/billing.cjs` `isCleanup()` → Billing | Return visits to finish a survey another resource started, billed at the full first-visit rate. 62 lines / $17,608 on the first statement (22% of spend), of which 47 of 49 matched rows had a **Sales Rep** original, median 19 days later. Classified `info`, not a dispute — it is not billable-in-error, it is what an incomplete first survey costs, and the invoice is the only place it is recorded |
| Own-defect rework | `lib/billing.cjs` `isOwnDefectRebill()` → Billing | Requires **both** `resurvey_attributed === 'Surveyor'` **and** `resource === vendor.sfResource`. Attribution alone is not enough: a rep-performed survey is also attributed to "Surveyor", meaning the rep. Reading attribution by itself turned 1 real case into an apparent 4 on the first live statement, and a test pins the distinction |
| Duplicate vs repeat visit | `lib/billing.cjs` `reconcile()` → Billing | A first visit followed by a return is a **sequence** (`repeat_visit`, info), not a duplicate — flagging Base→Go Back as a duplicate cried wolf on every legitimate return. `duplicate_charge` fires only on the same account billed the **same charge type** twice; `cross_statement` on an identical account+type+date arriving from two different statements. The second rule is the whole reason `billing.json` accumulates rather than being replaced |
| Cost per account | `lib/billing.cjs` `byAccount()` → Billing "Cost per account" | Sums every charge line an account drew — survey plus any travel adders, cleanup or rework — into one total, keyed on `accountKey()` (last name + street number, stable against name-order and formatting differences between the invoice and Salesforce). Not an average: an account with three travel adders and three surveys reads its true total, not a per-survey figure that hides the count |
| Billing state | `index.html` `_billState()` / `_billAcctState()` | Read off the matched Salesforce row's address with `MAP_ZIP_RE`, the same ", ST ZIP" capture the Map page uses — a statement's own address column carries no state. A charge line with no Salesforce match has no known state and shows "—" rather than a guess |


## Invariants the tests enforce

`test/metrics.test.js` — each function against hand-written cases.
`test/snapshot.test.js` — the whole surface against a frozen real-data fixture.
`test/surfaces.test.js` — static guards across surfaces:

1. No surface reimplements the completion test (`!r.complete`)
2. No surface reads a `data.js` const off `window` — they are top-level `const`s,
   so `window.DATA_TS` is always `undefined` and falls through to the wall clock
3. Status bands are never computed inline
4. Shared definitions are imported, not redefined
5. `metrics.cjs` exports everything the surfaces destructure
6. Every `TIP` entry is referenced by a card (a stale tooltip is a lie)

## Known non-shared numbers

These are computed on one surface only and have no shared definition. They are
the most likely next source of drift:

| number | where | note |
|---|---|---|
| Proj Age | `index.html` WIP page | `start → today`, inline |
| On target ≤Nd | `index.html` `pctTgt()` | Share of a set whose `ct_total` is ≤ `S.targetAvg`. On Current, Performance, the region table and the rep table. Not banded by `bandFor` — it is a percentage, and its card bands at 75/50 |
| Cost of a resurvey | `index.html` Quality page | `avg(effectiveComplete → resurvey_complete)` over resolved defects, median beneath. Every calendar day after the job's own survey had already closed: currently **+22.4d avg / +13d median** against a 4d target. It is Time to flag + Resurvey cycle exactly — same rows, so the hero is a total over its two parts (see *Hero row set* below). Two superseded definitions: `avg(ct_full) − avg(clean ct_total)` read +5.3d because `ct_full` is `ct_total + ct_resurvey` (parse-sf.js) and skips the flag wait, which is most of the calendar cost; `avg(start → resurvey_complete) − avg(clean ct_total)` (2026-08-17 → 2026-08-25) had the right magnitude but was a difference of means over two **disjoint** populations, so it moved with the composition of the clean rows. That subtrahend ranges 1.1–7.8d by region, 1.4–7.1d by office and 2.8–8.5d by resource — Radicl's clean jobs average 8.5d against a rep's 2.8d, which made Radicl's resurveys read 5.7d cheaper than a rep's when the true gap is 3.4d. **Anchor on `effectiveComplete`, never raw `complete`**: on a re-signed account the original survey predates the restart (920HHEND closed Aug 2025 against an Apr 2026 start) and raw `complete` scores its resurvey at 330d instead of 99d, ~0.6d of the national average on its own |
| Time to flag | `index.html` Quality page | `effectiveComplete → resurvey_requested` over resolved defects, avg with median beneath. Currently 16.6d avg / 6d median; p90 is 47d and p99 140d, so the average sits well above the middle of the distribution. Not the survey team's clock, which is the point: it is the largest of the two legs and a Design/review question rather than a field one |
| Hero row set | `index.html` `rsLegs` (Quality page) | Cost, Time to flag and Resurvey cycle are built from **one array, once**, so cost = flag + cycle by construction on every filter. A row qualifies only with a coherent timeline: `resurvey_complete` present, and all three legs non-null and ≥0 off the `effectiveComplete` anchor. It excluded 3 of 379 defects when it was written: one open resurvey (a request with no completion, which used to sit in Time to flag alone and put the all-time card 0.1d out), and two requested *before* the survey they follow closed — SF date-entry errors, fixed at source 2026-08-25, so that pair no longer trips it. The coherence test stays regardless: it is a guard against bad dates, not a workaround for two known rows, and an incoherent timeline must never land in one leg and not another. Filtering each figure separately is what let that happen; don't go back to it |
| Queue-age band | `index.html` `agePill` / `ageRowBg` / `attnItems` / WIP Avg age card | Green ≤`targetAvg`, amber ≤7d, red >7d. **The 7-day threshold is the page's real aging rule and has no home in `lib/metrics.cjs`** — it is written out inline in four places. Candidate for a shared `queueAgeBand()`; not done, because adding it is a definition change |
| WIP queue lens | `index.html` `wipView` / `WIP_VIEWS` | All · Initial · Resurveys, the outermost cut on the WIP page — the rail, the age bands, the status chips and the footer are all computed within it. **Initial is `!isOpenResurvey`, not a survey-type field**: `survey_type` is unused everywhere, and the question the lens answers is "what is a first visit", which is a queue state rather than a product. The two named lenses partition Open now exactly, and the panel subtitle prints the split (`58 initial, 21 resurveys`) so it can be read without switching |
| Queue age band | `lib/metrics.cjs` `queueAgeBand()` | Colours the WIP table's **Open in SS** pill and partitions Current's **still-open** buckets (on track / at risk / needs attn). Shared since 2026-08-24: the pill hardcoded its amber cutoff as `d<=7` while the buckets derived `targetAvg+3`, so the two agreed only while `targetAvg` was 4 — 8 live rows would have split at 3 |
| Pill scale | `index.html` `pillV()` | Green ≤`targetMedian`, amber ≤`targetAvg+2`, red beyond. One scale across the region and rep tables, stated in the note under each. Deliberately *not* `bandFor`, which bands against whichever target its card owns |
| IQR outlier fence | `compose/index.html` `iqrFence()` | `q3 + 1.5·IQR` over all completions, used to flag Monday-recap outliers and the "slow account" note. Compose only — the dashboard uses the flat `S.outlierDays` instead |
| Queue status pills | `index.html` `wipQueueStatus()` | Classified from schedule date, then last review subject and comment, in priority order — a Radicl job whose note says the utility bill is missing is blocked on the bill, not on Radicl. Nine states: Scheduled, Past due, then seven flavours of unscheduled. **Follow-up set** is a job parked against a date while waiting on something outside SS with no other handle on it ("FOLLOW UP 8/19", "FUP 8/12") — distinct from Awaiting rep, which is chasing the rep ("FOLLOW UP WITH REP 8/17") and must be tested first. Radicl also matches prose handoffs (`SENT/SUBMITTED/ASSIGNED … TO RADICL`), which arrive under subjects like CUSTOMER CALL that say nothing themselves. **Unclassified** is the catch-all and should read 0** — it did until 2026-08-17, when six rows sat in it; an empty status renders no chip, so a non-empty one is the prompt to write a rule rather than to widen an existing one |
| Resurvey rate by group | `index.html` Quality page | `defects ÷ completions` per `rsGroupKey` — the inverse of the FPY the detail table below it carries, ranked worst-first rather than by volume. Banded as the mirror of `fpyPill`: <5% green, 5–15% amber, 15%+ red, with a 5% ceiling line (the mirror of the 95% target). At a 15.6% national rate most groups read red; that is the honest reading, not a scale fault. Floored at `RS_MIN_CELL` completions and capped at the worst 12 |
| Cohort / FPY splits | `index.html` Quality page + Current page | every yield figure calls `fpy()` from `lib/metrics.cjs`; cohorts and drill segments stay on `hasResurveySig` |
| Resurvey population | `index.html` `renderResurvey()` | **One definition, `isResurveyDefect`, everywhere on the page.** It previously also ran a local `isResurveyRow` requiring a resurvey date or an Open/Holding list state, so "Total Resurveys" read 385 while FPY counted 434 defects on the same screen. Quality sections measure over completions in the filter bar's range; the queue section is a live snapshot and is deliberately not date-filtered |
| `RS_MATURE_DAYS` | `index.html` Quality page | 21 days. A completion keeps collecting resurveys long after it closes: only 57% arrive within 7 days, p75 is 18 and p90 is 41, so recent weeks read high until they mature. Weeks younger than this are hollow on the chart and excluded from the rolling line. 30 was more defensible statistically and useless in practice — it stopped the rolling line five weeks short of the data and hid the July recovery |
| Resurvey rate by group | `index.html` Quality page | `defects ÷ completions` — **one definition for all four cuts** (sales office · region · resource · sales rep) and the table's only rate column, shown as a bar with the 5% ceiling in its track. `RS_MIN_CELL` = 10 completions is the floor for the whole table, not just its pills. FPY is deliberately absent here: it is the exact complement, and printing both put the same fact on one row twice. The rep cut used to run an own-fault variant excluding Customer/Design; it was merged 2026-08-17 because attribution is 90% Surveyor and the split moved only 21 of 303 rep defects. The rep cut counts **self-surveyed rows only** (`resource === 'Sales Rep'`), so its denominator is smaller than the other three on purpose — grouping every completion by `sales_rep` would charge a rep for a Radicl surveyor's defect |
| Rep idle days | `index.html` Quality page | `most recent agreement_signed/start/complete on or before the range end → range end`. Anchored on the **end of the viewed range**, not the export: on a Q1 range an export anchor hid 3 of the 7 qualifying reps because they left later that year. Shown as an `idle Nd` tag from 30 days. **Never filters** — sales activity is a proxy for employment and no threshold makes it a good one, so the number is displayed and the reader draws their own line |
| `resurvey_reason` | `index.html` drill drawer · WIP expanded row · Quality inbox | The picklist on the request, 96% populated. Multi-select, so shares sum past 100%. **It is no longer drawn as a distribution anywhere**: "Survey Incomplete" is 76% of every recorded reason and the remaining eight values sit at 0–1% each, so a bar chart of it spent its whole height saying "something was missing". Kept as a per-row readout, beside the details text it summarises, so `rsCategories()` can always be checked against the source |
| `rsCategories()` | `lib/metrics.cjs` → `index.html` Quality *Why they come back* · `drillRsCategory()` | **Derived from `resurvey_details` free text, not a Salesforce field** — the ~8 actionable categories the picklist never had. Keyword rules over the details, with the request template's own headers (`INTERIOR ACCESS REQUIRED: No`, on 57% of requests) stripped first or they classify every row. **Multi-label by design** (Doug's call 2026-08-18): a request asks for 2.18 of these on average, so one category per row would delete the second ask, and shares sum past 100%. Live coverage 95% — the 20 misses are 18 defects with an empty details field plus 2 genuine one-offs, and those are reported under the bars rather than bucketed into a catch-all. Current reading: Panel interior & ratings 54% · Meter & service entrance 36% · Where things are 36% · Roof measurements & pitch 24% · Sub-panels & other loads 21% · Existing system & battery 20% · Roof material & structure 19% · Wrong site or full redo 8%. Panel + meter + sub-panels touch ~70% of resurveys between them: the coaching story is "photograph the panel completely". **Not in the snapshot fixture** — `build-fixture.cjs` redacts the details text, so the regression guard is the frozen corpus in `test/metrics.test.js`; widen a pattern and add its phrasing there in the same edit |
| Drill-drawer `Days` column | `index.html` `drillCols()` | **Two measurements in one column, because a row is one or the other.** A completed survey shows `ct_total` (cycle time); an open one has no cycle time yet and shows project age, suffixed `open`. Neither is `ssDaysOpen` — the tooltip says so, because the two age metrics must not be conflated. Open-resurvey drills drop this column entirely for **Scheduled + Days open** |
| Drill-drawer open-resurvey columns | `index.html` `drillCols()` | An open resurvey is never `resurvey_complete`, so `ct_resurvey` is null on every one — the Cycle column was 42 dashes. When every shown row is `isOpenResurvey()` the mode swaps to Scheduled + Days open and sorts oldest-first, the order the queue is worked in |
| Drill-drawer segments | `index.html` `DRILL_SEGS` / `_renderDrill()` | All / Resurveyed / Open resurvey, filtering the drilled rows. Deliberately not a toggle on the Intake & flow chart: an open resurvey is never `isComplete()`, so a chart-level resurvey filter is structurally empty on the Current basis |
| Open resurveys by week | `index.html` `rsWeekAnchor` / `drillRsWeek()` | Two anchors that genuinely disagree. **Complete wk** = "of the surveys we closed that week, which bounced back" (has a `of N done` denominator). **Request wk** = "how long has this resurvey been sitting". Completion-week scatters aging — a 54-day-old resurvey lands on whatever week its original survey closed |
| Resurveys requested | `index.html` `renderRsReq()` | Current page, left column, following the Last Week / This Week toggle. The only place that anchors on **`resurvey_requested`** — every other number on Current anchors on `complete` or `scheduled`, and the request that landed yesterday usually belongs to a survey that closed weeks ago, so it cannot be a column on an existing table. It is not on the Resurveys page because that page has no time control of its own. Mon–Sun, stopping at the export date. **Requests dismissed as Unnecessary Request are kept here and greyed**, not dropped as they are on the Resurveys page: this is the inbox, and a request that should not have been raised is still something to go and tag |
| `rsStaleDays()` | `index.html` drill drawer | p90 of resolved `ct_resurvey`, fit to this team's history like `floorBaseline` (currently ~15d). A fixed `targetAvg+3` lit 6 of 19 rows — resurveys legitimately run to a 4d median / 8d p75. Its second reader, the Quality open queue, was removed 2026-08-17; the drawer's **Days open** column is now the only surface that bands on it |
| Map location | `index.html` `MAP_ZIP_RE` | **The ZIP in `address`, never `region`.** Region is a sales territory, not a place — 317 of Virginia's rows say "VA Richmond" while the addresses run Burke to King George. Reading the address also places the 71 in-scope rows whose `region` is blank, which no other view can show, so Virginia reads 368 on the Map vs 303 by region |
| `MAP_MIN_N` | `index.html` Map page | 3 completions before a ZIP gets a colour in the Cycle or Resurvey modes; below it the circle draws hollow. 779 of 1028 national ZIPs fall below it — without the guard most of the map would be a confident colour drawn from one job |
| Map Open WIP mode | `index.html` `mapVisible()` | Filters to `isWIP(r)` and ignores the sale date entirely — the other three modes answer "what did we sell in this period", this one answers "what is on the books now". Cross-checks against the WIP page: both read 146. Ages use `ssDaysOpen` against the export date, not the wall clock |
| Resurvey breakdown | `index.html` `rsGroupBy` | **Sales office by default**, toggleable to Region. Across offices with 25+ completions yield runs 71.4% to 93.6% — a wider spread than the same cut by region, and an office has someone accountable where a sales region is closer to a geography label. Falls back to region on exports predating 2026-08-06, which have no office field |
| Map labels | `index.html` `mapLabelCandidates()` | Recognisable cities first (`geo/cities.json`, top-1k US by population), then our own towns by job count, each with a dot on its anchor. Ours draw in ink, reference-only in faint. Nationally, markets outrank non-markets and **no state gets more than 3** — on population alone Texas and California take a third of the labels and the Mountain West goes unnamed, which is how Denver went missing |
| Map time | filter bar only | The Map deliberately has **no** time control of its own. It had a scrubber; it duplicated the filter bar, and a stale scrubber index once showed 167 jobs against a filter selecting 2458. The histogram under the map is context, not a control |
| Map city names | `index.html` `mapCities()` | Derived from the addresses, not a lookup table. SF gives one unpunctuated string ("11314 Glen Park Dr Fredericksburg, VA 22407"), so "last N words" mangles Glen Allen / King George / Virginia Beach. Diff the addresses sharing a ZIP: the longest common trailing words are the town. A ZIP with one job has nothing to diff, so there it cuts after the last street-type token |

## Regenerating

```
node scripts/build-fixture.cjs      # rebuild the test fixture from data.json
node scripts/build-geo.cjs          # rebuild geo/ (ZIPs, states, cities, counties)
UPDATE_SNAPSHOT=1 npm test          # accept intentional metric changes
npm test                            # all three suites
```

`build-geo.cjs` downloads its sources into `geo/.src` (gitignored) and only
needs rerunning when a market opens in a state with no counties file yet.
