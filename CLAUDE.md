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
- parse-sf.js prints a non-blocking import sanity report to stderr (surveys predating the agreement, dup ids, unknown resources, rep-name casing, stale schedules, row-count swings, resurveys resting on a bare `reopened_by_design` flag); push.sh surfaces it automatically. It also **decodes HTML entities** — SF ships free text escaped, so offices arrive as `"Solar&#39;s Dead" - Dragons`
- **Sales office is a global filter** alongside Region, applied through `gfDim` **and `applyFilter`** so it reaches every page. It only ever lived in `gfDim`, which meant Performance — the one page reading `filtered` — showed an active button, a chip and identical numbers (fixed 2026-08-14). Both the filter and the Resurveys breakdown hide/fall back on exports predating 2026-08-06, which have no office field
- **One label scale, every page** (added 2026-08-17). A single 10px uppercase `.05em` style used to do four jobs at once, so four ranks of information read as one. The seven roles: section/KPI label 11/600/.07em uppercase `--muted` · panel title 13/700 sentence `--text` · panel subtitle 11/400 `--faint` · table header 11/700 sentence `--muted` · chart legend 11/400 `--muted` · axis tick 10/400 `--faint` · footnote 10/400 `--faint`. **10px survives only as axis ticks and footnotes**
- **Hover means "this opens something"** (added 2026-08-17). Lift and shadow are reserved for it — `.drill-tgt` cards and the `.wip-expand` caret. Panels (`.sec`) and plain KPI cards have no hover state at all; `.pill` does not scale (most pills are status readouts in table cells, not controls); filter chips darken their border one step with no transform. Row hover is one value, `var(--bg)`, not the three off-whites it was
- **Glass means "this is a layer over the page"** (added 2026-08-24). The app is
  otherwise matte — hairline borders, 4–5% shadows, no gradients — so glass is the
  only material effect in it and has to carry a meaning or it is decoration. The
  rule: a surface gets glass when it floats over the page. That is the drill
  drawer, the modal, the region/office dropdown, the mobile More menu and the nav.
  **Never cards, panels, the stat rail or tables** — those *are* the page, and
  glossing them would also fight "charts deliberately muted so status stays
  loudest". Things not to undo:
  - **One token set, `--glass*` in the first `:root`.** Fills (`--glass` body /
    `--glass-strong` chrome), `--glass-edge` + `--glass-hl` for the edge,
    `--glass-shadow`, `--glass-blur`, and `--glass-dark` / `--glass-dark-edge`
    for the nav. Tune the material in one place, not per component
  - **The edge is a hairline plus an inner highlight, not a drawn grey border.**
    On a near-white page a `--border` line and a tight dark shadow are how you
    separate an *opaque* panel; glass separates by refraction. Each surface gets
    a near-transparent edge and an `inset` white highlight, which is what reads
    as the thickness of the pane
  - **The nav is glass at *both* breakpoints**, though only the ≤860px sticky one
    has anything passing under it — beside the 180px sidebar, content never goes
    under it, so there the glass is a static tint. It is there anyway because the
    nav is one permanent component and a component that changes material at a
    breakpoint reads as a bug. `--glass-dark` is `.76` because that lands both
    ends on the same tone (~`#494847` over the warm page background, ~`#4a4a4a`
    over light content). This overrides the floats-over-the-page rule on purpose
  - **Sidebar accents are translucent white, never a fixed dark grey.** The
    `#2c2c2c` dividers / active-tab fill and the `#333` WIP badge were tuned to
    sit on `#111`; against the glass nav's lighter effective tone they go *darker*
    than their own background and the active tab inverts from raised to recessed.
    `rgba(255,255,255,.13)`/`.16` is lighter than whatever it lands on, so it
    holds at both breakpoints
  - **`.nmenu-dropdown` must stay outside `<nav>`.** `backdrop-filter` makes an
    element the containing block for `position:fixed` descendants, so nested in a
    nav carrying `overflow-y:hidden` the menu is clipped away entirely. Moving it
    out also stopped an item click bubbling to `mobileMoreBtn` and re-opening the
    menu `nav()` had just closed
  - **`.nmenu-more` and `.nmenu-dropdown` need their base `display:none`.** Every
    other `.nmenu-*` rule lives inside the 860px block, so with no base rule they
    are unstyled divs on desktop and render as loose text in the sidebar. The
    button had always leaked there
  - **`backdropIn` must end on the same value `.mback` sets.** It runs `forwards`,
    so its end state silently overrides the CSS rule — the dim looks unchanged no
    matter what you edit on `.mback`
  - **`.nav::after` fades to `--glass-dark`, not opaque `#111`.** It is the
    horizontal-scroll cue; an opaque stop paints a black smudge on a glass nav
  - `.ktip` and `.toast` stay **opaque** on purpose: both are dark chips carrying
    10–12px text over arbitrary content, and translucency there costs legibility
    while revealing nothing worth reading
