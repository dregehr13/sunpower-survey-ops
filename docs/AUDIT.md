# Audit — tooltips & help text

2026-08-31 · scoped to what Doug named: over-explaining and claudish language in
tooltips (`TIP`) and help text (panel subtitles, `.note` blocks, Settings field
descriptions, modal subtitles). Not a full-app audit — functionality/logic/
accuracy only where a copy string is actually broken.

Walked live at 1280px against `data.js` (3,834 projects): Current, WIP,
Performance, Trends, Quality, Map (Volume + Coverage), Resource, Settings,
Billing, plus the drill drawer and the three commit modals. `npm test` green
(153) before any change.

**The prior audit (Billing + Resource, 2026-08-26) is fully applied** — all four
batches done, B8 closed no-change. Its table is in git history
(`git log -p -- docs/AUDIT.md`).

## Standard being applied

CLAUDE.md, already written, in three places:
- *"A tip is a definition plus the one caveat that changes how the number is
  read — never the case for building the metric that way."*
- *"A note says what a number IS, not why it was built that way… Doug is the only
  reader of this app; he does not need the case re-made every time he opens a
  page."*
- *"State the number and stop."* (Resource, 2026-08-27)

The finding everywhere below is the same: reasoning that belongs in a source
comment has leaked into a hover tip or a subtitle. Several of these were trimmed
on 2026-08-27 and grew back, or were missed in that pass.

---

## Headline

The app is **mostly already lean**. Current, WIP, Billing, and most of
Performance carry tight one-line labels. The fluff is concentrated in two
places: **~13 of the 44 `TIP` entries**, and **~6 chart subtitles/notes** on
Trends, Quality, Map and Resource. One dead tooltip on the Map.

---

## Broken

| # | Surface | What I observed | Sev | Proposed fix | Risk |
|---|---------|-----------------|-----|--------------|------|
| X1 | Map · rail | `kinfo(mapMetric==='wip'?TIP.mapWip:TIP.mapLocation)` on the "Jobs in view" / "Open surveys" cell (line ~6648). **`TIP.mapLocation` does not exist** — CLAUDE.md records it as "deleted outright" on 2026-08-31, but the reference stayed. `esc(undefined)→''`, so the cell renders an `i` icon that does nothing on hover or focus. The `mapWip` branch is fine. The `every TIP entry is referenced` test only checks the other direction, so it passed. | broken | Drop the `kinfo()` when not in WIP mode: `${mapMetric==='wip'?kinfo(TIP.mapWip):''}`. | none |

---

## Rough — tooltips carrying the argument, not the definition

`TIP` object, index.html line 2556.

| # | Entry | What I observed | Proposed fix |
|---|-------|-----------------|--------------|
| T1 | `drillDays` | ~55 words, three clauses, and it ends by defining a *different* metric: *"Neither is Days Open in SS — that subtracts the rep grace day and is the WIP page's triage number."* | "A completed row shows its cycle time (Project Start → Site Survey Complete); an open row has no cycle yet, so it shows project age, marked 'open'." |
| T2 | `rsPenalty` | Definition is fine, then a full sentence of design history: *"Measured against the job's own survey rather than the clean-job average, so it stays comparable when you filter: clean cycle times range 1.1–7.8d by region and 2.8–8.5d by resource, and the old definition subtracted whichever one the filter happened to select."* | Cut everything after *"…the wait before anyone flags it, plus the trip back out."* |
| T3 | `rsCat` | Leads with the case against the picklist (*"the reason picklist is too coarse to act on, with 'Survey Incomplete' carrying 76% of it"*) and closes with where the raw data lives. | "What the request asked for, read from the Resurvey Request Details text — the reason picklist is too coarse. One request asks for ~2 of these, so shares add past 100%." |
| T4 | `rsFlag` | *"Not the survey team's clock, which is why it is worth showing separately — it is the largest of the three figures here, and it is a Design and review question rather than a field one."* — three reasons it exists, zero of them a caveat. | "Site Survey Complete → Resurvey Requested: how long the finished survey sat before anyone asked for a redo. A Design/review wait, not the survey team's. Median 6d; top 10% past 47." |
| T5 | `ssRatioWeek` | Carries the whole averaging rationale: *"…since intake keeps arriving Friday and Saturday while the team is off, so a Sunday snapshot would catch the weekly peak every time."* | "Weeks of backlog: mean WIP across the week ÷ mean weekly completions over that week and the two before." (The Fri/Sat reasoning is a source comment.) |
| T6 | `ssRatioLive` | Definition + *"This reads high on a Monday morning; that is the genuine queue before the day clears it."* — the caveat is real but doubled ("genuine"). | "…1.0 ≈ a week of work queued. Reads high Monday mornings, before the day's clearing." |
| T7 | `weeklyFloor` | Second sentence teaches interpretation: *"If this floor climbs week over week, backlog is genuinely growing — it isn't draining back down even on the week's best day."* | "Lowest daily WIP during the week (Mon–Sun). A rising floor means backlog isn't draining." |
| T8 | `firstComplete` | Four sentences; restates itself as a contrast: *"It answers 'how many closed out that week,' not 'how many are sitting in Complete right now.'"* | "Counts a survey in the week its Site Survey Complete date lands, regardless of current status — so it never shrinks later if the survey reopens." |
| T9 | `resCapacity` | Five sentences. Ends *"Read the gap against it as a question, not as headroom."* — which the Findings panel and the SPWR column note both already say. | Keep the arithmetic sketch + "editable in Settings → Resource model". Drop the closing instruction. |

