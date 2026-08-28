# Audit — Billing & Resource
2026-08-26 · scoped to the two pages Doug named, on the axes he named:
aesthetics, motion, cohesion with the rest of the app, and copy that
over-explains. Correctness items found on the way are reported too.

Walked live at 1440px and 920px against `data.js` (3,797 rows) and the two
imported statements. No console errors on either page.

---

## Billing

| # | Axis | Observed | Sev | Proposed fix | Risk |
|---|------|----------|-----|--------------|------|
| B1 | Aesthetics | **The rail collides between 861px and ~1150px.** `.srail` only wraps below 860px. At 920px the six cells are 114px each holding 29px money: `$137,821` overruns into `PER SURVEY`, and `$42,410`/`$19,880` touch. Four of the six labels wrap to two lines, so the values sit on three different baselines. | broken | Wrap `.bill-rail` to 3×2 below ~1180px, or cut it to fewer cells (B2 does this by construction). | low — scoped to `.bill-rail` |
| B2 | Organization | **The rail and the chips print the same money twice, in two vocabularies.** Travel adders `$42,410 · 31%` = chip `Travel adder 243 · $42,410`. Cleanup work `$19,880 · 70 visits` = chip `Cleanup of someone else's survey 70 · $19,880`. To review `$3,408 · 12 lines` = chip `Second visit… 12 · $3,408`. And **Rework** is in both with *different* numbers — rail `$4,260 · 15 visits` (subtype role) against chip `Rework on their own defect 4 · $1,136` (a rule). This is verbatim the defect CLAUDE.md records as fixed on 2026-08-26 ("rail Rework $2,556 · 9 visits against a card reading 1 · REWORK ON THEIR OWN DEFECT · $284"). The cards became chips; the collision stayed. | wrong | Cut the rail to what a chip cannot say — Invoiced · Per survey · (period/statements) — and let Travel/Cleanup/Rework/To review live only as chips, where they are clickable. | med — a layout call, want your yes first |
| B3 | Copy | **The note under the chips is filler in the default state**, and on the account lens it repeats the subtitle nine pixels above it: sub reads `323 accounts · $137,821 · every line the account drew, added up`, note reads `Every account that drew a charge, and what it cost across all of its lines.` Charges lens: `Every charge on every imported statement.` — says nothing the title doesn't. | rough | Render `#bill-flag-why` only when a rule is selected. Drop the `· every line the account drew, added up` tail from the account subtitle. | none |
| B4 | Motion | **No entrance animation on a cold load.** `animateSections()` fires once in the rAF after `renderPage()`; on a first visit `_billing` is still fetching, so it animates the "Loading invoice history…" note and the real page then pops in unanimated. Every other page fades and staggers. | rough | Call `animateSections('page-billing')` from `billingEnsure()`'s resolve when Billing is current. | none |
| B5 | Motion | **"Show 50 more" rebuilds the rail, the banner and the chip row.** `billMore()` → `_renderBillMain()`. Only the table changed. | nit | Have the footer redraw `#bill-table` only. | low |
| B6 | Aesthetics | The **Statement column** is the widest right-hand column and, on the default newest-first sort with no statement picked, every visible row reads the same filename in 10px `--faint`. Correct, but it carries the least of any column. | nit | Fold into the Date cell's `cmeta`, or leave. | low |
| B7 | Copy | **Tooltips carry the argument for the metric, not just its definition.** `TIP.billTravel` ends "Tracked because it is the one line a surveyor based in the market removes outright rather than reduces." `TIP.billPerSurvey`: "It is the number to compare an SPWR surveyor against, not the base rate." The case is already written in the source comment beside it. | nit | Trim each to definition + the one caveat that changes a reading. | none |
| B8 | Aesthetics | Chips wrap to 2–3 rows at every width, and because they render in `EXCEPTIONS` order the widest one lands mid-row, so the break is ragged. | nit | Order by count desc, or let `All charges` sit on its own line. | low |

---

## Resource