- **`index.html` has a second stylesheet.** A "REDESIGN SKIN" block near the
  bottom re-declares `:root` and restyles many components (`.nav` as the fixed
  sidebar, `.ntab`, `.brand`, the exec hero, cards) as **base** rules, so it wins
  over everything earlier in the file. Edit a component's colour near the top and
  the change can be silently dead — check for a later definition first. The skin
  does not touch `.drill-panel`, `.modal`, `.mback` or `.rgdrop-panel`
- **One filter bar, every page** (`buildFBar`). WIP used to render a private bar against its own `wipF`, so a region chosen on Performance did not carry over and Office could not reach it at all. Region / Office / Status / Resource are shared; **Sales Rep and Install Type are WIP-only extras** in `wipF`, since nothing else cuts by either. WIP shows **no date range** — it is a live queue, and the hint says so. Don't reintroduce a second bar
- **There is no global Install Type filter.** `type` had filter state, a `gfDim`/`applyFilter` clause and a `?type=` URL param but no control anywhere, so a shared link could filter every page invisibly. Removed 2026-08-14; `FIELDS.type` is `filterable:false`. The WIP page's Type control is separate state
- **The stat rail is one shared component** (`.srail` / `.srail-cell` / `.srail-val` / `.srail-sub`), used by WIP, Performance and Trends. It replaced five and six KPI cards per page: the figures carry in about a sixth of the vertical space and, sharing one surface, stop implying they are equally important things. Cell padding must stay uniform, since `flex-basis:0` sizes the content box. WIP adds `.rail-f` cells that filter the queue below; the other pages use `.rail-d`, which opens a drill and is marked with the same `↗` the KPI cards used. The inline `.srail-sub` sits beside the value, so it has to stay short or the cell wraps and stops matching the others
- **Performance is a stat rail, one chart and one table** (rebuilt 2026-08-18). It was five KPI cards, three resource cards, a volume chart, a cycle chart, a region table and a rep table: six surfaces over one shape, since region, office, rep and resource all answer group / count / avg / median / on-target. Things not to undo:
  - **One grouping, four cuts**: Region (default) · Sales office · Sales rep · Resource. The toggle drives the chart and the table together. Sales office had no cut here at all before, though it is the more actionable org unit
  - **The rep cut's three resource columns replaced a three-state toggle.** Self-done / w/ SunPower / w/ Radicl silently changed which population the table measured while the heading stayed put. 103 of 300 reps have jobs under more than one resource, so a third of the roster could not be compared without flipping between states. Each cell carries the cycle time and the survey count it came from
  - **No floor and no dimming**, Doug's call 2026-08-18: a rep with two deals still did those two surveys. The table opens sorted by **Projects desc**, not slowest-first: with no floor, slowest-first led every cut with a one-survey group, so a single 16d region outranked 219 surveys at 4.6d. Slowest-first is one click on the Cycle header. Reach comes from search, sort and an expander instead. The cuts run 58 regions, 173 offices and 300 reps, so the search box is load-bearing, not a nicety. Every row carries Projects beside its average, which is what lets a thin number be read as thin without hiding it. `S.minRegionVolume` and the `.dim-row` treatment were deleted with the dimming, including the Settings control
  - **The blank bucket gets a row.** `regionStats()` skipped rows with no region, so 72 completions fell off the page; the cuts now emit `(no region)` / `(no office)` and the drill resolves it to the rows that genuinely have no value
  - **The chart caps at 16 groups by volume, the table does not.** A display cap on a chart is not a floor on the data, and the subtitle says which it is
  - Grouped BY resource, the three per-resource columns are the diagonal of their own table, so they are hidden on that cut