## Nit — tooltips, minor

| # | Entry | Trim |
|---|-------|------|
| T10 | `fpy` | Drop the last sentence (*"They are left out of this page entirely, not just out of the percentage."*). |
| T11 | `fpyTrend` | Drop *"Twenty-one days is about the 79th percentile of that lag."* |
| T12 | `wipInitial` | Drop *"so this is the cut to use when you want the queue the team is actually starting from scratch."* — the first two sentences are enough. |
| T13 | `projAge` | Drop the instructional tail (*"Use this for total elapsed age, and Days Open in SS for…"*). |
| T14 | `resRec` | Keep "A case to check, not a verdict." Drop *"— the thresholds are fitted to this team's own history."* |
| T15 | `billPerSurvey` / `billReview` | Trim each to definition + "not a verdict". Drop *"Compare an SPWR surveyor against this, not against the base rate."* |
| T16 | `mapVolume` | Duplicates the on-chart legend caption ("Blob size follows job count; overlaps add"). Shorten the tip to "Job density — colour shows concentration" or drop the caption. |

The other ~28 `TIP` entries (`onTarget`, `schedRem`, `wip`, `avgAge`,
`clearance`, `trend3wk`, `pace`, `bestWeek`, `p75`, `p90`, `resourceMix`,
`rsCycle`, `rsOpenDays`, `mapCycle`, `mapResurvey`, `mapWip`, `mapReach`,
`mapAbsorb`, `mapSite`, `mapTopMarket`, `mapTopLocation`, `cycle`, `complete`,
`ssDaysOpen`, `resSplit`, `resourceMix`, `billSpend`, `rsOpen` …) are already
one line and fine. Leave them.

---

## Rough — subtitles and notes

| # | Surface | What I observed | Proposed fix |
|---|---------|-----------------|--------------|
| S1 | Trends · **Weekly rhythm** subtitle | ~45 words in a subtitle: *"Average surveys in vs out by day of week, always the trailing 8 weeks — not affected by the date filter above, since a short custom range would leave each weekday only one or two samples · the Saturday gap is structural: reps sell weekends, the admin team does not work them"* | "Avg surveys in vs out by weekday · trailing 8 weeks · ignores the date filter". The sample-size reasoning and the Saturday-gap explanation → source comment. |
| S2 | Trends · **Intake & flow** subtitle | *"…last 8 weeks · Sat/Sun muted — the admin team works Mon–Fri, so weekend buildup is expected · Line = open WIP"* | "…last 8 weeks · weekend muted · line = open WIP" |
| S3 | Quality · **Resurveys requested** note | *"By the date the resurvey was requested, not the date the original survey closed — most of these belong to surveys that finished weeks ago. This panel holds a fixed two weeks and ignores the date range; region, office and resource filters do apply. N are tagged Unnecessary Request and shown greyed: they are excluded from the yield figures above, since nothing was re-surveyed."* | "By request date · fixed two weeks · ignores the date range, obeys region/office/resource. N greyed rows are Unnecessary Request — excluded from yield." |
| S4 | Map · **Coverage** mode | Says "not the date range" in **three** places: subtitle (*"the whole book, not the date range · turn on Team reach to see what the team can get to"*), legend caption (*"…colour is the resource doing most of the work here, the split is in the list below"*), and the note (*"The whole book, whatever the date range holds · rates are the last 8 weeks…"*). | Subtitle: "Who does the work · whole book, ignores the date range". Drop *"turn on Team reach…"* and *"…the split is in the list below"*. Note keeps only the rates-window + unplaced-rows facts. |

## Nit — subtitles and notes

