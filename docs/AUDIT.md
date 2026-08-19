# Performance & Trends audit — 2026-08-19

Phase 1 assessment, scoped to Performance and Trends only (arguments given).
Walked both pages in the browser against live `data.js` (2,442 rows, `DATA_TS`
2026-08-18 10:29), exercising every toggle, cut, sort, search box, drill,
keyboard path and narrow-viewport layout, and cross-checked displayed numbers
against `lib/metrics.cjs` and `docs/METRICS.md`. Baseline `npm test`: **70
pass, 0 fail**.

Both pages have been substantially rebuilt since the 2026-08-14 audit below
(stat rail, region/office/rep/resource cuts, the P1–P4/T1–T3 findings from
that pass) — this is a fresh look at the current code, not a re-check of the
old findings. Ranked worst first within each page.

## Batch 1 — applied (correctness)

`npm test` 70/70 after each change, snapshot unchanged — no metric definition
moved. **PF1, PF2, TR2 fixed**; verified live (chart config, keyboard-drill via
a dispatched Enter keydown, and a fresh 480px load with `document.body.
scrollWidth === window.innerWidth`, all after the change). **TR1 left alone —
Doug's call: the date-filter behavior on that strip works as intended, not a
bug.** Pages stay separate; no merge (see the note below).

Batch 2 (organization + logic clarity) had nothing queued — the one Logic
finding was TR1, dismissed above. **PF3 pulled forward from batch 4** since it
was the only thing left in scope: `pillV()` and `pCycleCell` now both read the
band from a shared `pillBand(v)` (next to `pillV()`), rather than each
carrying its own copy of the three thresholds. Verified byte-identical output
before/after on both callers (`pillV(2/4/8/null)` and the first five
Performance table rows' cell colours).

## Performance

| # | axis | what I observed | severity | proposed fix | risk |
|---|---|---|---|---|---|
| PF1 | Functionality | **"Volume by resource" chart's x-axis is unreadable.** The chart hardcodes `ticks:{stepSize:1}` on the count axis. That's fine when the biggest bar is ~300 (the Region/Office/Rep cuts), but under the **Resource** cut one bar (Sales Rep) reaches 1,718 — Chart.js tries to generate 1,719 ticks, logs `scales.x.ticks.stepSize: 1 would result generating up to 1719 ticks. Limiting to 1000.`, and renders a solid smear of overlapping numbers instead of a legible axis. Reproduced every time: switch the toggle to Resource with any filter. | wrong | Drop the hardcoded `stepSize:1` on `pf-vol`'s x scale (~line 3385) and let Chart.js auto-step, or compute one from the max value (e.g. `Math.ceil(pMaxCount/10)`). | low — chart option only |
| PF2 | Functionality / Accessibility | **Performance-by-\<group\> table rows have no keyboard path.** `pShown.map(d=>'<tr class="drill-tgt" onclick="...">')` (~line 3337) opens the drill drawer on click, but unlike *every other* `.drill-tgt` element in the app it carries no `role="button"`, `tabindex`, or `onkeydown` — the shared `drillAttrs()` helper exists precisely to add those three things and is used on the srail cells, the Current page's `so-row`/`rswk-row` divs, and the Quality reason bars. A keyboard or screen-reader user cannot open a drill from this table. (The identical pattern exists on Quality's group table, line 4782 — out of scope for this pass, but the same fix applies there too.) | rough | Replace the bare `onclick` with `${drillAttrs(pDrill(d.g))}`. | low |
| PF3 | Code health | **`pCycleCell`'s colour thresholds duplicated `pillV()`.** Both compute the identical three-way band — green ≤`targetMedian`, amber ≤`targetAvg+2`, red beyond (docs/METRICS.md's "Pill scale") — but `pCycleCell` (~line 3277) wrote the comparison out again inline instead of calling `pillV()` or a shared helper. They agreed at the time; nothing enforced that they'd stay that way, and `test/surfaces.test.js`'s inline-band guard didn't match this shape (it only greps for the `Math.round(...*10)/10` pattern). **Fixed** — both now call a shared `pillBand(v)`. | nit | ~~Extract a small `pillColor(v)` used by both `pillV()` and `pCycleCell`.~~ Done. | low |

Verified working: Region / Sales office / Sales rep / Resource cuts (chart and
table stay in sync, resource cut correctly hides its own diagonal columns);
search box (filters the table, not the chart — by design, the subtitle says
so; focus and caret survive each keystroke); sort on every column, blanks
sinking in both directions, default Projects-desc; Show-all / show-top-15
expand; row-click drills open the right population with the right title;
"(no region)"/"(no office)" rows present; Copy table; narrow-viewport (480px)
layout — stat rail reflows to two columns, the group table scrolls inside its
own `.xscroll` container rather than the page.

---

## Trends