- **The WIP page's stat rail and bars follow the page filter**, not just the table. They read `wipFiltered()`; the SS ratio takes both numerator and denominator from `wipScoped()` so it never divides one population by another. Filtering to a region with no recent completions correctly shows "—", not a national figure
- **The WIP page is a stat rail + one queue panel** (rebuilt 2026-08-17):
  - Rail cells: Open now · Avg age · Over 15 days · Unscheduled · Open resurveys · SS ratio. Median age and On-track ≤4d were dropped with the five KPI cards. Cell padding must stay **uniform** — trimming the first and last cell's inner padding makes those two 18px narrower, because `flex-basis:0` sizes the content box and padding is added on top of an equal share rather than taken out of it. Active/hover state on the three filter cells therefore rides on background and an **inset** box-shadow: a border or a padding change would resize just that cell
  - **Three rail cells filter the queue** (2026-08-17): Over 15 days, Unscheduled and Open resurveys. Each drives a control that already exists below it — the age bands, the Unscheduled bracket, the view toggle — so the rail is a shortcut into the queue, not a fourth filter vocabulary, and clicking one lights up its twin below. The other three cells are readouts and stay inert
  - **The queue lens is one segmented control in the panel head — All · Initial ·
    Resurveys** (`wipView` / `WIP_VIEWS`, third state added 2026-08-25). Doug
    could see resurvey WIP on its own but not the initial surveys, which is the
    larger half and different work. Things not to undo:
    - **Initial is `!isOpenResurvey`, not `survey_type`.** The question is "is
      this a first visit or something that came back", which is a queue state.
      `survey_type` is still unused everywhere
    - **It is not a seventh rail cell.** That was built first and reverted: at
      1280px seven cells leave 112px of label width, and *every* filter label —
      "Over 15 days", "Unscheduled", "Open resurveys" — wraps, the last to three
      lines when its bold active state kicks in. Six is what the rail fits
    - **It is still one control.** Putting it in the panel head restores the
      pattern the other two filter cells follow (rail cell = shortcut into a
      control that exists below it); the rail's Open resurveys cell now lights
      up its twin the way Over-15 and Unscheduled do. The 2026-08-17 removal of
      the All / Open resurveys pair stands — what was wrong there was *two*
      controls, and there is still exactly one
    - **`setWipView(v)` assigns, it does not toggle.** A segmented control must
      no-op when you click the segment you are already in. The rail cell wants
      click-active-to-clear, like its neighbours, so it passes `'all'` itself
    - **The lens badge is gone** — an active segment already names the view, and
      the badge named it a second time nine pixels away. The panel subtitle says
      what the lens means instead, and in the All view prints the split
      (`58 initial, 21 resurveys`) so the answer is readable without switching
    - Both counts come off `allWip`, not `wipScoped()`, so they add to Open now
      exactly rather than nearly
  - "Over 15 days" is **project age ≥15**, not >15, so it agrees with the 15–30d band directly beneath it. The threshold is read off `PA_MINS[WIP_OVER_BANDS[0]]` rather than written twice, so the number the cell shows and the bands its click selects are the same rows **by construction**. Moving it means moving `WIP_OVER_BANDS` to another band boundary — a cell reading "over 20 days" would have no band to select and would filter to something other than what it counted
  - The Unscheduled cell tests and selects only the unscheduled statuses that **have rows**, the same list the bracket uses and the list `wipQsSel` gets pruned to. Testing all of `QS_UNSCHED` meant the cell could never light up, because Likely cancel is empty most days
  - **Two filter rows, never three.** Schedule and Status are one hierarchy, not two dimensions: `wipQueueStatus()` reads the same `wipSchedDate` field `schedStatus()` does, returns Scheduled and Past due for the same two cases, then subdivides the third. Live data: Scheduled 55 / Past due 1 / Unscheduled 57 against chips of 37+2+7+5+6 = 57 — exact by construction. ANDing a Schedule row against a Status row returns zero rows for most pairs. The status bar carries the whole vocabulary in schedule order instead
  - **Queue status aims at an empty catch-all.** Six rows were falling through to a bare "Unscheduled" on 2026-08-17. Two were Radicl handoffs written as prose under uninformative subjects ("submitted their information to radicl" under CUSTOMER CALL), two were rep chases written as "FOLLOW UP WITH REP 8/17", and two were genuinely a different state — a job parked against a date while waiting on something outside SS (a reroof finishing 8/19; a date owed by the director). That last pair got a new status, **Follow-up set**; mis-filing them under Awaiting rep would have been a lie. The catch-all stays in the vocabulary, renamed **Unclassified**, and reads 0: empty statuses render no chip, so it costs nothing, and a non-empty one is the prompt to add a rule. Test order matters — the rep-specific follow-up must be tested before the generic one
  - **Copy sits at the bottom-right of the table it copies**, as a `.copy-btn`, on every table in the app. It was an underlined link on WIP and a header button elsewhere — three shapes for one action. Every copy path ends in `.catch(_copyFail)`: a rejected clipboard write used to look exactly like a successful one
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
- **Quality page** (rebuilt 2026-08-06, restructured twice on 2026-08-17). Three panels, in this order: **yield hero + chart · Resurveys by <group> · why they come back | resurveys requested**. The second restructure removed *Who is at fault*, *By resource*, *By sales rep* and *The open queue*, then merged the ranked rate bars into the detail table. Six surfaces became three. Things not to undo:
  - One population — `isResurveyDefect` for yield everywhere on the page. It used to run a second local definition alongside it, so "Total Resurveys" read 385 while FPY counted 434 on the same screen
  - It has **no time control of its own**. A `Date Range / Currently Open` toggle used to blank every FPY figure and delete the By Sales Rep section with nothing explaining why. The filter bar owns time
  - The yield chart marks weeks under `RS_MATURE_DAYS` (21) as provisional. Defects keep arriving for weeks — only 57% within 7 days, p90 41 — so recent weeks read high. A single trend arrow was tried and removed: it reported "down 7.7 pts" during the clearest improvement in the data
  - **"Why they come back" reads `rsCategories()`, not `resurvey_reason`** (2026-08-18).
    The picklist is too coarse to act on — "Survey Incomplete" is 76% of every
    recorded reason and the other eight values sit at 0–1% each, so the panel
    spent its whole height saying "something was missing". `rsCategories()` in
    `lib/metrics.cjs` reads the ~8 real categories out of the `resurvey_details`
    free text instead (95% coverage). Things not to undo:
    - **Multi-label.** A request asks for 2.18 categories on average ("a site map
      showing the utility meter, plus the pitch of the rear faces"), so one
      category per row would silently delete the second ask. Shares sum past
      100%, and the note under the bars says so
    - **Strip the request template first.** `INTERIOR ACCESS REQUIRED: No` is on
      57% of requests and asks for nothing; left in, its words classify every row
    - **No catch-all bucket.** The 20 unreadable rows (18 with an empty details
      field, 2 one-offs) are counted in the note, not bucketed — a bucket named
      "Other" at 5% would look like a category
    - **Patterns must not carry `/g`** — `test()` is stateful with a global flag
      and would drop rows at random. The unit test asserts this
    - It is a **derived reading of free text**, so the raw picklist and the
      original sentence stay beside it in the drill drawer. If SF ever ships a
      real sub-reason picklist, that replaces this outright
    - Guarded by a **frozen corpus in `test/metrics.test.js`**, not the snapshot:
      `build-fixture.cjs` redacts `resurvey_details` because it is customer
      prose. Widen a pattern, add the phrasing to the corpus in the same edit.
      That test caught the pattern matching `breaker` but not `breakers`
    - Panel + meter + sub-panels touch ~70% of resurveys between them. The
      spread is genuinely uneven and that is the finding: the coaching story is
      "photograph the panel completely". Don't flatten it by construction
  - **One grouping, four cuts, one table**: sales office (default) · region · resource · sales rep. Adding a cut means adding a key to `GRP`, not another panel. The toggle renders twice from one string (`grpTgls`) against one state, so the copies cannot drift
  - **The ranked bars and the detail table are one object.** They were separate until 2026-08-17 and printed the same fact twice: rate and FPY are exact complements, so each group showed its own number in two vocabularies, ranked two different ways (rate desc vs volume desc), under two different floors (10+ completions vs none). The bar now lives in the table's **Came back** cell with the 5% ceiling drawn in its track, and the ranking survives as the default sort
  - **One number per row, and it is the rate.** The bar length matches it, and small numbers band more legibly than the 85-to-100 range FPY lives in. The hero and the chart still speak FPY; the key line under the table states the relationship once. Do not add an FPY column back beside it
  - **Sortable, blanks sinking in both directions**, same `sarr` vocabulary as the Performance, WIP and drawer tables. Text columns open A to Z and numeric ones worst-first: a first click that sorts names Z to A reads as a broken control. Sort resets to rate when the cut changes, so a column that is not rendered can never be the active sort
  - **One floor: `RS_MIN_CELL` (10 completions), applied to the whole table.** A row that cannot show a rate was doing no work in a table whose point is comparing rates. Per-resource cells keep the sample-count treatment, since a group above the floor can still be thin for one resource
  - The **All \<plural\>** footer row is the population baseline, neutral so it never ranks against the rest. It reconciles by construction: the Resource cut's three rows are exactly the Sales office footer's three resource cells
  - **One rate definition — `defects ÷ completions` — for all four cuts.** The rep cut used to run an own-fault variant excluding Customer/Design; merged 2026-08-17 because attribution is 90% Surveyor and the split moved only 21 of 303 rep defects
  - **The rep cut counts self-surveyed rows only** (`resource === 'Sales Rep'`). Its denominator is smaller than the other three on purpose — grouping every completion by `sales_rep` charges a rep for a Radicl surveyor's defect. The footnote says so and gives both counts
  - **Rep idle days are a label, never a filter.** `idle Nd` from 30 days, measured to the **end of the viewed range** rather than the export: an export anchor hid 3 of the 7 qualifying reps on a Q1 range because they left later that year. No activity cutoff exists, and one should not be added — sales activity is a proxy for employment and no threshold makes it a good one (30/45/60/90 were all measured; the only real difference was whether the worst-rate rep on the board appeared). Show the number, let the reader draw the line
  - **Per-resource FPY columns only under office/region.** Grouped by resource they are the diagonal of their own table; grouped by rep every row is a Sales Rep row. The rep cut gets the rep's main region in that slot instead
  - **No live counts on this page.** The detail table carried an "Open" column reading `isOpenResurvey` — a live figure inside a date-filtered table, the same defect that got "Open now" removed. Dropped with the open queue
  - **The intake inbox lives here now** (`renderRsReq()`, added 2026-08-07 on Current, moved 2026-08-17 into the slot *Who is at fault* vacated). Expandable per day to the reason + `resurvey_details`. Two things about its window: it anchors on `resurvey_requested`, which nothing else on the page does, and it holds a **fixed two weeks — Monday of last week → the export date** rather than the filter's range. That is 8 rows on a Monday to 14 on a Sunday, and the oldest seven fall off each Monday. Over the default all-time range the filter's window would be 60-odd day rows in a panel built for seven; an inbox is read forward from the last time you looked, not scrubbed. **Region, office and resource still apply** — a panel ignoring an active region filter is the stale-scrubber bug the Map page had. It keeps Unnecessary Request rows, greyed, because it is an inbox rather than a yield measure
  - Per-survey resource still only covers the initial survey — future SF survey objects will fix that (see memory "Come back to" list)
  - **Yield hero** (300px) replaced the four-KPI strip: FPY at 52px, the sentence, a progress track with the 95% target marked *on* it, then three figures that **add up**, each with its median beneath: Cost of a resurvey (+20.7d) / Time to flag (16.2d) / Resurvey cycle (6.0d) ≈ 3.2 + 16.2 + 6.0 against 4.0d clean. Cost was `avg(ct_full) − avg(clean ct_total)` until 2026-08-17 and read +5.3d: `ct_full` is `ct_total + ct_resurvey`, so it skipped the wait before anyone flags the survey — most of the calendar cost — and that omission also made it a near-duplicate of the Resurvey cycle line directly beneath it. Doug could not defend the pair; they are three defensible facts now. **Time to flag is the largest of the three and is not this team's clock** — it is a Design/review number, worth owning the measurement of
  - **No `n=` anywhere.** Cells under `RS_MIN_CELL` show their completion count in the grey non-pill `.pna-n` treatment, which is what says "not a percentage"; the `q-rate-n` column dropped its `::before{content:'n='}` at the same time
  - **The yield chart ships in both forms** behind a Bars/Trend toggle (`rsChartMode`). Built two ways 2026-08-17 so the shape could be judged on real data; **Doug chose 2026-08-24 to keep both and keep the toggle** — this is settled, not a pending decision, and neither form is to be deleted. They share one target rule and one immature-week convention. The tradeoff each answers: bars must sit on a zero baseline, so 0–100% flattens a series living between 80 and 95, while the line auto-scales and shows the variation — which is the argument the 4-week rolling average was added to win

  - Rate bands are the **mirror of the old `fpyPill`**: under 5% green, 5 to 15 amber, 15 and over red, ceiling line at 5% because the target is 95%. At a 15.6% national rate most groups read red. That is the honest reading against a 95% target, not a scale fault
  - **No "worst office per region" column**, though the handoff specifies one: only 2 of 28 regions contain an office clearing the 10-completion floor, so it would be blank on most rows, and filling it from a sample of 3 would name a real org unit off noise. The column carries the sample size instead, so no rate is read without it
  - **Attribution has no panel.** *Who is at fault* was removed 2026-08-17: with the backfill done it reads Surveyor 329 · Design 29 · Customer 5 · unattributed 2, so it said "it's us, 90% of the time" on every load. `resurvey_attributed` survives in the drill drawer's column and per-day in the inbox; nothing on this page computes with it. It never fed `isResurveyDefect`
  - **Reasons sit left.** The reason list says what to fix and is the actionable half; it pairs with the inbox, whose height varies, so the variable panel sits last on the page
  - **Status is not in this page's filter bar** — every row here is already complete
  - **The open queue is not on this page.** Removed 2026-08-17 — it lives on the WIP rail as Open resurveys, whose cell filters the WIP queue to exactly those rows. Before removing it, `resurvey_reason` + `resurvey_details` were added to the **WIP expanded row** (`.wip-rs-why`): 41 of the 42 open resurveys carry a reason, and this page's queue table was the only place it could be read. What did not survive the move is the weekly grouping with its oldest-age and `rsStaleDays()` marker — WIP has no staleness cue specific to resurveys
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
- **A resurvey staleness cue on WIP.** Removing the Quality open queue took the
  `rsStaleDays()` marker (p90 of resolved resurvey cycles, ~15d) with it. The
  WIP queue bands on `ssDaysOpen` and project age, neither of which knows a
  resurvey has been open past the point 90% of them had resolved
- ~~Pick a yield-chart form on Quality~~ — decided 2026-08-24: **both stay, and
  so does the toggle.** See the Quality section; don't re-open it
- The 5% resurvey-rate ceiling paints nearly every sales office red at the
  current 15.6% rate. Correct against a 95% target, but worth a look before it
  is treated as settled
- ~~Doug is tagging ~19 accounts in SF as "Unnecessary Request"~~ — all but one
  done (58 rows now carry the reason; FPY 83.3% → 84.2%). The survivor is
  7502HARM, which is not a resurvey at all: `reopened_by_design` is ticked with
  no reason, no attribution, no dates, no details, and a review note reading
  SITE SURVEY COMPLETE. Confirmed against the raw export — Salesforce ships the
  tick, it is not a parse artefact. **The import sanity report now finds these**
  (2026-08-25): parse-sf.js warns on any row counted as a resurvey on the flag
  alone and prints its SF link, so the row is fixed at the source instead of
  being excluded in code. That rule has been proposed twice and rejected twice —
  see `isResurveyDefect` — because it has the dashboard inferring "not really a
  resurvey" from an absence. 470 of 471 flagged rows corroborate; zero rows
  carry resurvey evidence without the flag, so the flag itself is sound
- ~~Doug is backfilling the ~74 resurveys with no `resurvey_attributed`~~ — done,
  2 rows remain. The result (90% Surveyor) is what retired the attribution panel
- Not built, raised and parked: `survey_type` is unused everywhere and Battery
  Only surveys yield 75.8% against 84.1% for the rest (n=33, thin); the
  several dismissed requests were Design asking for utility bills or
  ownership docs, which is a Design-process conversation rather than a survey
  failure — worth quantifying once the tagging is done

### Left open by the 2026-08-14 full audit
Carried here 2026-08-24 when `docs/AUDIT.md` was deleted — the audit's findings
were applied across four batches, but these six were deliberately not, because
each is a judgement call rather than cleanup. The measurements behind them are
in that file's history (`git log --diff-filter=D -- docs/AUDIT.md`).
- **A1 — `/api/send-teams` and `/api/team-opener` have no auth.** Anyone who can
  POST can push a card into the team channel. An in-code secret is public
  because compose is a static file, so the real options are Vercel Deployment
  Protection or building the Adaptive Card server-side instead of accepting an
  arbitrary `card` from the client
- ~~Q1/A3 — `/queues` is a live, undocumented surface~~ — **retired 2026-08-24,
  Doug's call.** `queues/index.html`, `api/upload-data.js`, both `vercel.json`
  rewrites and the `@supabase/supabase-js` dependency are gone. That removed the
  repo's third copy of the field registry and an unauthenticated upload endpoint.
  **The Supabase project itself still exists** — the code held a hardcoded URL
  and publishable key (`hoczpteqfpjkldcptwxo`), and retiring the code does not
  delete the rows it wrote. Deleting that project is Doug's to do in the Supabase
  console. Recover the page with `git log --diff-filter=D -- queues/index.html`
- ~~W3 — the `>7d` queue-age band is written inline in four places~~ — **done
  2026-08-24, as `queueAgeBand(d, targetAvg)` in `lib/metrics.cjs`.** The audit's
  count was wrong: it was two genuine sites, not four, and the other three
  lookalikes are different rules that must stay separate (`pillBand` bands a
  finished cycle at `targetMedian`/`targetAvg+2`; the drawer's `rsOpen` column
  bands resurvey staleness against `stale`; the WIP-vs-done pill at line ~2088
  uses `targetMedian`/`targetAvg+1`). **Don't merge those into it.** The two real
  sites had already drifted: the WIP Open-in-SS pill hardcoded amber as `d<=7`
  while Current's still-open buckets derived `targetAvg+3` — identical at 4, and
  8 live rows would have split the moment the target moved. Verified as a pure
  refactor: 0 band changes across all 2,522 rows at `targetAvg` 4
- **G8 — the default range starts before `DATA_CUTOFF`** because 3 re-signed
  accounts carry completions months before their starts. Clamping was tried and
  reverted: it drops those rows from every date-filtered population (Performance
  2335→2332) and flips the default preset from All to Custom
- ~~X5 — compose's password gate runs after the data loads~~ — **accepted as an
  internal-tool tradeoff, Doug's call 2026-08-24.** The `prompt()` still runs
  against a plaintext constant *after* all 2,538 customer rows (names, phones,
  emails) are in the page and the network log, so the gate is a speed bump, not
  access control. Do not re-raise it as a bug. It stops being acceptable the day
  the URL is shared outside the team — that is the trigger to revisit, and the
  fix then is Vercel Deployment Protection rather than anything in page code
- **P4 — `pillV` and `pctTgt` band inline on purpose.** Documented in the
  register. **Deliberately left inline 2026-08-24** when W3 was consolidated:
  `pillBand` bands at `targetMedian`/`targetAvg+2` and `pctTgt` is a percentage
  rather than a band, so folding either into `bandFor` would change displayed
  colours rather than just move code. Promote only if you want uniformity badly
  enough to accept that
- ~~Quality's group table has no keyboard path~~ — fixed 2026-08-24. It rendered
  a bare `onclick` with no `role`/`tabindex`/`onkeydown`; it now goes through
  `drillAttrs()` like every other `.drill-tgt`. **Every drill target in the app
  routes through `drillAttrs()` — a bare `onclick` on one is the bug, twice now**