| # | Surface | Trim |
|---|---------|------|
| S5 | Performance · table note | *"…Every region is listed however few projects it has, so read the average next to its Projects count."* → "Every group is listed regardless of volume — check the Projects count beside each average." |
| S6 | Quality · "Why they come back" note | *"…so they are in none of the bars above. A further 72 requests were dismissed as unnecessary and are excluded from this page entirely, since nothing was re-surveyed."* → "…and aren't in any bar. 72 more were dismissed as unnecessary and excluded from this page." |
| S7 | Quality · rep-cut note | Drop *"…because a quiet rep may be between deals rather than gone."* |
| S8 | Resource · SPWR hero note | *"Modelled at 13.9/wk each; they complete 2.7. Settle that before using any capacity figure on this page."* → keep a caveat (CLAUDE.md says it must stay here) but tighten: "Modelled 13.9/wk each; actual 2.7 — every capacity figure below rests on this." |
| S9 | Resource · Sales reps hero note | *"No cost line. Rework the reps cause is billed by the vendor, so it lands under Outsourced."* → "No cost line — rep-caused rework is billed by the vendor, under Outsourced." |
| S10 | Resource · Findings detail tails | *"…so re-assigning it to the current team wins nothing"*, *"The last one relocated across state lines in a single week."*, *"Averaged over the whole dataset they still look staffable."*, *"…so it says what has arrived rather than what is coming."* A findings panel may interpret — but these are the claudish "and here's what it means" reflex on the end of each. Trim to the finding. Low priority. |
| S11 | Settings · **Resource model** section blurb | *"…They are an estimate calibrated to what Doug has seen, not a measurement, which is why they are editable here rather than fixed in the code. A surveyor's own knobs in roster.json still win over them."* → "An estimate, not a measurement — edit freely. Feeds only the Resource page. roster.json values still win." |
| S12 | Settings · **Minimum sample for a rate** desc | Ends with a worked example: *"…at 10 the map rates 54 of 214 markets, at 3 it rates 114 and 29 of them paint a perfect 0% off fewer than ten jobs."* → drop the example; keep "Completions a group needs before its rate is shown instead of a sample count · Quality table, Resource markets, map Cycle/Resurvey colouring." |
| S13 | Settings · field descs | *"Door to door in a metro, not a highway cruise"* → "Door-to-door in a metro." · *"The default. A surveyor's own days come from their `off` list in roster.json and always win"* → "Default — a surveyor's roster entry overrides it." · *"Straight-line miles → road miles. Every distance in the app is straight-line; this is the one place it is converted"* → "Straight-line miles → road miles." |
| S14 | Outlook modal subtitle | *"Sits beside the recommendation and never changes it — commits to the repo, live for everyone in about 30 seconds."* → "Committed to the repo — live in ~30s." (The "never changes the recommendation" fact is design justification; it's already a source comment.) |

---

## Not findings / leave alone

- **Source comments** in CSS and render functions — CLAUDE.md says that's where
  the reasoning belongs. Untouched.
- **Update-data modal** step wizard ("Open your Salesforce report" → "Export" →
  "Load the file") — instructional by nature, correct here.
- **`docs/METRICS.md`, `README.md`, `api/*.js` prompt strings** — outside the
  named scope (not tooltips/help text). `api/generate.js`'s prompt to the model
  is verbose but that's a separate concern; flag if you want it swept.
- **Chip labels** (Billing exceptions, WIP status) and **rail sub-labels** —
  already terse.
- **"Changing targets updates all KPI colors, chart annotations, pill
  thresholds…"** (Settings) — this is blast-radius information, genuinely
  useful. Keep.
- **Billing rule `why` strings** (`lib/billing.cjs`) — mostly caveats that
  change a reading ("Whether it is billable is a contract question"). One tail
  in `travel_adder` (*"…the one line a local surveyor removes outright"*) is
  borderline editorial; low priority.

---

## Proposed batches (Phase 2)

Single axis (copy), so the batches are by surface, not by the skill's default
correctness→org→aesthetics split:

1. **X1** — the dead Map tooltip (1-line fix, no risk).
2. **T1–T16** — `TIP` object trims. One file, one object, no logic. `npm test`
   covers the "referenced by a card" guard.
3. **S1–S14** — subtitle and note trims across Trends, Quality, Map, Performance,
   Resource, Settings. Screenshot each page after.

No metric definition changes anywhere in here. No `UPDATE_SNAPSHOT`. CLAUDE.md's
"Hover tips" and per-page copy notes get updated to match in batch 2/3.

**Stopping here for your review before editing anything.**