| # | axis | what I observed | severity | proposed fix | risk |
|---|---|---|---|---|---|
| TR1 | Logic | **The Intake/Completed/Clearance/Weekly-floor strip — and its alarm banner — ignore the date filter entirely.** They're built from `flowWeeks`, which loops off `trendSrc` (dimension filters only) and `flowEnd` (today's export date), never `GF.dateFrom`/`GF.dateTo`. Verified live: switching the filter to **This wk** (a 2-day range) and separately to a **custom January range**, both produced the identical Intake 98 / Completed 92 / Clearance 88% / Weekly floor 105 as under **All**, while the chart above and the Trend/Avg pace/Best week/P75/P90 cards correctly obey the filter. **Doug's call, 2026-08-19: this is intended — the strip works as designed on his end. Left alone.** | — | — (not a bug) | — |
| TR2 | Aesthetics / Functionality | **The Weekly detail table has no `.xscroll` wrapper**, unlike every other wide table in the app (including Performance's own group table, one page over). Confirmed in the DOM at a 480px viewport: the table's `.sec` has `scrollWidth` 562 against a `clientWidth` of 454, and `document.body.scrollWidth` (575) exceeds `window.innerWidth` (480) — the whole page grows a horizontal scrollbar instead of just the table scrolling in its own faded-edge container. | wrong | Wrap `<table id="tr-wtable">…</table>` in `<div class="xscroll">…</div>`, matching `pf-gtable`. | low — structural HTML only |

Verified working: Daily/Weekly toggle on Intake & Flow, and the
Current/First-time completion-basis toggle (Completed swaps 92→96, while
Clearance/Weekly floor correctly stay on the current-truth basis per the
in-code note); P75/P90/Trend(3wk) drills open the right population; weekly
detail table's New In/Completed/WIP cell drills open the right week and kind;
Escape closes the drawer and returns focus to the element that opened it;
Weekly rhythm stays fixed to the trailing 8 weeks regardless of the date
filter, as documented; SS ratio line and Weekly avg cycle bars render and
drill correctly; no console errors besides the PF1 warning above.

---

## On combining Performance and Trends

**Decided 2026-08-19: pages stay separate.** Asked to think about it, not to
build it. My read: don't merge them. The two
pages are already structurally orthogonal, not overlapping — Performance
slices **one time window** by many groups (region/office/rep/resource);
Trends slices **one group (everyone)** by many time windows. Their stat
rails don't share a single metric today (Projects/Avg/Median/OnTarget/
ResourceMix vs. Trend/AvgPace/BestWeek/P75/P90), which is a sign they're
answering different questions, not an oversight.

A literal merge would either double the rail to nine-odd cells — undoing the
entire point of the stat-rail redesign, which exists to compress five or six
KPI cards into "about a sixth of the vertical space" — or force one lens to
drop a metric to fit the other's slots. It also reproduces exactly the
six-surfaces-over-one-shape problem Performance and Quality were each already
rebuilt to get out of.

If the goal is fewer clicks to compare "this region" over time, a cross-link
is cheaper and doesn't conflate two different populations: a drill or button
on a Performance row that opens Trends pre-filtered to that region/office/rep,
the way `drillPerfGroup()` already opens the drawer. Worth doing if you want
it; a page merge isn't.

---

# Full-app audit — 2026-08-14

Phase 1 assessment. Nothing changed yet.

Walked every surface in the browser against live `data.js` (2,538 rows, `DATA_TS`
2026-08-14 15:52), clicking filters, toggles, tabs, expanders, sorts and drills,
and traced displayed numbers back to `lib/metrics.cjs`. Baseline `npm test`:
**65 pass, 0 fail**.

Severity: **broken** (does nothing / unreachable / can't exit) · **wrong** (a
number or state disagrees with another surface or with the register) ·
**rough** (works, reads badly) · **nit**.

Ranked within each surface, worst first.

---

## Batch 1 — applied (correctness)

`npm test` 65/65, **snapshot unchanged** — no metric definition moved. Verified in
the browser against live data; the unfiltered state of every page it touches is
byte-identical to the pre-change baseline.

| finding | now |
|---|---|
| G1 office filter no-op | Performance narrows 2,335 → 498 on one office; `office` also round-trips in the hash now, as `region` already did |
| G2 `#map` not restorable | `applyURLState('#map…')` → `{page:'map'}`; `/va-map` lands on the Map |
| G5 Type filter with no control | `type` removed from `GF`, `syncURL`, `applyURLState`, `applyFilter`, `gfDim`; `FIELDS.type` is now `filterable:false`. The WIP page's own Type control (`wipF.type`) is untouched |
| G4 empty Status widened scope | 0 rows instead of 2,538 |
| G3 count-up settling on a partial frame | target stashed on the node, re-entry guarded — four overlapping passes all land on `+5.3d` |
| W1 WIP filters reached only the table | KPI cards, age bar, "needs attention" count and SS ratio all read the filtered queue; `ssRatioLive` now gets a matching denominator via `wipScoped()`. Open WIP shows "of 113 open · current filter" |
| C1 Last Week WIP card | `109 · ~12.6d` → `109 · ~2.5d` — its own 109 rows, aged with `ssDaysOpen` at the week's close |
| C2 "Still open from last week" | bands on `ssDaysOpen` vs the export date, not Proj Age vs the wall clock |
| P1 two median bands on Performance | resource cards route through `kclsAvg`/`kclsMed`; Radicl's 6.0d median now reads red, matching the KPI card above it |
| X1 compose's inline SS ratio | replaced with `ssRatioForWeek()`; the chart's last point (1.15) now equals the SS RATIO card. The Jul 27 week moves 1.41 → 1.02 |
| X2 `api/generate.js` ratio prompt | renamed to "SS ratio", passes `meanWip` (the actual numerator), and states the real band instead of ">1 is a concern" |
| D1 editor's cycle-time formula | `recalc()` uses `effectiveComplete()`, matching `parse-sf.js` |
| N1 README's wrong SS ratio | rewritten, pointed at `docs/METRICS.md`, plus a Tests section |