| # | Axis | Observed | Sev | Proposed fix | Risk |
|---|------|----------|-----|--------------|------|
| R1 | Aesthetics | **The three-column hero breaks below ~1150px.** `.res-cols` is `auto-fit, minmax(232px,1fr)`, so at 920px it goes 2×2. Then: *Sales reps* lands in row 2 col 1 but still matches `:not(:first-child){padding-left:18px}`, so it sits 18px out of alignment with *SPWR surveyors* directly above it; the open column's tab (rounded top, inset outline) is in row 1 while the drawer it should be joined to is two rows down, so the "one shape with a notch" reading is gone; and the two rows have no separator between them. | broken | `repeat(3,1fr)`, stacking to one column under 860px, with the side padding/border reset in the stacked case. | low |
| R2 | Motion | **Every interaction costs a full 177ms re-render.** Measured: `renderResource()` 177ms, `_renderResBody()` 75ms. `resToggleIns()` — opening one collapsed paragraph — `setResExpand()` and `setResGroup()` all call `renderResource()`, which runs `resMarkets()` (clusters 3,700 rows) and then calls `_renderResBody()`, which runs it **again**. `_resRows()` runs it a third time on a drill. This is the "not smooth" complaint, quantified. | rough | Memoise `resPoints()`/`resMarkets()` on radius + a data generation counter; have `resToggleIns()` redraw only the findings panel. | low, if the memo clears on reload and radius change |
| R3 | Motion | **No row in the market table responds to hover.** `.res-grp>td{background:var(--bg)}` and `.res-kid>td{background:var(--surface)}` are declared *after* `tr:hover td{background:var(--bg)}` at equal specificity, so they win and the hover is dead at both levels. The first cell of every one of those rows is an expander. | rough | Add `.res-grp:hover>td` / `.res-kid:hover>td`. | none |
| R4 | Copy | **The team drawer's note is the densest block of text in the app** — ten lines of 10px grey carrying the capacity derivation, a four-point mileage ladder, a four-point capacity ladder, the vehicle rule, the loaded cost, and two don't-misread-this warnings. | rough | Keep `resModelLine()` and the two caveats that change a reading (*shared range*, constraints recorded not modelled). The two ladders go behind the Settings link already in the sentence. | none |
| R5 | Copy | **The note under the market table instructs and justifies.** "open a row for its markets, a market for why" is UI instruction; "Outlook never changes the recommendation beside it" is design justification. Against the rule set on this page 2026-08-26 — a note says what a number *is*; instructions and justification go in a source comment. | rough | Keep the two definitions (25-mile cluster, three 28-day windows of starts). Drop the rest. | none |
| R6 | Copy | **The hero columns and the findings editorialise.** "Yield here is the whole team's biggest quality lever"; "the case for insourcing is throughput, cycle time or quality, not price"; "A surveyor fixes one job; the rate is a training problem"; "This is a deployment and hiring question, not a scheduling one"; "A one- to two-week posting is reversible; a hire is not." | rough | State the number and stop. | none |
| R7 | Logic | **2,893 and 2,891 sit nine pixels apart in the Sales reps column** with nothing distinguishing them — the lead prints `n` (in-scope rep rows), the FPY sub prints `done` (completions), and the note under it calls 2,891 "rep surveys" while the lead calls 2,893 "surveys from the field". | rough | Have the lead say something the column doesn't already say. | none |
| R8 | Motion | Same cold-load gap as B4, and worse here: the page waits on `roster.json` **and** `geo/zips.json`, so on a first visit panel 1 animates alone and the other three appear a beat later, unanimated. Observed. | rough | Same fix — animate on the ensure resolve. | none |
| R9 | Organization | **Panel title "Where the work goes" is a clause**, against the noun-phrase rule set on this page 2026-08-26 (*What this says* → Findings, *What to do, market by market* → Markets). | nit | "Resource split". | none |
| R10 | Organization | **"SPWR surveyors" (column heading, drawer title) vs "SunPower Surveyors" (the expander button)** — two names for one thing, 200px apart. | nit | Pick one. | none |
| R11 | Code health | `.res-why` is dead CSS — the Why column moved into the expanded row, which uses `.res-detail-in`. `.res-col-more::after{content:''}` is an empty spacer doing nothing a `gap` wouldn't. | nit | Delete both. | none |
| R12 | Copy | `TIP.resSplit` ends "The columns are equal width on purpose — their job is comparing yield against yield, and the bar above already says who does how much." `TIP.resCapacity` runs five sentences. Design history in a hover tip. | nit | Trim to definition + the caveat. | none |

---

## Not findings

- **Verbose source comments in the CSS and the render functions.** These are
  where CLAUDE.md says the reasoning belongs. Left alone.
- **Both pages' numbers trace to `lib/metrics.cjs` / `billing.cjs` /
  `coverage.cjs`.** No surface reimplements a shared definition; `fpy()`,
  `bandFor()`, `everCompleted()`, `isResurveyDefect()`, `RS_MIN_CELL` all come
  from the libraries. `docs/METRICS.md` covers every displayed figure on both
  pages, including the three lenses and the vehicle cost.
- **`billF` not persisting, Resource having no filter bar, `res-mkt-tbl` being
  `tbl-static`** — all deliberate and documented. Left alone.

## Found during batch 1

| # | Axis | Observed | Sev | Fix | Risk |
|---|------|----------|-----|-----|------|
| R13 | Aesthetics | **The subgrid block was dead.** `.res-col{display:flex}` is declared *after* `@supports(grid-template-rows:subgrid){.res-col{display:grid;…}}` at equal specificity, so flex won unconditionally and subgrid never ran. Only the expanders lined up (`margin-top:auto` does that on its own); every band above them sat at a different height per column — at 920px *First-pass yield* was 22px out between the outer columns. The CSS comment claims subgrid "does it exactly". It never has. | broken | Move the flex base rule above the `@supports` block. | low |

## Batches

1. **Correctness / broken layout** — B1, R1, R3, R13 ✅ done
2. **Organization + copy** — B2, B3, R4, R5, R6, R7, R9, R10 ✅ done
3. **Motion** — B4, B5, R2, R8 ✅ done
4. **Code health** — B6, B7, R11, R12 ✅ done · B8 closed no-change

B8 (chip wrap) was left alone deliberately: `EXCEPTIONS` orders the chips
high-severity first, which is the reading order. Sorting by count to tidy the
wrap would put *Travel adder* at the front and bury *No Salesforce record*.
