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
| Dashboard | `index.html` | Current / Performance / Trends / WIP / Resurveys |
| Compose | `compose/index.html` | Monday recap + daily email |
| Morning card | `api/morning-card.js` | Teams card (not adopted — see CLAUDE.md) |

## The metrics

### Scope & classification

| metric | definition | trap |
|---|---|---|
| `DATA_CUTOFF` | `2025-12-29`; all charts and row filters start here | — |
| `inScope(r)` | started ≥ cutoff **and** (complete **or** project active) | a finished survey counts even on an At-Risk/Canceled project; a *non-finished* one on such a project does not |
| `filterRows(raw)` | `inScope` + `normalizeName` on `sales_rep` | the only correct entry point — never filter raw rows by hand |
| `isComplete(r)` | completion date **AND** `list === 'Complete'` | **48 rows carry a date but are Holding/Reopened.** A bare `r.complete` test counts them as finished |
| `isWIP(r)` | `start` and not `isComplete` | complete + WIP partition the scoped rows exactly |
| `normalizeName(n)` | title-cases fully-uppercase reps; keeps roman numerals | SF exports the same rep in mixed casings, splitting their stats |

### The two age metrics — never interchangeable

| metric | definition | used for |
|---|---|---|
| `wipAgeFrom(r)` | **anchor date**: resurvey request → completion +2d → project start | cycle-time math: `ct_total`, `projCt`, `estComplete`. **Never shift it** — Spec 12744 depends on it |
| `ssDaysOpen(r, asOf)` | days the survey has been SS's, = anchor → asOf **minus one rep grace day** | queue triage, the "Days Open in SS" column, attention rules |
| `hasRepGrace(r)` | blank resource counts as rep; straight-to-field skips it; open resurveys get none | `requested` is the rep→field handoff marker (99% coverage on Radicl/SPWR vs 13% on Sales Rep) |
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
| `mondayFloor(rows, weekEnd)` | WIP after that Monday drains the weekend | robust to the Fri/Sat rhythm by construction |
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

## Regenerating

```
node scripts/build-fixture.cjs      # rebuild the test fixture from data.json
UPDATE_SNAPSHOT=1 npm test          # accept intentional metric changes
npm test                            # all three suites
```