**Deferred out of batch 1, deliberately:**

- **W2** (WIP's separate filter bar) — severity "wrong" but the axis is
  Organization and the fix is structural; done in batch 2.
- **A1** (unauthenticated `/api/send-teams`, `/api/team-opener`) — every available
  fix is theatre, a UX change, or a rewrite of the card path. See the note under
  the API table.

---

## Batch 2 — applied (organization + logic clarity)

`npm test` 65/65, snapshot unchanged. Net −144/+90 lines in `index.html`.

| finding | now |
|---|---|
| W2 WIP's private filter bar | Deleted (`buildWIPFBar` and its five handlers, −144 lines). One bar for every page: Region / Office / Status / Resource are shared, so a region picked on Performance carries to WIP and the global Office filter reaches it for the first time. **Sales Rep and Install Type stay WIP-only extras** — nothing else cuts by either. WIP shows no date range at all, because it is a live snapshot and an inert date picker is worse than none; the hint says so: "113 of 113 open · live, not date-filtered" |
| C3 nav badge | reads the attention count (**42**) instead of total WIP (113), matching the WIP page's own toggle, with a title attribute. Renamed `renderNeedsAttn` → `renderWipAttnBadge` and wired into `nav()` so it follows every page, not just Current. Dead `openAttnView()` deleted |
| G6 landing page list | Map added — it was the one page you couldn't start on |
| T1 Trends tooltip | "Weekly avg cycle time" now carries `TIP.cycle`; `TIP.ssRatioWeek` moved onto the SS-ratio legend entry, where the ratio actually is |
| R1 Resurveys headline FPY | under `RS_MIN_CELL` completions it prints `n=8` and "under 10 completions", the same standard the breakdown table already held itself to |
| P2 region sections split apart | reordered to Volume by region → Avg cycle by region → Region detail → Sales rep cycle time. **Charts not merged** — they answer different questions; the real problem was that the rep table sat between them, interleaving rep content with region content |
| P3 rep table subtitle | follows the toggle: "Surveys the rep did themselves · slowest first" vs "Surveys the rep sold, surveyed by Radicl Services · slowest first" |
| X4 compose cohort bars | `isComplete()` instead of a bare `list === 'Complete'`, so the two bars partition the cohort |
| — (found while fixing W2) | **Escape closed two of the three filter dropdowns.** Status was never in the handler's list. Fixed |

### G8 — attempted, reverted

Clamping the auto "All" range to `DATA_CUTOFF` (so the Custom date input stops
showing 2025-08-08) turned out to have two consequences a cosmetic fix has no
business having:

1. It **dropped 3 rows from every date-filtered population** — Performance
   2,335 → 2,332, the Resurveys FPY denominator likewise. Those three are
   exactly the re-signed accounts CLAUDE.md says are correct data: `457AMAMM`,
   `920HHEND`, `2504RIOS-1`, each with a completion months before its start and
   a `ct_total` of 0 via `effectiveComplete()`.
2. The default view stopped showing **All** as the active preset and showed
   **Custom** instead, because `isAll` tests `dateFrom === fullFrom`.

Reverted. Every remaining fix either changes that population by 3 rows or makes
the `autoDateRange` setting a no-op, so **this one is yours to call**: should the
default view include the three re-signed accounts, or not? It is a one-line
change once decided.

---

## Batch 3 — applied (aesthetics, motion, feel)

`npm test` 65/65, snapshot unchanged. `index.html` only, +41/−14.

| finding | now |
|---|---|
| G7 two control vocabularies in one bar | Single-select filters are `.fselgrp` — one bordered unit, 28px like the pill buttons, sentence-case label inside it, active state matching `.rgdrop-btn.active`. Kept as native `<select>` deliberately: Sales Rep runs to ~50 names here and type-ahead plus the platform picker beat a hand-rolled panel |
| G9 every card advertised a click | The lift and shadow are `.kcard.drill-tgt:hover` now; non-drillable cards get a flat border tint. Only cards that open a drawer behave like they do |
| W4 concatenated tooltip | Avg age carries `TIP.avgAge` alone — 134 chars, down from ~400. "Days Open in SS" is already defined on the column header |
| M1 Map "Top market" had no info dot | Added, with two new TIP entries (`mapTopMarket`, `mapTopLocation`) explaining that position comes from the address ZIP and that towns group by name, not ZIP |
| T3 intake delta was a grey caption | Banded like the Clearance figure beside it — rising intake red, falling green, bold past ±10%. Currently reads **−45%** in green |

### T2 — withdrawn, not a real finding

I reported the first Trends render at 1.77 s "measured once". Re-measured on a
cold load: **138 ms**, and 74 ms warm. The 1.77 s reading was the Browser pane
being `document.hidden`, which stops `requestAnimationFrame` — the same
condition that produced several blank screenshots during the audit. The app was
never slow here. Nothing to fix.

### Known, not fixed

The WIP bar carries seven controls and wraps Reset + the hint onto a second row
**below about 1400px**. One row at 1512px, two at 1280. Left alone rather than
shrinking the selects to fit an arbitrary width; no horizontal overflow at any
size, including 375px.

---

## Batch 4 — applied (code health)

`npm test` 65/65, snapshot unchanged. **−176/+62 lines** across six files.

| finding | now |
|---|---|
| G12 orphaned CSS | **Zero orphaned classes**, down from 40. Removed whole components: the `.verdict` band (21 rules, superseded by the `.brief-*` hero), the old SF modal (`msteps`/`mfield`/`mhint`/`mprev`/`macts`/`mbtn-sf`), the Settings `field-status` block, the outlier slider and tag, `res-split-*`, `roll-*` + `.rolling`, plus `g2`/`g3`/`pctbar`/`pctfill`/`minibar`/`barcell`/`fglobal`/`lroll`/`tbtn`/`upd-or`/`rs-sched-pill`/`exec-sub`/`vsep`. Also `.flabel` and `.fsel-on`, which batch 3 orphaned. Pruned `.tbtn:active` and `.g2,.g3` out of two grouped selectors rather than deleting the rules |
| G10 dead JS | `trailing4WeekPace()`, `_mapBoundsKey`, `pendingFields`/`pendingList` deleted. `clearFenceCache()` was an empty function called from **6** sites — function and all calls gone |
| G11 stale comments/markup | The "Seeded LCG — deterministic dummy rows" comment above nothing, the empty `/* TOAST */` marker, the hardcoded `766 projects` in the nav badge, and `wipStatusSel`'s comment claiming it only applied under a single age band |
| A2 duplicated prompt | The 15-line opener prompt lived verbatim in two API files. Extracted to `api/_opener-prompt.js` with the model and token budget beside it; both callers import it |
| A4 morning-card timezone | `computeStats` ran on the server's UTC clock while every date in the data is Mountain, so after 17:00 MT "yesterday" was already today and Monday's Friday-lookback fired on the wrong day. Anchored on the Mountain date throughout |
| N2 README gaps | File map now lists `docs/`, `test/`, `scripts/`, `geo/`, `queues/`, `api/upload-data.js` and the shared prompt |
| N3 METRICS.md gaps | Added the six numbers the register didn't cover: `pctTgt` (On target), Cost of a resurvey, the **queue-age band** (green ≤target / amber ≤7d / red >7d — written inline in four places and the strongest candidate for W3), the `pillV` scale, compose's `iqrFence`, and `/queues` as an undocumented surface |
| CLAUDE.md | Recorded the decisions that changed: one filter bar for every page, no global Install Type, WIP KPIs follow the page filter, the nav badge is the attention count, office bites in `applyFilter`, and compose's chart line uses `ssRatioForWeek` |

Verified after the CSS purge: all eight pages render at the same content volume,
no element references a removed class, no console errors, and Current reads
identically to the pre-cleanup baseline (79 · ~143 · 24 · 7.2d · 113).

**Not done — Q1/A3, `/queues`.** Deleting a live route, its page, its Supabase
pipeline and a dependency is not code-health cleanup, and its third copy of the
field registry (`api/upload-data.js`) only matters if the surface stays. Flagged
in the README and the register instead. **Your call.**

---

## Still open after four batches

Everything below needs a decision, not a cleanup pass:

| # | what | why it's yours |
|---|---|---|
| A1 | `/api/send-teams` + `/api/team-opener` have no auth | Every in-code fix is theatre; the real answers are Vercel Deployment Protection or building the Teams card server-side |
| Q1 / A3 | `/queues` is a live, undocumented surface with its own data path | Document it or retire it |
| W3 | The `>7d` queue-age band is written inline in four places | Naming it in `lib/metrics.cjs` is a definition change |
| G8 | The default range starts before the cutoff because of 3 re-signed accounts | Any fix moves those 3 rows in or out of every date-filtered population |
| X5 | compose's password gate runs after 2,538 customer rows are already loaded | Product tradeoff for an internal tool |
| P4 | `pillV` and `pctTgt` band inline, on purpose | Now documented in the register; promote to shared definitions only if you want them uniform |

## Global — filter bar, nav, routing, animation

| # | axis | what I observed | severity | proposed fix | risk |
|---|---|---|---|---|---|
| G1 | Functionality | **The Office filter does nothing on Performance.** Selecting `"Solar's Dead" - CTRL` lights the button, adds a chip, and leaves every number identical: 2,335 projects before and after, hint still "2335 of 2448 shown". `gfDim()` has the office clause; `applyFilter()` (which builds `filtered`, the Performance source) does not. Trends/Resurveys/Map do respond. | broken | Add the office clause to `applyFilter()` alongside region/type/resource. | low — Performance numbers change only when an office is selected |
| G2 | Functionality | **`#map` is not a restorable page.** `nav('map')` writes `#map?from=…` to the URL, but `URL_PAGES` omits `map`, so `applyURLState()` returns `null` and a reload lands on the last saved page. The `/va-map` → `/#map` redirect in `vercel.json` therefore never reaches the Map. | broken | Add `'map'` to `URL_PAGES`. | none |
| G3 | Accuracy | **A KPI can settle permanently on a partial animation frame.** Observed on Resurveys: "Cost of a resurvey" read **+0.3d** while its own subtitle read "4.0d clean → 9.3d resurveyed" (true value **+5.3d**), and stayed there across two screenshots and a DOM read. `countUp()` takes its target out of live DOM text, so a second pass over an element already animating captures a partial frame as `raw` and settles on it. Two `animateSections()` runs on the same nodes ~10–50 ms apart trigger it; a backgrounded tab makes it stick, because `rAF` stops and only the `setTimeout` backstop fires. | wrong | Renderer writes the final string to `data-val`; `countUp` reads that, and no-ops if the element is already animating. | low |
| G4 | Logic | **Unchecking every Status checkbox widens the scope instead of emptying it.** `scopeRows()` treats an empty list as "no filter", so the page jumps from 2,448 scoped rows to all **2,538** — including At-Risk and Canceled — while the button reads "Status · 0" and highlights as active. | wrong | Empty selection → zero rows (with an empty state), or refuse to uncheck the last item. | low |
| G5 | Functionality | **Install Type is filter state with no control.** `type` is `filterable:true`, is applied by `applyFilter()` and `gfDim()`, and round-trips through the hash as `?type=`, but `buildFBar()` explicitly excludes it from the dropdowns. A shared link carrying `?type=` silently filters with nothing in the bar to show it or clear it. | wrong | Either render the control, or drop `type` from `defaultF()`, `syncURL`, `applyURLState`, `applyFilter` and `gfDim`. **Needs your call on which.** | low |
| G6 | Organization | The **Data** page has no nav entry — reachable only via Settings → "Source Data ↗" (or by typing `#data`). Settings' "Default landing page" list omits both **Map** and **Data**, so neither can be a landing page. | rough | Add Map (and Data, if it should be reachable) to the landing-page list; decide whether Data deserves a nav slot. | low |
| G7 | Aesthetics | Filter-bar controls use two vocabularies: Region / Office / Status are pill buttons with a `▼` caret and checkbox panels; Resource is a bare native `<select>` preceded by an uppercase `RESOURCE` label. They sit adjacent and read as different kinds of control. | rough | Give Resource the same `rgdrop` treatment, or drop the uppercase label so it reads as one row. | low |
| G8 | Logic | The default "All" range resolves to **2025-08-08 → 2026-08-14**, starting ~5 months before `DATA_CUTOFF` (2025-12-29). `clearF()`/init take min/max of *completion* dates and three rows carry a completion long before their start. Under **Custom** the from-field shows a date no in-scope row can match. | nit | Clamp the auto range's lower bound to `DATA_CUTOFF`. | low |
| G9 | Motion | `.kcard:hover` lifts and shadows every KPI card, but only `.drill-tgt` cards are clickable. Most cards advertise an interaction they don't have. | nit | Restrict the lift to `.drill-tgt`; leave a flat hover elsewhere. | low |
| G10 | Code health | Dead code: `openAttnView()` (:2111) and `trailing4WeekPace()` (:2117) are defined and never called; `_mapBoundsKey` (:4330) declared, never read; `pendingFields`/`pendingList` (:4832–4834) computed in `renderSettings` and never used; `clearFenceCache()` (:1097) is an empty function called from 7 sites. | nit | Delete. | none |
| G11 | Code health | Stale comments and markup: `// Seeded LCG — deterministic dummy rows for Jan/Feb Trends demo` (:1308) sits above nothing; an empty `/* TOAST */` block (:439); the nav badge ships hardcoded `766 projects` before JS overwrites it; `wipStatusSel`'s comment (:1027) says "only applies when exactly one band selected" but :3391 applies it unconditionally. | nit | Remove / correct. | none |
| G12 | Code health | **~37 CSS classes are defined and never used.** Whole components: the `.verdict` band (`verdict-ok/warn/bad/word/text/go`, `vsep`) superseded by the `.brief-*` hero; the old modal (`msteps`, `mfield`, `mhint`, `mprev`, `macts`, `mbtn-sf`); the Settings field-status block (`field-status`, `fs-row`, `fs-active`, `fs-pending`); outlier controls (`outlier-ctrl`, `outlier-badge`, `outlier-tag`). Plus `roll-up/dn/flat`, `res-split-bar/dot/legend`, `g2`, `g3`, `pctbar`, `pctfill`, `minibar`, `barcell`, `fglobal`, `lroll`, `tbtn`, `upd-or`, `rs-sched-pill`, `exec-sub`. | nit | Delete, one component at a time. | low — verify each against the rendered pages first |

---

## Current

| # | axis | what I observed | severity | proposed fix | risk |
|---|---|---|---|---|---|
| C1 | Logic | **The Last Week "WIP" card mixes two populations and two age definitions.** It prints **109** (WIP as of last Sunday) with "**~12.6d avg age**" — computed over the **113 currently open** surveys, using **Proj Age** (`start` → wall clock). The identically-labelled card on the This Week tab, the WIP page's Avg age, and the Map's Avg days open all read **4.8d** (`ssDaysOpen` vs the export date). Both cards carry `TIP.wip`. | wrong | Age the card's own 109 rows with `ssDaysOpen(r, lw.to)`, or drop the age line from the Last Week card. | low |
| C2 | Logic | "Still open from last week" bands its three rows on `dDiff(start, wall-clock today)` — Proj Age again, and against the wall clock rather than the export date, so the bands drift as the export ages. Labels read "on track / at risk / needs attn", which is queue language. | wrong | Band on `ssDaysOpen(r, dataThrough)`. | low — moves rows between bands |
| C3 | Organization | The nav **WIP badge shows total open WIP (113)**, styled as a blue attention pill. The actual attention count (**42**) exists — `attnItems()` drives the WIP page's "Needs attention · 42" toggle — but never reaches the badge. | rough | Point the badge at `attnItems()`, or restyle it as a neutral count. | low |
| C4 | Code health | `renderNeedsAttn()` now does nothing but paint that badge; its name and its comment ("Compact strip on Current — the full working view lives on the WIP page") describe a strip that no longer exists. | nit | Rename / retitle, or fold into `renderWeek`. | none |
| C5 | Accuracy | Last Week counts completions with `everCompleted()` and This Week with `isComplete()` — correct and documented, but the two tabs' cards are not comparable and nothing on screen says so. The tooltips differ (`TIP.firstComplete` vs `TIP.complete`); the card labels don't. | nit | Label the Last Week card "Completions (first-time)". | none |

---

## Performance

| # | axis | what I observed | severity | proposed fix | risk |
|---|---|---|---|---|---|
| P1 | Accuracy | **Two different median bands, 40 px apart.** Radicl's resource card shows Median **6.0d in amber**; the "Median total" KPI card directly above bands medians with `bandFor(v, targetMedian)`, which makes 6.0d **red**. The resource cards band inline: green `≤targetMedian`, amber `≤targetAvg+2` (≤6), red beyond. | wrong | Replace the inline band with `bandFor(rMed, S.targetMedian)` / `bandFor(rAvg, S.targetAvg)`. | low — Radicl's median pill turns red, which is what the page's own rule says |
| P2 | Organization | Three region sections stack: **Volume by region**, **Avg cycle by region**, **Region detail**. The two charts plot the same 16 regions in the same order with the same labels; the reader scrolls two chart-heights to compare two numbers about the same list. | rough | Merge the two charts into one (stacked volume + a cycle marker), or move Region detail directly under Volume. | medium — layout change |
| P3 | Organization | The "Sales rep cycle time" toggle silently changes what the table measures — under **w/ Radicl** the rows are Radicl's cycle time attributed to the sales rep — while the title and the "Slowest first" subtitle never change. | rough | Fold the toggle's meaning into the subtitle. | low |
| P4 | Code health | Band logic computed inline in three places on this page: `pillV()`, the resource-card avg/median, and `pctTgt()`'s implicit `≤targetAvg`. None goes through `bandFor`. | nit | Route through `bandFor` where the bands genuinely match; otherwise name the exceptions in `docs/METRICS.md`. | low |

---

## Trends

| # | axis | what I observed | severity | proposed fix | risk |
|---|---|---|---|---|---|
| T1 | Accuracy | The **"Weekly avg cycle time"** section heading carries `kinfo(TIP.ssRatioWeek)` — hovering the info dot beside a cycle-time title returns a paragraph about the SS ratio. The SS ratio is the second series on that chart, but it has no icon of its own. | rough | Move the icon to the SS-ratio legend entry, or add a second `kinfo` and give the heading `TIP.cycle`. | none |
| T2 | Motion | The **first** visit to Trends after a page load blocked for **1.77 s** before anything below the KPI row painted (measured once; subsequent navs 73–81 ms). Five Chart.js instances plus a 1,077 px table are built in one synchronous pass. | rough | Build the charts below the fold on a second frame, or show skeletons. | low |
| T3 | Aesthetics | The Intake stat shows "**−46% vs prior week**" as an unstyled grey caption — the largest week-over-week move on the card, rendered quieter than the Clearance figure beside it. | nit | Band the delta the way Clearance is banded. | none |

---

## WIP

| # | axis | what I observed | severity | proposed fix | risk |
|---|---|---|---|---|---|
| W1 | Logic | **The page's filters reach only the table.** Filtering to `CA Fresno` leaves **1 row** in the queue, while all five KPI cards stay national (**113** open · 4.8d avg · 2d median · 46% on track · 1.2wk SS ratio) and the "WIP by age & schedule status" bar stays national too (`<5d 55 · 5–15d 30 · 15–30d 14 · 30–60d 10 · 60–90d 2 · >90d 2` = 113). Clicking "`<5d 55`" then filters a 1-row table. `allWip` and `paWip` both read `rows`, not `wipFiltered()`. | broken | Compute the KPI row and the age bar from `wipFiltered()`; keep the unfiltered total as the "of N total" context line that already exists. | medium — every WIP KPI moves when a filter is on. Verify the unfiltered case is byte-identical first |
| W2 | Organization | **WIP has a second, disconnected filter bar.** Its Region is `wipF.region`, not `GF.region`, so a region chosen on Performance does not carry here; it offers a **Sales Rep** control no other page has; and it has **no Office control**, so the global Office filter cannot reach the page at all. Only Status is shared. | wrong | Fold the WIP bar into the global bar (WIP simply ignores the date range, as Resurveys and Map already do), keeping Sales Rep as a WIP-only extra. | medium — touches `wipFiltered`, `buildWIPFBar`, and the saved filter shape |
| W3 | Accuracy | The **Avg age** and **Median age** cards sit side by side under two different inline band scales: Avg is `≤targetAvg` / `≤7`; Median is `≤targetMedian` / `≤targetAvg`. Neither uses `bandFor`. The `>7d` threshold is the page's real aging rule (it also drives `agePill`, `ageRowBg` and `attnItems`) but exists nowhere in `lib/metrics.cjs`. | rough | Name the queue-age band in `lib/metrics.cjs` (e.g. `queueAgeBand`) and use it for the pills, row tints, cards and attention rule alike. **This adds a definition — flagging, not doing it as cleanup.** | low |
| W4 | Aesthetics | The Avg age tooltip is `TIP.avgAge + ' ' + TIP.ssDaysOpen` — two full definitions concatenated into one ~55-word tooltip, the longest on the page. | nit | Keep `TIP.avgAge`; the Days Open column header already carries `TIP.ssDaysOpen`. | none |

---

## Resurveys

| # | axis | what I observed | severity | proposed fix | risk |
|---|---|---|---|---|---|
| R1 | Logic | **The headline FPY has no minimum-sample guard.** Filtered to `CA Fresno` the card reads a confident "**75.0%** — 2 of 8 completions came back", while the breakdown table on the same screen refuses to rate any cell under `RS_MIN_CELL` (10) and prints `n=8` instead. The page holds itself to a standard its own headline doesn't meet. | rough | Below `RS_MIN_CELL`, render the headline as `n=8` too, or keep the number and add the sample caveat under it. | low |
| R2 | Accuracy | Everything else on this page traced clean: one population (`isResurveyDefect`) across FPY, the weekly chart, reasons, attribution, resource, office and rep cuts; the open queue is a live snapshot as documented; no time control of its own. No action. | — | — | — |

---

## Map

| # | axis | what I observed | severity | proposed fix | risk |
|---|---|---|---|---|---|
| M1 | Aesthetics | "Top market / Top location" is the only Map KPI without an info dot; the three around it all have one, so the row reads ragged. | nit | Add a `kinfo`, or accept it as self-explanatory and say so. | none |
| M2 | Accuracy | Map Avg cycle **3.9d over 2,334 completions** vs Performance's **3.9d over 2,335** — one row can't be placed from its address. Disclosed in the note under the map. No action. | nit | — | — |

---

## Compose (`compose/index.html`)

| # | axis | what I observed | severity | proposed fix | risk |
|---|---|---|---|---|---|
| X1 | Accuracy | **The Monday email's SS-ratio card and the SS-ratio line in the chart directly beneath it use different definitions.** The card calls `ssRatioForWeek()` (7-day mean WIP). The chart line is computed inline at `allTrend[i].pipeRatio = wipEow / avgC` — end-of-week WIP over a 3-week completion average, exactly the definition `lib/metrics.cjs` was written to replace. Across the last 20 weeks they diverge by up to **+38%**: week of 2026-08-02 the card reads **1.02** and the line's point reads **1.41**. | wrong | Replace the inline `pipeRatio` with `ssRatioForWeek(ROWS, wE)`. Violates the single-source rule as it stands. | low — moves the historical line, not the card |
| X2 | Accuracy | `api/generate.js` hands Claude: `Pipeline ratio: 1.15× (109 open ÷ 95.3 avg completions/wk last 3 weeks — ratio >1 is a concern)`. Three problems: the retired name; `stats.wip` is the end-of-week snapshot, **not** the mean numerator the ratio was actually built from (`stats.meanWip` exists and is unused); and "**>1 is a concern**" contradicts `ssRatioBand()`, where 1–2 is the deliberately-uncoloured normal operating band and 2.0 is the alarm. The AI commentary in the Monday email is primed to call a normal week a problem. | wrong | Rename to "SS ratio", pass `stats.meanWip`, and restate the band as "1–2 is normal; 2+ is the alarm". | low |
| X3 | Code health | Thresholds hardcoded rather than shared: `x<=4` in `onTargetPct` and `weekOnTargetPct`; `>6`/`>4` in the Monday observations; `>4`/`>7` in the overdue-WIP observation; `>6`/`>4` in the daily observations. The dashboard reads these from `S.targetAvg`/`S.targetMedian`. | rough | Lift the two targets to named constants at the top of compose, or export them from `lib/metrics.cjs`. | low |
| X4 | Accuracy | `cohortComplete` tests `r.list === 'Complete'` and `cohortActive` tests `r.list && r.list !== 'Complete' && r.list !== 'Not Required'` — a list-only completion test sitting a few lines from `isComplete()`. Feeds the stacked bars in the Monday chart. | rough | Use `isComplete()` for the Complete cohort, or document why the list-only test is right here. | low |
| X5 | Functionality | The password gate is `prompt()` against a plaintext `const PASSWORD = 'sunpower'`, and it runs **after** `data.js` has already loaded all 2,538 rows — customer names, phone numbers and email addresses — into the page. Rejecting the prompt replaces `document.body` but the data is in memory and in the network log. | rough | Note it as an internal-tool tradeoff, or move the gate server-side. **Your call — this is a product decision, not cleanup.** | — |

---

## API

| # | axis | what I observed | severity | proposed fix | risk |
|---|---|---|---|---|---|
| A1 | Functionality | **`/api/send-teams` and `/api/team-opener` have no authentication.** Anyone who can POST to the deployment can push an arbitrary Adaptive Card into the team's Teams channel, or burn Anthropic tokens. `/api/update` is password-gated; these two aren't. | wrong | Gate both behind `UPDATE_PASSWORD` (or a second shared secret). | low |
| A2 | Code health | The 15-line morning-opener prompt is duplicated **verbatim** in `api/morning-card.js` and `api/team-opener.js`. | nit | Extract to one module both import. | none |
| A3 | Code health | `api/upload-data.js` carries a **third** copy of the field registry (after `index.html` and `parse-sf.js`), missing `agreement_signed`, `sales_office`, `m1a_approved`, `field_survey_scheduled`, `field_survey_complete`. | rough | Import a shared registry, or retire the endpoint with `/queues` (see Q1). | low |
| A4 | Accuracy | `api/morning-card.js` derives "yesterday" from the server clock via `toLocaleDateString('en-CA')` — UTC on Vercel — while every date in the data is Mountain. Harmless for a morning run, wrong after 17:00 MT. | nit | Pass `timeZone: 'America/Denver'`, as `api/update.js` already does. | none |

### Why A1 was left alone

These pages are static files, so any secret compose could send is public — a
shared token stops `curl`-by-URL and nothing more, and an `Origin` check is
forged in one flag. The fixes that would actually hold are all bigger than
cleanup, and each is a product decision:

1. **Vercel Deployment Protection** on the project — covers every route at once,
   costs a login, no code. Probably the right answer, and it also addresses X5.
2. **Stop accepting an arbitrary `card` from the client** in `/api/send-teams` —
   build it server-side from `data.json`, or validate the payload against the
   expected shape. Removes "post anything to the team channel" without any auth,
   but means mirroring compose's `buildAdaptiveCard()`.
3. A shared token, accepting that it only raises the bar to "view source".

`/api/team-opener`'s exposure is small in practice — Haiku, `max_tokens: 120`,
so roughly $0.0001 a call. `/api/send-teams` is the one with real downside.

---

## `/queues` — an undocumented live surface

| # | axis | what I observed | severity | proposed fix | risk |
|---|---|---|---|---|---|
| Q1 | Organization | `vercel.json` routes `/queues` and `/queues/(.*)` to `queues/index.html` — a full 19 KB page, last touched 2026-06-23, with its **own Supabase-backed data pipeline** (`/api/upload-data`, a publishable Supabase key, the `@supabase/supabase-js` dependency) and its own copy of the field registry. It appears in **no** documentation: not README, not CLAUDE.md, not `docs/METRICS.md`, not this audit's own surface list. | rough | Decide: document it as a real surface, or retire it (page + route + `api/upload-data.js` + the Supabase dependency). **Your call.** | low |

---

## Data page / source editor

| # | axis | what I observed | severity | proposed fix | risk |
|---|---|---|---|---|---|
| D1 | Accuracy | `recalc()` in `index.html` computes `ct_total = dDiff(start, complete)`; `parse-sf.js` computes it as `dDiff(start, effectiveComplete(r))`. Editing any date on one of the 5 re-signed rows silently swaps the row onto the other formula. | rough | Have `recalc()` call `OpsMetrics.effectiveComplete(r)`. | low — affects 5 rows, and only after an edit |
| D2 | Functionality | The editor works end to end (search, state filter, paging, inline edit, add, delete, CSV export, Apply, Reset), and is honest that changes are session-only. No action. | — | — | — |

---

## Docs

| # | axis | what I observed | severity | proposed fix | risk |
|---|---|---|---|---|---|
| N1 | Accuracy | **README's metric section contradicts `lib/metrics.cjs` on the SS ratio**: "end-of-week WIP ÷ average completions of the 3 most recent full weeks — **Above 1.0 is a concern**." The numerator is the 7-day mean, not the end-of-week close, and 1–2 is the deliberately-uncoloured normal band. This is the same wrong definition compose's chart implements (X1) — the README is very likely where it came from. | wrong | Rewrite to match `docs/METRICS.md`, or replace the section with a pointer to it. | none |
| N2 | Accuracy | README is stale on four more points: the page list omits **Map**; row scope is described as `project_status ∈ {In Progress, Change Order}` (`inScope` also admits any completed survey, and 'Complete' is in the default Status filter); "FPY (**pending SF fields**)" — those fields are live and shipping; no mention of `test/`, `npm test`, `docs/METRICS.md`, `geo/`, `scripts/`, `queues/`, or `api/upload-data.js`. | rough | Update. | none |
| N3 | Accuracy | `docs/METRICS.md` doesn't cover four displayed numbers: **On target ≤4d** (`pctTgt`, on Current, Performance and the region tables), **Cost of a resurvey** (`penalty = dirtyCt − cleanCt`, Resurveys), **compose's IQR outlier fence** (`iqrFence`, Monday email), and **compose's inline weekly `pipeRatio`** (X1). | rough | Add to "Known non-shared numbers". | none |

---

## What passed

- Every metric on the Resurveys page traces to one population (`isResurveyDefect`); no second local definition.
- Map, Resurveys and Trends all take time from the filter bar only — no page-local scrubber crept back.
- Cycle time anchors on Project Start everywhere; `wipAgeFrom` and `ssDaysOpen` are not conflated in any surface.
- `ssRatioForWeek` / `ssRatioLive` stay distinct; the WIP card reads 1.2wk live, the Trends line plots the weekly variant, partial weeks are dropped.
- WIP totals agree across Current (113), the WIP page (113) and the Map's Open WIP mode.
- Empty and near-empty states behave: Performance shows a proper message, Resurveys and Trends degrade to em-dashes rather than 0 or NaN, and the Resurveys "Open now" card correctly stays live under an empty date range.
- WIP row expansion (one panel at a time, keyboard-operable, scroll compensation, `prefers-reduced-motion`) works as built.
- No console errors and no failed network requests on any page.
- `parse-sf.js` sanity report, entity decoding, and `push.sh` guards all behave.

---

## Coverage note

This is one pass, and it did not thin out — the last surfaces (compose, API,
`/queues`, docs) produced as much as the first. The findings above are what I
observed, not what the code implies; where I could not reproduce something
deterministically (G3) I've said so.

Two items are **not** cleanup and need your decision before anything is done:
**G5** (render the Type control or delete the state), **W3** (adding a queue-age
band to `lib/metrics.cjs` is a definition change), and **Q1** (document or retire
`/queues`). **X5** is a product tradeoff, not a bug.
