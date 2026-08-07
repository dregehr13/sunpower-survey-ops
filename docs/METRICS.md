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
| Dashboard | `index.html` | Current / Performance / Trends / WIP / Resurveys / Map |
| Compose | `compose/index.html` | Monday recap + daily email |
| Morning card | `api/morning-card.js` | Teams card (not adopted — see CLAUDE.md) |

## The metrics

### Scope & classification

| metric | definition | trap |
|---|---|---|
| `DATA_CUTOFF` | `2025-12-29`; all charts and row filters start here | — |
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
| `weeklyFloor(rows, weekEnd)` | WIP after the weekend buildup drains (currently the day after Monday) | robust to the Fri/Sat rhythm by construction |
| `floorBaseline(series, 16)` | median of the prior 16 floors | long window on purpose — a short one absorbs a regime shift and the alarm silences itself |
| `clearanceAlarm(series)` | 4-wk clearance <90% twice running | confirmation |
| `floorAlarm(series)` | floor > 1.5× baseline | early warning; moved a month before the ratio did |

Thresholds are fit to this team's own 20-week history — they encode "unusual for
us", not an industry standard. Revisit after a quarter.

### Cycle time & projection

| metric | definition |
|---|---|
| `avg` / `med` / `pct` | ignore null/negative/NaN; `avg` keeps **2dp** |
| `bandFor(v, target)` | ≤target good · ≤target+2 mid · else bad, **on the displayed value** |
| `buildShowRates(rows, asOf)` | measured per-resource completion-within-1-day rate; ≥5 samples, else global |
| `buildExpectedCt(recent)` | rep's own avg (≥3) → region\|resource segment → global |
| `projectWeekTotal(...)` | per-row: scheduled contribute show-rate, unscheduled contribute `min(daysLeft/ct, 1)` |
| `weekDaysRemaining(iso)` | fractional days left Mon–Sun; export day counts as half |
| `trendLabel(cur, prev, band)` | `TREND_BAND_AVG` 0.1 (dashboard) vs `TREND_BAND_MED` 0.3 (compose) — two calculations on purpose |

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
| Queue status pills | `index.html` `wipQueueStatus()` | classified from schedule date + last review subject |
| Attention rules | `index.html` `attnItems()` | aging >7d, schedule passed, no review >5d, resurvey unscheduled >3d |
| Cohort / FPY splits | `index.html` Resurveys page | built on `hasResurveySig` |
| Resurvey population | `index.html` `renderResurvey()` | **One definition: `hasResurveySig`.** The page previously also ran a local `isResurveyRow` requiring a resurvey date or an Open/Holding list state, so "Total Resurveys" read 385 while FPY counted 434 defects on the same screen — the gap being rows flagged `reopened_by_design` or carrying a reason that resolved without dates. Quality sections measure over completions in the filter bar's range; the queue section is a live snapshot and is deliberately not date-filtered |
| `RS_MATURE_DAYS` | `index.html` Resurveys page | 21 days. A completion keeps collecting resurveys long after it closes: only 57% arrive within 7 days, p75 is 18 and p90 is 41, so recent weeks read high until they mature. Weeks younger than this are hollow on the chart and excluded from the rolling line. 30 was more defensible statistically and useless in practice — it stopped the rolling line five weeks short of the data and hid the July recovery |
| Rep resurvey rate | `index.html` Resurveys page | Their-fault resurveys ÷ completions. Ones attributed to Customer or Design are shown but not charged to the rep: 38 of the rep-attributed defects are one of those, and the pill bands at 10% and 20%, so charging them can move someone across a band unfairly |
| `resurvey_reason` | `index.html` Resurveys page | The picklist on the request, 96% populated — better coverage than `resurvey_attributed` at 84%, and the field that says *what to fix* rather than *who*. Multi-select, so shares sum past 100%. **66% of all resurveys are "Survey Incomplete"**; `resurvey_details` carries the specifics on 92% of those |
| Drill-drawer segments | `index.html` `DRILL_SEGS` / `_renderDrill()` | All / Resurveyed / Open resurvey, filtering the drilled rows. Deliberately not a toggle on the Intake & flow chart: an open resurvey is never `isComplete()`, so a chart-level resurvey filter is structurally empty on the Current basis |
| Open resurveys by week | `index.html` `rsWeekAnchor` / `drillRsWeek()` | Two anchors that genuinely disagree. **Complete wk** = "of the surveys we closed that week, which bounced back" (has a `of N done` denominator). **Request wk** = "how long has this resurvey been sitting". Completion-week scatters aging — a 54-day-old resurvey lands on whatever week its original survey closed |
| `RS_STALE` | `index.html` Resurveys page | p90 of resolved `ct_resurvey`, fit to this team's history like `floorBaseline` (currently ~15d). A fixed `targetAvg+3` lit 6 of 19 rows — resurveys legitimately run to a 4d median / 8d p75 |
| Map location | `index.html` `MAP_ZIP_RE` | **The ZIP in `address`, never `region`.** Region is a sales territory, not a place — 317 of Virginia's rows say "VA Richmond" while the addresses run Burke to King George. Reading the address also places the 71 in-scope rows whose `region` is blank, which no other view can show, so Virginia reads 368 on the Map vs 303 by region |
| `MAP_MIN_N` | `index.html` Map page | 3 completions before a ZIP gets a colour in the Cycle or Resurvey modes; below it the circle draws hollow. 779 of 1028 national ZIPs fall below it — without the guard most of the map would be a confident colour drawn from one job |
| Map Open WIP mode | `index.html` `mapVisible()` | Filters to `isWIP(r)` and ignores the sale date entirely — the other three modes answer "what did we sell in this period", this one answers "what is on the books now". Cross-checks against the WIP page: both read 146. Ages use `ssDaysOpen` against the export date, not the wall clock |
| Map labels | `index.html` `mapLabelCandidates()` | Recognisable cities first (`geo/cities.json`, top-1k US by population), then our own towns by job count, each with a dot on its anchor. Ours draw in ink, reference-only in faint. Nationally, markets outrank non-markets and **no state gets more than 3** — on population alone Texas and California take a third of the labels and the Mountain West goes unnamed, which is how Denver went missing |
| Map time | filter bar only | The Map deliberately has **no** time control of its own. It had a scrubber; it duplicated the filter bar, and a stale scrubber index once showed 167 jobs against a filter selecting 2458. The histogram under the map is context, not a control |
| Map city names | `index.html` `mapCities()` | Derived from the addresses, not a lookup table. SF gives one unpunctuated string ("11314 Glen Park Dr Fredericksburg, VA 22407"), so "last N words" mangles Glen Allen / King George / Virginia Beach. Diff the addresses sharing a ZIP: the longest common trailing words are the town. A ZIP with one job has nothing to diff, so there it cuts after the last street-type token |

## Regenerating

```
node scripts/build-fixture.cjs      # rebuild the test fixture from data.json
UPDATE_SNAPSHOT=1 npm test          # accept intentional metric changes
npm test                            # all three suites
```
