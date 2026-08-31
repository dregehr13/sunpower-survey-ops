# Survey Ops — Claude Code Context

## What this is
Internal ops dashboard + email generator for SunPower's Site Survey department.
Built by Doug Regehr (Site Survey Manager) to replace manual reporting done by David Richards (previous manager).

## Live URL
https://sunpower-survey-ops.vercel.app
Email generator: https://sunpower-survey-ops.vercel.app/compose

## Pages
Current · WIP · Performance · Trends · Quality · Map · Resource · Billing. WIP sits second
because it is the page the manager sits in; the order changed 2026-08-17.
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
- **Three shared libraries, not one.** `lib/metrics.cjs` answers "how is the
  survey work going". `lib/coverage.cjs` answers "who should be doing it and
  can they reach it" — distance, market clustering, surveyor capacity.
  `lib/billing.cjs` answers "what did we pay for it" — vendor specs, invoice
  reconciliation. They never share a definition, so keeping them apart costs
  nothing. All three load into index.html the same UMD way and all three are
  named in the boot guard
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
- **Hover means "this opens something"** (added 2026-08-17). Lift and shadow are reserved for it — `.drill-tgt` cards and the `.wip-expand` caret. Panels (`.sec`) and plain KPI cards have no hover state at all; `.pill` does not scale (most pills are status readouts in table cells, not controls); filter chips darken their border one step with no transform. Row hover is one value, `var(--bg)`, not the three off-whites it was — the one
  exception is a **two-level** table, where the group band already rests at
  `--bg`: on the Resource market table `.res-grp` hovers one step to
  `--border-lt` and the white `.res-kid` rows take `--bg`. Both levels are
  expanders and **neither responded to hover at all until 2026-08-27**, because
  `.res-grp>td` / `.res-kid>td` are declared after the global `tr:hover td` at
  equal specificity and won
- **A note says what a number IS, not why it was built that way** (added
  2026-08-26, Doug's call: "too much overexplaining"). The `.note` under a table
  carries definitions the reader needs — what *cleanup* counts, where the 8-week
  window starts, what a floor leaves out — and nothing else. Design history, the
  argument for a threshold, the reason two columns are different populations and
  any instruction to whoever edits the code next belong in a source comment.
  **Doug is the only reader of this app**; he does not need the case re-made
  every time he opens a page, and a paragraph of justification under a table is
  how a note stops being read at all. Applied to Billing's exception blurbs and
  every Resource note (~35% shorter); the reasoning it displaced is in
  `lib/billing.cjs` and `lib/coverage.cjs` where it was already written
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
  - **Queue status aims at an empty catch-all.** Six rows were falling through to a bare "Unscheduled" on 2026-08-17. Two were Radicl handoffs written as prose under uninformative subjects ("submitted their information to radicl" under CUSTOMER CALL), two were rep chases written as "FOLLOW UP WITH REP 8/17", and two were genuinely a different state — a job parked against a date while waiting on something outside SS (a reroof finishing 8/19; a date owed by the director). That last pair got a new status, **Follow-up set**; mis-filing them under Awaiting rep would have been a lie. The catch-all stays in the vocabulary, renamed **Unclassified**: empty statuses render no chip, so it costs nothing, and a non-empty one is the prompt to add a rule
  - **Follow-up set became Pending photo upload** (2026-08-31). The generic
    `FOLLOW UP` / `FUP` rule was a diary entry, not a waiting state, and by
    2026-08-31 it held 12 rows of which **zero** were the parked-against-a-date
    case it was built for (both of those had closed). Ten were one note —
    *"the rep completed the survey but the automation failed to add the photos
    to salesforce … Sam can upload them"* — one was a rep cancelling a booked
    visit, one an open resurvey waiting on Design. Things not to undo:
    - **Pending photo upload is tested BEFORE the schedule date.** 14 open rows
      carry the note and 4 of them still hold the booking for the visit that
      already happened, so they read Past due beside ten identical twins. The
      survey was performed; the date is history. Past due 9 → 5
    - **It sits ABOVE `QS_UNSCHED`**, which is why that list is now anchored on
      `QS_ORDER.indexOf('radicl')` rather than a slice count. These rows need a
      file uploaded, not a booking, and counting them as unscheduled put 14 rows
      into the rail cell and the bracket that nobody needs to schedule.
      Bracket 59 → 49
    - **Distinct from Awaiting rep's `NO PHOTOS` / `MISSING PHOTOS`**, which is
      the rep not having taken any. All 14 also carry `holding_reason` *All
      Photos Missing*, which is exactly the false signal that field was rejected
      for: the photos exist
    - It usually clears in ~2 days (35 of the 49 rows that ever carried the note
      have completed, median cycle 2d), so the state's value is the outlier —
      one row has been open **68 days**, invisible before under a bucket named
      after a date
    - **`RESCHEDULE NEEDED` goes to Awaiting rep**, tested after Radicl so
      `RESCHEDULE NEEDED - RADICL SCHEDULING WITH CUSTOMER` stays with Radicl
    - **A `COMPLETE` subject on a row that is not complete is dropped, and the
      row reads New.** Eight rows sat in Unclassified on "COMPLETE / I uploaded
      the radicl pdf"; six are open resurveys requested 8/26 whose last note
      describes the *initial* survey, so reading it classified the wrong event.
      The other two are the bare `reopened_by_design` shape (a complete date, no
      request, no reason) that parse-sf.js already warns on — **fixed at the
      source, never inferred here**
    - Unclassified reads **1**, the Design row. One row is a prompt to watch,
      not a licence to add a status for it
  - **Copy sits at the bottom-right of the table it copies**, as a `.copy-btn`, on every table in the app. It was an underlined link on WIP and a header button elsewhere — three shapes for one action. Every copy path ends in `.catch(_copyFail)`: a rejected clipboard write used to look exactly like a successful one
  - **"Everything unscheduled" is a bracket under the bar**, not a legend group. A container around five of eight legend chips makes one wrapped line read as a different kind of object. The bracket also shows how much of the queue is unscheduled, which a legend box cannot. It aligns by `calc()` — the bar mixes fixed 2px gaps with proportional segments, so a mirrored flex row drifts
  - Age bands and status chips **cross-narrow**: each row counts within the other's selection, so no combination is ever offered that filters to nothing
  - Table is 8 columns; Reviewed By folds into Last reviewed as `Aug 14 · S. Mertz`. **`last_reviewed_date` is a timestamp, not an ISO date** — `fmtDateShort()` splits on `-` and prints "undefined NaN". Use `fmtReviewDay()`
  - Whole-row red/amber tinting is gone: the Open in SS figure and the status badge already carried it twice
  - The **"Rep day" pill stays.** The handoff has no slot for it, but printing `0d` would misreport whose clock is running
  - Under 640px rows stack two-line rather than scrolling sideways
- **The nav badge beside WIP is the open count**, neutral grey. It was the "needs attention" count until 2026-08-17, when that whole concept came out: `attnItems()`, `attnKey()`, `dismissAttn()`, the per-row "Reviewed ✓" buttons and the `ops_dismissed` localStorage store are gone. It was a saved filter dressed as a view — every row it held is reachable from Past due plus the age bands — and the dismissals made the badge disagree with Salesforce for anyone who had clicked one. Its toggle slot went to **Open resurveys**, a population with no live home before then. Grey, not red: an open queue is the normal state, and a red badge on every page load teaches you to ignore red
- Main cycle metric: **anchor → Site Survey Complete** (`ct_total`). Other intermediate dates (requested, scheduled) exist in the data but are unreliable — don't feature them in UI
- **The cycle-time anchor is one variable, and it is `r.start`** (added 2026-08-25).
  Settings → Data → *Cycle time anchor* switches every cycle time and every
  queue age between Project Start Date (Spec 12744) and `opened`, the TaskRay
  task's own creation date. **Default is `opened`** — nobody on the team can
  touch a survey before the task exists, so that is when this team's clock
  actually starts. Things not to undo:
  - **It works by rewriting `r.start` itself**, once, in `applyAnchor()` inside
    `loadAll()`. There are ~50 readers of `r.start` across index.html and
    lib/metrics.cjs; teaching each of them about a second date is exactly how
    the three SS ratios came to disagree by 34%. One assignment, and every
    reader is correct by construction. `test/surfaces.test.js` asserts there is
    **exactly one** `r.start =` per surface
  - **`lib/metrics.cjs` is anchor-blind and must stay that way.** Rows arrive
    already anchored. That is why the toggle needed no changes there and why
    the golden snapshot did not move. A test asserts metrics.cjs never mentions
    `r.opened` or `ct_open`
  - **`RAW` is never mutated.** Every `loadAll()` call site passes
    `JSON.parse(JSON.stringify(RAW))` or a fresh upload, so flipping back is a
    reload, not an undo. Toggling out and back returns byte-identical figures
  - **Both cycles are baked at parse time** (`ct_total` from start, `ct_open`
    from opened) so the toggle is a swap, not a recomputation — no surface ever
    computes a cycle time itself. `ct_open` deliberately has no
    `field_survey_complete` fallback twin: that branch reconstructs a *missing
    completion*, which is orthogonal to the anchor
  - **compose reads the same `ops_settings.anchor`** (same origin). It keeps its
    own copy of the data and its own `ct_total` reads, so leaving it out would
    have the Monday recap quoting a different cycle time than the page it was
    written from — the 2026-08-14 defect again
  - **`opened` is `filterable:false`.** A date filter on it would let you filter
    by one anchor while measuring by the other
  - **`Open date` is a datetime** (`8/24/2026, 8:31 PM`). Typed `date` in the
    FIELDS registry so `cleanDate()` takes the date part — that is what keeps it
    off the `fmtReviewDay()` rake `last_reviewed_date` (typed `text`) needs
  - Measured impact, unfiltered: mean 4.02 → 3.84, **median 2.00 unchanged**,
    p90 10 → 9, ≤3d 65.2% → 66.4%, negative cycles **40 → 3**. In-scope
    population identical (2,444 rows, none gained or lost). 79.9% of rows are
    unchanged; the mean moves mostly on ~36 rows whose task was created 5–70
    days after project start. Per resource the delta runs −0.37 to +0.16
  - **The import sanity report watches immutability.** The whole case for this
    anchor is that Open date never moves; `parse-sf.js` diffs every row's
    `opened` against the current data.json by `task_id` and warns if any
    changed. Evidence it holds: 449 of 469 resurveys carry an Open date at
    project start rather than at the resurvey request, so it survives a reopen
  - To revert the feature entirely, set `anchor` back to `'start'` in
    `SETTING_DEFAULTS` — every other part of it is inert while the anchor is
    `'start'`
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
  - **Yield hero** (300px) replaced the four-KPI strip: FPY at 52px, the sentence, a progress track with the 95% target marked *on* it, then a total and its two parts, each with its median beneath: Cost of a resurvey (+22.4d) = Time to flag (16.6d) + Resurvey cycle (5.8d). **They reconcile exactly, on every filter, by construction** — `rsLegs` builds all three off one array of rows rather than filtering each figure separately (see `docs/METRICS.md` → *Hero row set*). Two superseded cost definitions, neither to be revived:
    - `avg(ct_full) − avg(clean ct_total)` (→2026-08-17, read +5.3d). `ct_full` is `ct_total + ct_resurvey`, so it skipped the wait before anyone flags the survey — most of the calendar cost — and that omission also made it a near-duplicate of the Resurvey cycle line directly beneath it
    - `avg(start → resurvey_complete) − avg(clean ct_total)` (2026-08-17→2026-08-25, read +21.7d). Right magnitude, wrong shape: a difference of means over two **disjoint** populations, so it moved with the composition of the *clean* rows rather than the resurveys. The subtrahend ranges 1.1–7.8d by region, 1.4–7.1d by office, 2.8–8.5d by resource — Radicl's clean jobs average 8.5d against a rep's 2.8d, so Radicl's resurveys read 5.7d cheaper than a rep's when the true gap is 3.4d. It was incomparable across the exact cuts the filter bar exists to apply, which is how Doug uses this page. Unfiltered the change is only +0.6d; the case for it was entirely the filtered reads
    - **Anchor on `effectiveComplete`, never raw `complete`.** On a re-signed account the original survey predates the restart — 920HHEND's closed Aug 2025 against an Apr 2026 start — and raw `complete` scores that resurvey at 330d instead of 99d, worth ~0.6d of the national average on one row. This is the same rule `ct_total` already follows
    - **Time to flag is the larger leg and is not this team's clock** — a Design/review number, worth owning the measurement of. p90 47d, p99 140d, so the average sits well above the median of 6
  - **No `n=` anywhere.** Cells under `RS_MIN_CELL` show their completion count in the grey non-pill `.pna-n` treatment, which is what says "not a percentage"; the `q-rate-n` column dropped its `::before{content:'n='}` at the same time
  - **The yield chart ships in both forms** behind a Bars/Trend toggle (`rsChartMode`). Built two ways 2026-08-17 so the shape could be judged on real data; **Doug chose 2026-08-24 to keep both and keep the toggle** — this is settled, not a pending decision, and neither form is to be deleted. They share one target rule and one immature-week convention. The tradeoff each answers: bars must sit on a zero baseline, so 0–100% flattens a series living between 80 and 95, while the line auto-scales and shows the variation — which is the argument the 4-week rolling average was added to win

  - Rate bands are the **mirror of the old `fpyPill`**: under 5% green, 5 to 15 amber, 15 and over red, ceiling line at 5% because the target is 95%. At a 15.6% national rate most groups read red. That is the honest reading against a 95% target, not a scale fault
  - **No "worst office per region" column**, though the handoff specifies one: only 2 of 28 regions contain an office clearing the 10-completion floor, so it would be blank on most rows, and filling it from a sample of 3 would name a real org unit off noise. The column carries the sample size instead, so no rate is read without it
  - **Attribution has no panel.** *Who is at fault* was removed 2026-08-17: with the backfill done it reads Surveyor 329 · Design 29 · Customer 5 · unattributed 2, so it said "it's us, 90% of the time" on every load. `resurvey_attributed` survives in the drill drawer's column and per-day in the inbox; nothing on this page computes with it. It never fed `isResurveyDefect`
  - **Reasons sit left.** The reason list says what to fix and is the actionable half; it pairs with the inbox, whose height varies, so the variable panel sits last on the page
  - **Status is not in this page's filter bar** — every row here is already complete
  - **The open queue is not on this page.** Removed 2026-08-17 — it lives on the WIP rail as Open resurveys, whose cell filters the WIP queue to exactly those rows. Before removing it, `resurvey_reason` + `resurvey_details` were added to the **WIP expanded row** (`.wip-rs-why`): 41 of the 42 open resurveys carry a reason, and this page's queue table was the only place it could be read. What did not survive the move is the weekly grouping with its oldest-age and `rsStaleDays()` marker — WIP has no staleness cue specific to resurveys
- **Map page** (added 2026-08-06). All markets by town, six modes (Volume / Open WIP / Cycle / Resurvey / Coverage / Plan), click a state nationally to open that market:
  - Location comes from the **ZIP in `address`, never `region`** — region is a sales territory, not a place, and reading the address also places the ~71 rows whose region is blank
  - Grouped by **town**, not ZIP: a ZIP is a postal artefact that split Glen Allen into two dots and buried Richmond's eight ZIPs entirely
  - It has **no time control of its own** either — same rule as Resurveys, and for the same reason (a stale scrubber once showed 167 jobs against a filter selecting 2458)
  - Geography lives in `geo/` (ZIP centroids, CONUS state outlines, top-1k cities, per-state counties), generated by `scripts/build-geo.cjs` and committed. Fetched on demand, never baked into the HTML — the page derives from data.js, which push.sh rewrites daily. Sources cache in `geo/.src` (gitignored). Rerun the script when a market opens in a state with no counties file
  - The old standalone `/va-map` is retired and redirects to `/#map`

### Resource coverage on the Map (added 2026-08-26)
Doug's ask: plot resource coverage as a toggle. It came out as three things, and
the split between them is the design — a layer, two modes, and a tool. Things
not to undo:
- **Team reach is a LAYER, not a seventh mode.** It draws every surveyor's base
  and the ground they can work as a day trip, over *whatever* mode is selected,
  because that is where it says the most: resurveys clustered outside anyone's
  reach, a WIP pile twelve miles from Sam. As a mode it could only ever be seen
  alone. It ANDs against nothing and can never empty the map, so it is not the
  "two filter rows, never three" problem the WIP page has
  - **The rings are filled as ONE non-zero-wound path.** Harry and Sam are eight
    miles apart in Portland and their rings overlap almost entirely; stacked
    translucent fills paint that overlap darker, which reads as *more covered*
    when it is the same ground twice. `moveTo` before each arc or Path2D joins
    the circles with a chord and fills the empty ground between Portland and
    Detroit
  - **Miles→pixels is measured off the projection** (`_mapMiPx`), not derived.
    Albers is equal-area, not conformal, so a day-trip circle is very slightly
    an ellipse — under a pixel at 60mi, and a measured scale holds at both zooms
  - The radius is `maxOneWayMi` read from the **live** model, so Settings →
    Resource model moves the ring and the legend text together
- **Coverage and Plan read `resMarketFacts()`, the Resource page's own
  definition.** It was extracted out of `resMarkets()` in the same pass so both
  pages compute one set of facts from one function; nothing on the Map
  recomputes a rate, a reach class or a recommendation. Identity (key, name,
  towns) is deliberately *not* in it — the map takes a market's majority state
  so a cross-border market like Portland reads right at a state zoom, the
  Resource page takes the seed's. What must not differ is the arithmetic
- **Both coverage modes read the live book and IGNORE THE DATE RANGE**, and that
  is correctness, not taste: `marketAdvice()` measures its per-week rates over
  the trailing `RECENT_WEEKS` anchored on the export date, so under a Q1 filter
  the recent window holds zero rows and **every market in the country reads
  "Gone quiet"**. Same carve-out Open WIP already makes, for the same reason
- **They also drop the Resource filter**, through `gfDim(r,{resource:true})` —
  one clause skipped rather than a second dimension test written. Filtering to
  Radicl and then asking "who is doing the work here" can only answer "Radicl",
  and the recommendation would be computed from a book with two of its three
  resources deleted. Region, office and status still bite, because those are
  visible controls on this page and a panel quietly ignoring an active region
  filter is the stale-scrubber bug. Note this is what makes the map's market
  count differ from the Resource page's — that page has no filter bar and
  scopes on `DEFAULT_STATUSES` instead. **Both exclusions are named on the page** when the
  control is actually set, and in the drill drawer's scope note — a visible
  control that silently does nothing is the same defect as an invisible one
  that silently does something
- **The coverage modes cluster NATIONALLY and then narrow to the state**, and
  measure office mobility over the national book. The other four still cluster
  what is in view, because they answer "what did we sell here" and the state is
  the question. Two ways the viewport was silently changing a recommendation,
  both found and fixed on the day:
  - Mobility measured over one state's half of an office that moved from
    Pennsylvania to Virginia shows overlapping early and late footprints and
    reads as *settled* — it flipped Glen Allen from *Deploy 1–2 weeks*
    nationally to *Leave with vendor* zoomed into Virginia
  - Clustering a state's rows on their own moves the cluster boundaries: near
    the Maryland line the greedy seed claims a different neighbourhood once the
    out-of-state points are gone, which did the same to Fredericksburg
  - Markets are kept by their **majority state**, so a cross-border market keeps
    its out-of-state members. Portland's takes in Vancouver WA, which is the
    right population for a staffing question and the wrong one for a heat map
  - Verified: **214 markets on both pages, 214 of 214 recommendations identical,
    and zero drift across 11 state zooms.** That equality is the regression
    test — if the two pages ever disagree again, one of them has grown its own
    copy of something
- **The state counts follow the mode's own population.** The picker and the
  bold/faint state labels read the same rows the dots do, so a dropdown offering
  "Pennsylvania (739)" never sits above a map drawing 1,370
- **Coverage colours by the resource doing the most work, one colour per
  market.** A three-slice pie was considered and rejected: circles run 3.2–17px
  and at the small end a pie is three unreadable arcs claiming precision the
  mark cannot carry. The full split is in the tooltip and the list below, where
  there is room. Plan colours by `marketAdvice().k` on the `.res-rec-*` palette,
  except that **dormant draws hollow** — that palette gives *Leave with vendor*
  and *Gone quiet* the same grey, which is fine on a tag carrying its own label
  and unreadable as two marks on a map
- **The list below the map ranks by the decision in these modes**, not by
  volume: a list of the twelve biggest markets is already what Volume mode says
- **Markets are rebuilt once per render and cached** (`_mapCov`, invalidated in
  `renderMap()`). The national set is 228 markets and 86ms to build against
  3.6ms for a cached redraw, and `mapDraw()` runs on every hover
- **Siting prices a location and never chooses one.** `siteCapture()` in
  `lib/coverage.cjs`; click anywhere and it reports what comes into day-trip
  range, how much of that is outsourced today, modelled capacity at the drive,
  and the break-even against the vendor's own per-survey price. Things not to
  undo:
  - **No optimiser.** Asked for the *best* location it would return a point in a
    field with no house and no reason for anyone to live there, dressed as a
    recommendation. The manager knows which towns are hireable; this prices the
    ones they name. Same rule the recommendations follow
  - **Gained is not the same as in range.** A market an existing base already
    reaches counts as in range but not as captured — otherwise a candidate that
    only re-covers Portland prices a hire for work the team already has
  - **The typical drive is weighted by recent volume.** A plain mean lets nine
    dormant villages at the edge of the radius outvote the one market carrying
    every job, and capacity is then quoted for a drive nobody makes
  - **The verdict is a prompt, never a decision** — the same wording rule every
    Billing exception and every market recommendation follows
  - While the tool is on, a click means "put a base here" and nothing else; the
    tooltip says so, and turning it on turns the layer on with it, because a
    candidate ring priced against invisible existing rings has nothing to be
    compared to
  - It needs the inverse projection, `mapAlbersInv()`, which nothing else uses
- **`resVendorCostByZip()` is memoised on the billing history's identity.**
  It runs `reconcile()` over every invoice line against every row, and the
  coverage modes rebuild markets on a radius change
- Six segments do not fit a phone, so at ≤860px the map's toggle groups
  **scroll rather than wrap** — a segmented control that wraps loses its end
  radii and reads as two controls — and the active segment is scrolled into
  view. That needed `min-width:0` on both the group and the control row: a flex
  item's default `min-width:auto` left the group at its content width and it
  pushed the card instead of scrolling inside it. It also fixed a pre-existing
  horizontal body overflow on the Map at 375px

### The map's controls (2026-08-31)
Doug's asks: the buttons move when you switch mode, why are the radius buttons
there, and — the general one — make the filter bar appear and disappear as it
becomes relevant instead of standing there inert. Things not to undo:
- **The subtitle is a full-width row UNDER the controls, never a flex child
  beside them.** As the middle child of a `space-between` head its length set
  the left column's width, and it changes with the mode — 40 characters in
  Volume against 110 in Coverage — so picking a mode squeezed `.map-ctl`, which
  wraps, and **every button jumped 132px**. Measured after: Volume at 555,194
  and the canvas top at 265, identical in all six modes
- **The market radius is a definition, not a view**, so it is a labelled select
  beside the market picker rather than a second segmented control beside the
  six mode buttons — as a twin toggle the row read as ten interchangeable
  buttons. It is load-bearing and must not be deleted: it changes the dots in
  **every** mode (360 markets at 15mi, 214 at 25, 151 at 35), sets the market
  count in the rail, and the Resource page's table reads the same number
- **Region is not on this page** (2026-08-31, Doug's call). The map places rows
  by the ZIP in the address, so it already cuts by place twice — the State
  picker and Office. Region is a sales territory, not a geography, and a third
  slice only confuses the two. It stays on every other page
- **The state picker says State, not Market.** It selects a state; "market" on
  this page means a radius cluster, and the two sat nine pixels apart reading
  the same word. `.map-pick` labels both scope pickers — STATE and MARKET
- **No divider inside the mode toggle.** One was tried and removed the same
  day: `.tgl-btn` drops its right border and leans on `:last-child` to restore
  it, so a non-button between two buttons leaves the one before it with no
  right edge and opens a gap. The contextual bar already shows the split
- **Tooltips are one sentence** (2026-08-31, Doug: too many, too long, and he
  is the primary reader). The map's ran 137–330 characters and several
  restated the visible text beside them; they are 74–117 now, and
  `mapLocation`, `mapCoverage` and `mapTimeline` were deleted outright because
  the panel title, the note and the disappearing controls already said it.
  Deleting the `kinfo` means deleting the `TIP` entry — `test/surfaces.test.js`
  fails on an entry no card references
- **`fbShow(page)` is the one table of which controls reach a view**, replacing
  three scattered conditionals. A control that changes nothing is **not
  rendered** — the view says what it obeys by showing only what it obeys,
  rather than showing everything and explaining the exceptions in prose:
  - WIP drops the date range (live queue), Quality drops Status (every row is
    complete), and **Coverage/Plan drop the date range AND Resource**, which
    they genuinely cannot read — they take `_mapLive`, collected before the
    date test, and pass `{resource:true}` to `gfDim`
  - **Hiding never clears.** The value stays in the filter object, so a range
    set in Volume is still there on the way back from Coverage
  - **The Map's bar is a SLOT the panel emits, filled by `renderFBars()` like
    every other page's** — `renderMap()` renders `<div id="fb-map"></div>`, not
    `${buildFBar('map')}`. Embedding the bar in the innerHTML was tried and
    broke every dropdown on it: Office, Status and Custom dates all open by
    flipping a flag and calling `renderFBars()`, which was skipping map, so the
    panels never opened and the date presets never repainted. `renderFBars()`
    must not skip map, and `renderMap()` calls it after replacing its innerHTML
    because the slot is empty until it does. Still `buildFBar` — one builder, a
    different home. A second Map-specific bar is how WIP's private
    `buildWIPFBar` drifted into having no Office control
  - The mode toggle carries a hairline between the four that read the filter
    and the two that read the live book. A divider, not a heading: the bar
    below already shows the difference by dropping controls
- **`MAP_MIN_N` is `RS_MIN_CELL`, and the floor is a setting**
  (Settings → Rates → *Minimum sample for a rate*, `S.minCell`). It was a
  separate `3`, which is too low for a rate: of the 114 markets it coloured, 60
  sat on fewer than ten completions and **29 of the 36 painting a perfect 0%
  resurvey rate did it on three to nine jobs** — a green dot off a sample that
  could not have shown a defect. At 10 it rates 54 markets, every one with a
  denominator worth the colour, and the rest draw as the hollow ring that
  already meant "too thin to rate". Both names are `let` and move together in
  `setSetting`; letting them drift is how a market reads thin on Quality and
  rated on the map. Volume and Open WIP are exempt — they are counts, and dot
  size already draws a one-job market as a one-job market
- **Open WIP is DATE INDEPENDENT** (2026-08-31, Doug's call). A survey that is
  open is open whichever period you are looking at, so filtering the queue by
  project start was answering a different question. `mapIgnoresDates()` is the
  one name for the modes that do not read the range — Coverage, Plan and Open
  WIP — and it drives four things at once: `mapVisible()` takes Open WIP from
  `_mapLive` (state-filtered, collected before the range test), the picker's
  state counts follow the same population, the timeline and its note are
  hidden, and `fbShow()` drops the date control. The comment above
  `mapVisible()` had claimed this carve-out since the coverage modes landed;
  only the code disagreed. Verified: 88 open on the full range, on one week of
  August and on January, while Volume still moves 3,831 → 328
- **`setMapMetric` re-renders on `_mapCtlKey()`, not on `mapIsRes()`.** The
  inline bar is built from `fbShow('map')`, which reads BOTH flags, so a switch
  changing either has to rebuild rather than swap the canvas. Testing only
  `mapIsRes()` left Volume→Open WIP offering a date range the mode no longer
  read; testing only `mapIgnoresDates()` left Open WIP→Coverage still offering
  Resource, since both ignore dates. All eight adjacent transitions verified,
  round trips included
- **Nothing on the map is redundant** — audited 2026-08-31, every mode measured.
  Volume is what a map is for; Cycle and Resurvey carry a geographic cut no
  other page has (region is a sales territory, not a place — 0.9d to 5.8d and
  3% to 19% across the markets that clear the floor); Coverage and Plan are
  about drive distance. Open WIP is the thinnest (82 open rows over 32 markets,
  so 182 of 214 dots are empty) and earns its place zoomed into a state more
  than nationally

### The same audit, every other page (2026-08-31)
`fbShow(page)` now covers the whole app, not just the Map. Every page × control
was **measured** rather than read off the source — the real render path
(`scopeRows(); applyFilter(); renderPage(p)`), diffing the content host's HTML
plus a hash of every canvas' pixels, with the filter bar excluded from the
snapshot so a bar redraw could not pass for data moving. Sub-states too:
Performance ×4 cuts, Quality ×4 cuts ×2 chart modes, WIP ×3 lenses, Trends ×2
granularities ×2 completion bases, Map ×6 modes. Things not to undo:
- **Performance, Trends and WIP are clean and were left alone.** Every control
  they render bites, in every sub-state. The honest finding on three of the six
  pages was that there was nothing to hide
- **The Data page keeps Status and nothing else.** `renderEditor()` reads
  `rows`, never `filtered`, and carries no `gfDim()` clause, so `scopeRows()`
  is the only global control that can reach it — the date range, Region, Office
  and Resource were four controls doing nothing. Its own toolbar owns search,
  state and paging
- **The outlier chip has its own flag.** The clause is written in
  `applyFilter()`, so it reaches exactly the surfaces that read `filtered`,
  which is **Performance alone**. It was gated on `show.dates` — right on WIP by
  accident and wrong everywhere else, so the amber chip announced
  *265 outliers >10d hidden* on Trends, Quality, Data and the Map while all 265
  were still being counted
- **Every flag `fbShow` returns has to be read by `buildFBar`.** `office` was
  returned and never read for as long as `fbShow` existed — the Office control
  was gated on `hasOffices` alone, so no page could drop it. A test asserts this
  now, and two more assert `buildFBar` takes no page decision of its own and
  that the bar's count has one definition
- **`fbHint(page)` is that one definition**, read by the builder and by
  `applyFilter()`. They disagreed: the Map printed *3748 of 3836 shown* nine
  pixels above a rail reading **3,824**, and the source editor printed it above
  a table of **3,836** rows. The Map defers to its rail; Data says
  *N rows in scope*
- **`.fbar>.fsep:first-child` is hidden.** Each control carries the separator
  that precedes it, so a bar whose first control is dropped opened on a hairline
  dividing nothing from the edge — already visible on the Map in Coverage mode

Two controls are **hidden and still bite**, both raised and neither changed —
they are metric questions, not layout ones:
- **Region on the Map.** No control, and `show.region` suppresses its chips too,
  yet `gfDim()` still applies it: **3,831 jobs / 214 markets / 23 states → 479 /
  5 / 1**. This is the `?type=` defect in the other direction, an invisible
  control that silently does something
- **Status on Quality.** Dropped because every row there is already complete —
  true only while `Complete` is ticked, since `scopeRows()` keeps a completed
  survey through `s.includes('Complete') && isComplete(r)`. Untick it elsewhere
  and FPY moves **87.0% → 83.1%** on a denominator of 3,748 → 1,883, with
  nothing on the page saying so. Adding statuses does nothing; only removing
  `Complete` bites. Current has the same shape with no bar at all
- `fbShow` still answers for the three pages that render no bar (Current,
  Resource, Billing) and nothing calls it there. Harmless, but it is not the
  whole truth about those pages

## Resource page (added 2026-08-25, restructured 2026-08-26)
Who should do the work, where, and what it costs. The other pages measure the
work; this one measures the people against it. Reads live rows, not `filtered`
— a staffing decision is about the current book — though the filter bar's
region/office cuts still apply. Things not to undo:
- **The team lives in `roster.json`**, hand-maintained, placed by home ZIP.
  There is no Salesforce object for it. `constraints` (today just
  `no_roof_work`, on all four) is **recorded and deliberately not modelled** —
  Doug's call 2026-08-25: start the attribute list, don't divide capacity by it
  yet. Capacity knobs are per-surveyor and fall back to `DEFAULT_SURVEYOR`
- **Every rate uses a recent window** (`RECENT_WEEKS`, 8), anchored on the
  export date. Averaged over the whole dataset, PA York still recommended a
  posting on volume whose sales crew had left the state in July, and a market
  that only opened last month was invisible. `dormant` is its own action for
  exactly this reason — a market with no current work gets no staffing call
- **Mobility is measured, never a named list of offices.** Two attempts failed
  first and both are documented in `lib/coverage.cjs`: mean weekly centroid
  drift measures *dispersion* (an Oregon office selling Portland to Medford
  jitters 153mi and never moves), and straightness produces a false negative on
  the one case that matters (the PA→VA org reads 0.26 because it worked a wide
  territory at each end). What works is asking whether the **early and late
  footprints overlap** — half-separation over half-width. Live: both
  "Solar's Dead" crews flag, Movement–Summit (OR) and the national Virtual
  Closers desk correctly do not
- **Build-vs-buy is quoted as a BREAK-EVEN, not a rate.** Cost per SPWR
  survey is weekly cost ÷ surveys done, so it is meaningless without a
  throughput: quoted at modelled capacity it read $115 against the vendor's
  $418, a sevenfold flattery on the same page whose SPWR column says only 13% of
  that capacity is realised. Break-even (4.1/wk/surveyor) is the one figure
  that does not depend on the capacity model being right. The panel also prints
  where they actually are — $867/survey at 2.0/wk, **above** the vendor
- **The utilisation gap is raised as a question, not sold as headroom.** Four
  surveyors modelled at 14.8/wk each would be ~59; they are doing ~8. Printing
  the difference as available capacity would assert an answer the data does not
  support. Resolve it before trusting any hiring number
- **The team table's last column is not a personal workload.** SF records the
  *resource*, never which surveyor, so SPWR work can only be attributed to
  a place. Nearest-base attribution was tried and handed Portland entirely to
  one of the two surveyors eight miles apart, printing the other at 0.0 — which
  reads as "idle" and is not something the data can say. Ranges overlap on
  purpose and are marked *shared range*
- Insights are **derived from the same markets the table shows**, never a
  written-in narrative, and each states what it is measured from

### The 2026-08-26 restructure
Doug's ask: make it more intuitive, show the resource split first, consolidate
the markets, demote the findings, and say SPWR rather than in-house. Things not
to undo:
- **The page opens on the RESOURCE SPLIT, not a stat rail.** Three columns —
  SPWR / Outsourced / Sales reps — over one shared proportional bar. The old
  six-cell rail had five cells measuring the SPWR team, which is the resource
  doing the *least* work, so the page buried its own headline: **the reps do 55%
  of the surveys at 81.3% yield while SPWR does 9% at 94.0%, and SPWR is at 13%
  of modelled capacity.** One row per column differs (capacity / vendor rate /
  volume); the three under it — yield, cycle, cost per survey — are the same
  three in the same order, which is what makes them readable as a comparison
  - **Columns are EQUAL width.** Sizing them by share was tried: a 9% column
    cannot hold a number, and the bar above already says 9%
  - **No colour cap on the column.** A 3px bar under a full-width segmented bar
    reads as a doubled bar; the share numeral is already drawn in the resource's
    own hue, which identifies the column on its own
  - **Volume is the recent window; yield and cycle read every completion.**
    Eight weeks of one resource is too thin to band a defect rate on
  - FPY comes from `fpy()` in metrics.cjs. A local `(n − defects) / n` here
    would trip the surfaces guard, and rightly
  - Colours are `--res-spwr` / `--res-vendor` / `--res-rep`, added to **both**
    `:root` blocks. They were already hardcoded as `RES_COLORS` in four charts;
    the tokens exist so the hero can tint from one place, not a fifth copy
- **The market table is grouped: one grouping, two cuts (state · recommendation)
  plus the team**, the pattern Performance and Quality already use. It was 182
  markets behind a top-40 window, and **26 of those 40 said "leave with vendor"
  at under 1.6 jobs a week** — a decision surface that was two-thirds noise.
  Rolled to states it is 14 live rows, four carrying 80% of the work
  - **A group's recommendation is ELECTED BY ITS MARKETS**, never
    `marketAdvice()` run on the summed group. The summed version was built first
    and was wrong: **Ohio came out *Absorb now* while all five of its live
    markets said *Leave with vendor*** — reach was taken from the state's
    nearest corner (a dormant market 59mi from Detroit) while the outsourced
    volume was summed from markets 102–228mi away. A group row that contradicts
    every one of its children is a bug. Volume-weighted, not one-market-one-vote:
    Oregon is 15 markets of which Tigard alone is most of the state
  - Counts, rates and money still sum. Reach and nearest base take the best case
    across the group and are **display only** since the election landed
  - **The recency floor is recent work, not all-time volume.** The old floor was
    `n>=3` all-time, which kept 95 dormant markets in the default view. Quiet
    groups collapse behind one line that counts them; inside an open group,
    quiet markets sink to the bottom greyed rather than being hidden
  - **The "Why" moved into the market's expanded row.** It was a 240px column of
    prose that made every row three lines tall
- **"Action" is now "Recommendation"** (`RECOMMENDATIONS` in `lib/coverage.cjs`,
  `.res-rec-*` in CSS). The page never takes an action; it makes a case and the
  manager decides, and the old name had the table promising more certainty than
  its thresholds carry. `.res-rec-dormant` now exists — it never had a rule, so
  "Gone quiet" rendered as unstyled text in a column of tags
- **Intake trend is the one leading indicator in the export** —
  `intakeTrend()` in `lib/coverage.cjs`, three 28-day windows of project starts.
  **Three, not two**: VA reads 6 → 201 → 179 (a crew arrived and is holding) and
  PA 220 → 39 → 23 (a crew left), and two windows score them alike. Thin samples
  name no direction but still draw their bars; "gone quiet" is tested *before*
  the thinness guard and "just opened" *after* it
- **Outlook is Doug's own judgement and never feeds a recommendation.**
  `outlook.json`, keyed by state, written from the page through
  `api/update-outlook.js` (reuses `GITHUB_TOKEN`/`UPDATE_PASSWORD`, no new
  Vercel config). Committed rather than localStorage — Doug's call 2026-08-26,
  and the WIP "needs attention" badge already showed what happens when a
  judgement lives in one browser. State is the key because it is the unit a
  sales crew moves in and the only one stable across a change of map radius
- **Nothing on this page re-renders the page** (2026-08-27, Doug's ask: make it
  smoother). `renderResource()` measured **177ms**, and `resToggleIns()` —
  opening one collapsed paragraph — paid all of it, as did every drawer open and
  every switch of the cut. Two causes, both fixed:
  - **`resMarkets()` is memoised**, and it ran TWICE per render because
    `_renderResBody()` recomputed what `renderResource()` had already built.
    Clustering every placeable in-scope row is ~100ms of the 177. The key is the
    **identity** of everything it reads — `allRows`, `mapRadius`, `MAPGEO.zips`,
    `_roster`, `_billing` — which is sound because none of those are mutated in
    place: `loadAll()` returns a new array, `delRow()` filters, an import
    reassigns `_billing`. The capacity model is the exception, since
    `applyResModel()` applies it by mutating OpsCoverage's base config, so it
    **bumps `_resModelGen`** — if another path ever changes the model, it has to
    bump that counter or the page will show stale capacity
  - **A findings row toggles a class.** The detail is always in the DOM and
    `.res-ins-d` is hidden by CSS, so opening one is a class flip rather than a
    rebuild — which is also what lets the caret and the body carry a transition,
    something a destroyed-and-recreated node never could
  - Measured after: full render **177ms → 20ms**, switch cut 30ms, open drawer
    31ms, open a finding **177ms → 0.2ms**. Memo invalidation verified against
    radius (214 markets → 359 at 15mi → 214), the model and a row replacement
- **Findings are collapsed and moved below the table.** The derivation stays —
  every line recomputes from the markets the table shows — but headlines carry
  it and the detail opens on demand. **The capacity caveat is repeated in the
  SPWR column** because every capacity figure on the page is wrong if it is
  wrong. A severity dot on the panel title says whether anything in there is red
- **Internal identifiers still say `inhouse`** (`inhousePerWeek`, `m.inhouse`).
  Same rule as "Quality is the nav label only" — the rename was the display,
  and churning ~20 identifiers buys nothing
- Three bugs fixed in the same pass, all live before 2026-08-26:
  - `billingEnsure()` re-rendered Billing unconditionally, so the Resource
    page's Vendor cost column was **empty on a first visit** and only filled in
    after a trip to Billing and back
  - `resVendorCostByZip` was summed **over members rather than distinct ZIPs**,
    adding each ZIP's whole total once per job in it: Bend, OR read "379 billed"
    against a true 19, and per-survey rates were off by up to $20
  - the market detail row's `colspan` was one wider than the table

- **Panel titles are noun phrases** (2026-08-26). *What this says* → **Findings**,
  *What to do, market by market* → **Markets**, switching with the
  toggle the way `Resurveys by <group>` already does. Every other title in the
  app is a noun phrase; three question-shaped ones on one page read as a
  different product. *Where the work goes* → **Resource split** 2026-08-27 —
  the rule was written on this page and the hero was still breaking it
- **The notes and findings state the number and stop** (2026-08-27, Doug's ask:
  less help text, no over-explaining). What came out was argument, not
  definition — "Yield here is the whole team's biggest quality lever", "the case
  for insourcing is throughput, cycle time or quality, not price", "A surveyor
  fixes one job; the rate is a training problem", "A one- to two-week posting is
  reversible; a hire is not", "This is a deployment and hiring question, not a
  scheduling one". The same rule the `.note` already followed since 2026-08-26,
  applied to the findings' detail bodies and the hero's column notes. What
  stays is a definition, or a caveat that changes how a number is read:
  - **The capacity caveat stays** in the SPWR column, because every capacity
    figure on the page is wrong if it is wrong
  - **The team drawer's note was ten lines of 10px grey** — the derivation, a
    capacity ladder at four distances, a mileage ladder at four more, the
    vehicle rule, the loaded cost and two warnings. It keeps `resModelLine()`,
    the loaded cost, and the two things a reader would otherwise misread (the
    last column is a place not a person; a constraint is recorded not modelled).
    The ladders are in Settings, which the sentence already links to
  - **The market note no longer instructs or justifies.** "open a row for its
    markets, a market for why" is UI instruction and "Outlook never changes the
    recommendation beside it" is design history; both belong in a source
    comment, which is where they already were
  - **No positional references.** The Sales reps lead said its cost lands "in
    the column to the left", which is false below 860px where the columns stack.
    It names Outsourced instead
- **The expander is named for the column above it** (2026-08-27). It read
  *SunPower Surveyors* under a heading reading *SPWR surveyors* — two names for
  one thing, 200px apart. Same rule as "Quality is the nav label only": pick the
  displayed name and use it everywhere it is displayed
- **Build vs buy is a hairline-divided row, not three cards.** The columns were
  bordered `--surface` boxes on a `--surface` panel, so the fill did nothing and
  the border doubled the panel's own — the same nesting `.exec-hero .srail`
  flattens. Value is `.kval`'s 24/700, not a fifth numeral size
- **The action tag's tints come from the palette's `-bg` tokens.** It carried
  four hand-mixed `rgba()` values and a `#7b5aa6` purple that exists nowhere
  else in the app; `coach` is `--red-bg` and `deploy` uses `--blue-bg`/`--blue-dk`,
  added to both `:root` blocks

### The 2026-08-26 second pass (model in Settings, team in the hero, no filter bar)
Doug's ask: show where the modelled capacity comes from, make the figures behind
it editable, move *The team* into the split, and drop the filter bar. Things not
to undo:
- **The page has NO filter bar, and therefore does not read `GF`.** Region,
  office, status and a completion date range are survey-reporting vocabulary;
  none of them frame a staffing question. `GF` is one object shared by every
  page, so *removing the bar while still calling `gfDim()`* would have left a
  region picked on Performance narrowing this page invisibly — the `?type=`
  defect again. `resScope()` is the page's own population: every row in
  `DEFAULT_STATUSES`, whatever any other page's controls hold. Both `resPoints()`
  and `resSplit()` go through it
- **The capacity model is editable in Settings → Resource model**, and it works
  by `OpsCoverage.setModel()` rewriting the base `surveyorConfig()` merges from
  — **one assignment point**, the same discipline `applyAnchor()` follows for
  `r.start`. There are callers that are never handed a cfg at all
  (`weeklyCapacity(25)` in three notes), which is exactly why it is done in
  `lib/coverage.cjs` rather than by threading an argument through the page. A
  surveyor's own knobs in `roster.json` are passed as `partial` and still win
- **`roadFactor` is a knob on the config now**, not a constant multiplied inside
  `driveMinutes()`. `ROAD_FACTOR` survives as the shipped value and the fallback
- **`S.resModel` / `S.resCost` are nested objects holding only the OVERRIDES.**
  An empty object is what says "still the shipped estimate", which is what the
  *edited* badges and the reset button read. `applyResModel()` runs on boot,
  before anything asks what a surveyor can do in a week
- **`perDiem` and `lodging` were deleted from `RES_COST_DEFAULTS`.** They fed no
  figure on any page. A setting that changes no number is worse than a missing
  one — it reads as though somebody already accounted for travel
- **The derivation is printed, not just the result.** The page said "59.2
  modelled" with nothing on it saying where 59.2 came from. `resModelLine()`
  renders the arithmetic from the LIVE model (Settings, and the team drawer's
  note), and `TIP.resCapacity` carries the short version on the hero itself.
  59.2 = 4 surveyors × 14.8/wk at an 8-mile market — the optimistic end
- **The team moved out of the market toggle and into the split hero.** It was a
  third cut of a control whose other two states slice 182 markets; a roster is
  not a way of slicing markets. Each of the three columns now opens the people
  behind its own numbers: SPWR → the roster, Outsourced → the vendor registry
  (from `OpsBilling.VENDORS`, so a vendor with a spec and no invoice still shows
  at zero), Sales reps → best and worst ten
- **One full-width drawer under the three columns, never three drawers under
  three 230px columns.** `resExpand` holds at most one id, and `setResExpand()`
  toggles (an expander closes when you click the one that is open — unlike
  `setResGroup()`, which assigns because a segmented control must no-op on the
  segment you are already in)
- **The rep lists rank on the Quality page's rule, not a new one**: self-surveyed
  completions only (`resource === 'Sales Rep'` — grouping every completion by
  `sales_rep` charges a rep for a Radicl surveyor's defect), floored at
  `RS_MIN_CELL`, ranked on the defect rate behind the FPY column. `RS_MIN_CELL`
  is module scope now so there is one floor, not one per surface
- **The Outsourced column does not name the vendor** (2026-08-26). It was
  *Outsourced (Radicl)*; a second vendor is coming, and the drawer lists them.
  The expander labels are plain nouns — *SunPower Surveyors*, *Vendors* — with
  no count in them
- **A surveyor's vehicle is an attribute, and it changes how they are costed**
  (2026-08-26). `vehicle` in `roster.json` is `own` or `company`; absent means
  `own`, which is what all four are and the assumption for a new hire. A company
  vehicle is the flat `vehicleMonthly`. Own is **reimbursed per road mile** —
  40¢/mi, plus 20¢ on every mile past 100 **in one day**. Things not to undo:
  - **The bonus is a DAY rule, applied per day and multiplied out.** Applied to
    a weekly total, a surveyor doing 60 miles five days running would collect a
    bonus they never earned
  - **`dailyMiles()` is in `lib/coverage.cjs`; what a mile is worth is not.**
    The miles are geometry (round trip + a hop between each pair of jobs, on the
    exact daily job count, × `roadFactor`); the rate is payroll and sits with
    the other cost knobs. Same split that keeps `metrics.cjs` about surveys
  - **This is the one cost on the page that reacts to the coverage model** —
    it rises with the drive: $82/wk at an 8-mile market, $380 at 60. That is
    also why it is quoted at the same 8-mile market the capacity above it uses
  - Team figures (break-even, cost per survey) read `resTeamWeeklyCost()`, the
    **mean across the roster**, since two surveyors on different arrangements
    cost different amounts. It falls back to the default surveyor before the
    roster loads
- **The model is committed, not just in localStorage** (2026-08-26, Doug's ask
  that edits "survive and push to the server"). `resmodel.json` + 
  `api/update-resmodel.js`, the shape `outlook.json` already uses. Things not to
  undo:
  - **localStorage is the WORKING copy and `S.resSaved` is the arbiter.** It
    stamps what the server held when this browser last adopted it, which is the
    only way to tell an unpushed local edit from somebody else's save: adopting
    the server on every load throws away what was typed here a minute ago, and
    never adopting hides every other machine's changes. Four paths are tested by
    hand — clean browser adopts, dirty browser keeps, reset returns to shipped,
    save clears the dirty flag
  - **Only overrides are stored**, and an absent key IS "not overridden" — which
    is also how a knob goes back to its shipped value. The endpoint drops any
    key it does not recognise rather than refusing the save that carries the
    other eight
  - **No per-field "edited" badge, and no password on Save.** Doug's call: the
    value in the box is the value in use, and a badge beside it only repeats
    what the box says. One section-level line says whether the server has it
    yet. The endpoint's validation is what stands in for the password — see A1
- **The three hero columns are a GRID with `subgrid` rows, not a flex row**
  (2026-08-26). Flex could only align the tops: the lead line wraps to two lines
  in one column and one in another, and from there down nothing agreed — *First
  pass yield* in the middle column sat beside *Cycle time* in the outer ones.
  Without `subgrid` support the columns fall back to independent flow rather
  than to something broken. Two things about it, both found 2026-08-27:
  - **The base `.res-col{display:flex}` MUST stay above the `@supports` block.**
    It sat below it at equal specificity, so flex won unconditionally and the
    subgrid never ran for a single render: only the expanders lined up, which
    `margin-top:auto` does on its own, while every band above them sat at a
    different height per column (22px out between the outer columns at 920px).
    It looked right at 1440px only because the three lead lines happened to
    wrap to similar heights
  - **`repeat(3,1fr)`, never `auto-fit`.** auto-fit wrapped to 2×2 under about
    1150px, and then *Sales reps* landed in row 2 column 1 still matching
    `:not(:first-child)` and sat 18px out of line with the column above it; the
    open column's tab was in row 1 while its drawer was two rows below, so the
    notch pointed at nothing. Three columns hold to 861px and stack to one
    below it, where the hairline turns horizontal, the side padding resets and
    the open column takes a **closed** ring — stacked, the drawer is at the foot
    of all three, so an open bottom edge would point at the next column
- **The open column is a TAB.** It takes the drawer's background and drops the
  hairline to its neighbour, so the tint runs unbroken from column into panel
  and which one is open is readable at a glance. The outline is an **inset
  shadow, never a border** — a real border resizes the grid cell and shoves the
  other two columns sideways on every open. The 2% tint alone was not enough:
  `--bg` on `--surface` is `#faf9f6` on `#fff`
- **The expanders are bordered buttons**, not underlined text on a hairline.
  They are the one control in the panel, they sit on one line across all three
  columns, and a caret alone at the foot of a column of numbers did not read as
  a control
- **The column expanders sit on one line.** `.res-col` is a flex column and the
  button takes `margin-top:auto`: the notes above them run to different lengths,
  and three carets at three heights read as three unrelated controls

## Billing page (added 2026-08-25)
Third-party surveyor invoices reconciled against Salesforce. Built because the
invoice is the only place several real costs are recorded and none of them are
labelled. Things not to undo:
- **Everything comes from a vendor spec** (`VENDORS` in `lib/billing.cjs`):
  unit price, column map, subtype taxonomy, SF resource name. Doug's ask
  2026-08-25 was that a second subcontractor be easy to add — that means a spec
  object plus `--vendor <id>`, never a second parser or a second rule set. A
  test asserts nothing below the vendor registry names a vendor or its price
- **A vendor spec column may list several accepted labels, newest first.**
  Radicl's 08.24.26 statement renamed *Credits* → *Total Credits* and *Running
  Credit Balance* → *Running Balance*, and inserted an *Organization* column
  before Address. The old labels stay in the map so re-importing an older
  statement still parses, and columns are found by label rather than position,
  so an inserted column costs nothing. This is the failure mode to expect from
  a vendor: fix it in `VENDORS.<id>.columns`, never in the parser
- **`billing.json` is the master history, and one charge is stored once.**
  Re-importing a statement replaces that statement's lines in place. A charge
  another statement already carried is stored ONCE — `dedupeHistory()` in
  `lib/statement-import.cjs`, Doug's call 2026-08-26, reversing the original
  "never dedupe, flag it instead" rule. Radicl's statements overlap by design
  (08.24.26 re-reports all of Aug 1–8), so 118 of the second statement's 395
  lines were charges the first had already billed, and the history counted
  them twice: **$165,702 invoiced when the real figure is $137,821**, with
  travel adders overstated by 49 lines that no rule even flagged. Things not
  to undo:
  - **Identity is strict** — vendor + normalised name + normalised address +
    date + type + subtype + **amount**. Not `OpsBilling.accountKey()`, which is
    surname plus street number and is deliberately fuzzy because its job is
    matching a statement to Salesforce. Here a false positive silently deletes
    money that was really billed, so the safe direction is to keep a line and
    let a rule flag it. A corrected re-bill has a different amount and is
    therefore a different charge, which is right
  - **Count-aware, not "drop every repeat".** A statement legitimately carries
    the same line more than once — 10 groups in the live data, up to 3 travel
    adders for one account on one day. Per identity the history keeps as many
    copies as the statement that reported the MOST of them. Dropping every
    repeat would delete real money
  - **Nothing is lost.** The kept line records the other statements it appeared
    on in `alsoOn`, and each statement's meta gets a `dupes` count. Both are
    recomputed over the whole history on every merge, so they are self-healing
    rather than a running tally that can drift; re-importing a statement also
    clears its id from every other line's `alsoOn` first, since the incoming
    file is then the only authority on what that statement contains
  - **A statement's `lines` still counts the statement as invoiced**, not what
    it added to the history. The modal prints both — `395` against `277 added`
    — because the gap is the thing worth seeing before importing another
- **"Re-billed on another statement" means a MOVED DATE.** `cross_statement`
  fires on the same account and charge type across two statements carrying
  **different** dates; same-date is not flagged and is not even stored twice.
  Doug's call 2026-08-26: overlapping periods re-report a charge as a matter of
  course, and an alarm that fires on all 67 of those teaches you to ignore it.
  A moved date is the shape a double bill takes, because neither statement
  shows the other. On the live history both this rule and `duplicate_charge`
  now read 0 — every apparent duplicate in the data was the overlap artefact
- **`billing.json` ships and the page is public** — Doug's call 2026-08-25. It
  was first built gitignored with the tab behind a localStorage unlock; that
  gate was obscurity rather than access control, so once the data was committed
  it bought nothing and was removed rather than left in to imply a protection
  that was not there. It is fetched, not baked into the page, because
  parse-radicl.js writes it on its own cadence and not on the daily data push.
  If it ever needs to be private in earnest the answer is Vercel Deployment
  Protection, not a flag (see A1/X5)
- **Every rule is a prompt to check, never a verdict.** The tool knows what the
  invoice says and what Salesforce says; it does not know the contract. An
  exception worded as an accusation gets ignored the first time one turns out
  to be legitimate. Severity colours the chip's left edge only — a fully tinted
  card would say "error" about rules that are deliberately informational
- **Own-defect rework needs BOTH attribution and who held the original survey.**
  SF attributes a rep-performed survey to "Surveyor" too, meaning the rep.
  Reading attribution alone turned 1 real case into an apparent 4 on the first
  statement. Tested
- **A first visit followed by a return is a sequence, not a duplicate.**
  `repeat_visit` is informational; `duplicate_charge` fires only on the same
  charge type twice. Flagging Base→Go Back as duplicate cried wolf on every
  legitimate return. Tested
- **Cleanup is reported as cost, not as an error.** Partial Surveys billed at
  the full first-visit rate to finish someone else's survey were 22% of the
  first statement, nearly all on Sales Rep originals ~19 days later. It is not
  disputable and it is the largest single finding on the page
- The parser prints the same kind of non-blocking sanity report to stderr that
  `parse-sf.js` does, including a warning when two statements' periods overlap
- **In-app import, added 2026-08-25.** The Billing page has an "Import
  statement" panel — pick a vendor (hidden while only one exists, same rule
  the vendor filter follows), choose the `.xlsx`, enter the update password.
  Parsing and the merge rule (replace this statement's own lines, keep every
  other statement's) live in `lib/statement-import.cjs`, shared by
  `parse-radicl.js` and `api/update-billing.js` — an upload here and a
  terminal import run the same code path, not two parsers. The endpoint reuses
  `GITHUB_TOKEN`/`UPDATE_PASSWORD`, the same env vars `api/update.js` already
  uses to commit `data.js`/`data.json` — no new Vercel config. It commits
  `billing.json` straight to `main` via the GitHub Contents API and returns
  the merged history, which the page applies in memory immediately; the
  commit itself is live for everyone else in ~30 seconds, same as the SF
  data-update flow
- **Cost per account, added 2026-08-25.** `OpsBilling.byAccount()` already
  existed (used by the CLI report) but had no page surface. The "Cost per
  account" table sums every charge line an account drew — survey plus travel
  adders, cleanup, rework — into one total, so three travel adders and three
  surveys on one account reads as what that account cost, not a per-survey
  average
- **State, added 2026-08-25.** Both the charges table and the accounts table
  carry a State column, read off the matched Salesforce row's address with
  `MAP_ZIP_RE` — the same ", ST ZIP" capture the Map page uses. A statement's
  own address column has no state on it, and an unmatched line has none either
- **The exceptions are filter chips inside the Charges panel** (2026-08-26).
  They were six KPI-style cards in a panel of their own titled *What to check*,
  sitting under a six-cell stat rail — the page opened on twelve big numbers,
  and the rail and the cards said Cleanup and Rework twice in different
  vocabularies (rail "Rework $2,556 · 9 visits" against a card reading
  "1 · REWORK ON THEIR OWN DEFECT · $284"). Card grids for a control are the
  pattern every other page already replaced. Things not to undo:
  - **They select rows in the table directly below them, so they live in that
    panel**, the way the WIP status bar sits in the queue panel. One panel, one
    control, one table. The rule's `why` prints between the chips and the table
  - **`.bill-flags` gets `narrowed` only when a rule is picked.** "All charges"
    is the unfiltered state; dimming the other chips on load would say five
    populations are excluded when nothing is filtered
  - Severity is a **7px dot**, not a tint or a left edge — a coloured chip would
    say "error" about rules that are deliberately informational
  - They are `<button>`s, not `.drill-tgt` divs. Lift-and-shadow is reserved for
    things that open something; a filter darkens its border and does not move
  - **A FIGURE APPEARS ONCE — clickable in the chips, otherwise in the rail**
    (2026-08-27). The 2026-08-26 pass turned the cards into chips but left the
    rail at six cells, so the collision it set out to fix survived the rewrite:
    Travel adders `$42,410 / 31%` against the chip's `243 · $42,410`, Cleanup
    work `$19,880 · 70 visits` against `70 · $19,880`, To review `$3,408 · 12
    lines` against `12 · $3,408` — and **"Rework" naming a SUBTYPE in the rail
    ($4,260 · 15 Go Back visits) with the same word the chip beside it uses for
    a RULE** (4 · $1,136 own-defect rebills). The rail is three cells now —
    **Invoiced · Per survey · To review** — which is what no chip can say: the
    total, the all-in unit cost, and the roll-up across every non-informational
    rule. Travel, cleanup and rework are one click each, under a fuller label
    than the rail gave them. "Rework" appears exactly once on the page
  - **"All charges" carries its COUNT, not its money.** It is the reset state,
    and the total is already 40px above it at 29px
  - **The note under the chips is the selected rule's `why`, or nothing.**
    Unfiltered it printed a line restating the panel title ("Every charge on
    every imported statement") and, on the account lens, the panel subtitle
    word for word nine pixels above it
  - **The rail has no CSS of its own any more.** Money is the widest value any
    rail in the app carries: at six cells they collided under ~1200px
    (`$137,821` measures 126px at 29px/700, so a cell needs ~162px and six need
    ~972px of rail — more than that window leaves beside the 180px sidebar),
    and `.srail-sub` had to be forced onto its own line because it fitted
    beside some values and not others. At ~400px a cell neither happens, so
    Billing uses the shared component exactly as every other page does. Both
    constraints are what a fourth cell would have to clear
- **Cost by project outcome is the third lens** (added 2026-08-26). Charges ·
  By account · **By outcome** — `byOutcome()` in `lib/billing.cjs`, grouping
  charge lines by the matched survey's `project_status`. Live: **14% of vendor
  spend ($19,230) is on projects since canceled, 8% more on At-Risk**. It was
  invisible before the same day's report change, which brought canceled
  projects into the SF export — until then exactly ONE canceled row was in
  scope and every dollar looked like it had been spent on a live deal. Things
  not to undo:
  - **It is not an exception and is not coloured.** Every one of these surveys
    was performed before its project resolved; nobody surveyed a house knowing
    the deal was lost. Doug's call 2026-08-26 — it is the cost of doing
    business, and a severity tint would call it an error. Same rule that has
    cleanup reported as cost rather than as a fault
  - **`dead` marks Canceled only.** At-Risk is a project on its way somewhere,
    not a loss; adding the two would report a number that keeps moving as those
    projects resolve either way. The two sit as separate rows and the reader
    adds them if they want to
  - **Cut by `project_status`, never `opp_stage`.** Stage disagrees with status
    on 4 rows in 3,791 and on 2 billed lines out of 624, so cutting by it would
    draw the same picture from a field with no history behind it. A test asserts
    `lib/billing.cjs` never mentions `opp_stage`
  - **The unmatched bucket is called "No project matched", not "No Salesforce
    record".** That is the `no_sf_match` exception's label, and that rule fires
    only on WORK lines — the chip and the bucket would carry one name and two
    amounts on the same screen ($2,272 against $2,942, the gap being the travel
    adders those visits drew). The Visits column still reconciles to the chip
    exactly; the name is what has to differ
  - **The chips filter the LINES here, unlike the account lens.** An account's
    total means "what this account cost", so narrowing it to flagged lines would
    change what the number is; an outcome group is just a set of lines, so
    "what the flagged lines cost, by outcome" is an honest reading
  - The bar is a share of the **largest group**, not of the total: at 73% for
    one row every other bar would be a stub
- **The Statement column is hidden while one statement is in view**, the same
  rule the vendor toggle follows — it printed the same filename on all 343 rows.
  Picking one statement in the bar hides it again for the same reason
- **Bar · rail · one panel** (2026-08-26). It was five stacked sections that
  printed every row of both tables: 39,897px, 44 screens, with the import
  controls at the very bottom of it. It is 2,915px now. Things not to undo:
  - **One panel, two lenses — Charges · By account.** They were two
    full-length tables of the same money, 710 rows then 323, printed back to
    back. Same "one grouping, N cuts, one table" shape Performance and Quality
    already resolved. The exception chips apply to both: under the account lens
    they keep accounts *carrying* a flagged line, and the total stays what the
    account cost across every line it drew — filtering the lines first would
    make it the cost of the flagged lines, which is the one thing this cut
    exists not to say
  - **Paged, not capped.** Both tables rendered up to 400 rows on load, which
    is what made the page 44 screens. `BILL_PAGE` (50) show, the rest is a
    click. `billCopy()` expands to everything *before* copying, so "Copy table"
    never quietly copies only the visible page
  - **Which statement billed a line sits UNDER ITS DATE** (2026-08-27), not in
    a column of its own. As a column it was the widest thing on the right
    carrying the least: the table opens newest-first, so every visible row
    printed the same filename in 10px faint. A charge's date and the statement
    that reported it are one fact, and secondary detail under its primary cell
    is what `.cmeta` does everywhere else in this table. Cutting *by* statement
    is the bar's filter, so nothing was lost when the sort went with the column
    — and dropping it gave Salesforce and Also flagged enough width to stop
    wrapping their pills to two lines. Still hidden entirely while one
    statement is in view, the rule the vendor toggle follows
  - **The chips are in severity order, not by size.** `EXCEPTIONS` runs the
    high-severity rules first and the informational ones after, which is the
    reading order; sorting by count would put Travel adder first and bury
    "No Salesforce record". The ragged wrap is the cost of keeping that
  - **Paging redraws the TABLE, not the panel** (2026-08-27). `billMore()` and
    the expand inside `billCopy()` went through `_renderBillMain()`, which
    rebuilt the rail, the notice and the whole chip row in order to add fifty
    rows beneath them. They call `_renderBillTable()` now; the rail and the
    chips are the same DOM nodes across a page-in. Copy still expands first —
    verified 50 → 592 rows before the clipboard write
  - **Import is a modal off the bar's top-right**, not the last panel on the
    page — it is the one thing you come here to do, and it sat below 1,033
    rows. *Statements imported* went into the modal with it: what is already
    loaded is the context for loading another, and it is what a re-import
    replaces. Its other job — naming the period — is the bar's now
  - **Billing has its own filter bar and it is not `buildFBar`.** Region,
    office, status and the survey date range are survey-row vocabulary; an
    invoice line has a mission date, a statement, a vendor, a charge type and
    (via its matched row) a state. The bar owns `billF`, which is deliberately
    **not** persisted to `ops_filters` — a remembered date range on a page you
    visit monthly is a trap
  - **Every control scopes every number.** The rail, the chips and the table
    all read `billScoped()`, so a date range or a state narrows the page rather
    than narrowing one table under a national rail — the rule Quality and Map
    are already held to. Search is the exception only in *where* it re-renders:
    `setBillQ` redraws `#bill-main` and never the bar, so the caret stays put
  - **Reconcile once, over the whole history, then filter the result.** The
    duplicate and cross-statement rules read every line an account ever drew,
    so narrowing the input first would quietly switch them off — pick a single
    statement and "appears on two statements" could never fire again
  - **Date presets anchor on the newest charge, not on the wall clock.** A
    statement arrives weeks after the work, so "this month" measured from today
    is empty for the first days of every month
  - **ONE notice above the table, and it is an alarm.** Amber `.bill-warn`
    when `cross_statement` lines are in scope — the same charge type billed on
    two statements under different dates, with a button that selects the rule.
    A grey twin saying "these statements overlap, N charges were reported on
    both, counted once" was built and **removed the same day** (Doug: "we
    should be deduping and this shouldn't be an issue"). He is right: the
    periods overlap by design, every statement re-reports the tail of the last
    one, and the import already stores one copy — so the note reported a solved
    problem on every load, forever, which is how a notice stops being read.
    Where that fact IS worth stating is at the moment of import, and the
    modal's statements table states it there: `395` lines, `118 already
    billed`, `277 added`
  - **Both tables sort through `billTh`/`billSorted`.** Text columns open A to
    Z and numeric ones highest-first, blanks sink in both directions — the same
    vocabulary as Performance, Quality and the drill drawer. The charges table
    had no sort at all before, only a hardcoded newest-first

### Entrance animation on the two async pages
`animateSections()` runs once in the `requestAnimationFrame` after
`renderPage()`. Billing and Resource render a **"Loading…" placeholder** first
and fill in when their fetches land, so that rAF staggered the placeholder and
the real content then appeared with no entrance at all — the only two pages in
the app that did not fade in. Resource is the worse of the two: it waits on
`roster.json` *and* `geo/zips.json`, so panel one animated alone and the other
three popped in a beat later. Fixed 2026-08-27 with `_awaitingContent`: the
placeholder branch marks the page, and the render that replaces it calls
`_animateOnArrival()`, which fires **once** however many fetches it was waiting
on. Don't replace this with an unconditional `animateSections()` in the loader —
Resource has three loaders that can each resolve separately, and the sections
would re-stagger on every one.

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

**The in-app modal's save is GZIPPED, and it has to be** (2026-08-27). Vercel
caps a function's request body at **4.5MB**, ahead of the function — the
`sizeLimit` in `api/update.js` never applied and raising it does nothing. The
2026-08-26 report change took the payload from 3.2MB to 5.9MB, so every save
through the modal returned `FUNCTION_PAYLOAD_TOO_LARGE`; push.sh was unaffected
because it commits the files itself. The client compresses with
`CompressionStream` and sets `x-encoding: gzip`; the endpoint runs with
`bodyParser:false` and gunzips the raw stream. ~7x on this data, 885KB on the
wire. A plain JSON body still parses (curl, a browser with no
`CompressionStream`) — it is just held to the 4.5MB cap. `api/update-billing.js`
carries the same cap on a base64 xlsx and would break at a ~3.3MB statement;
they run a few hundred KB today.

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

## The 2026-08-26 report change (canceled projects + two columns)
Doug widened the SF report: it now carries every project, not only live ones,
and added two columns. Row count 2,530 → 4,706, nothing dropped.
- **The canceled rows are the valuable half and are permanent.** 2,171 of the
  2,176 added rows are Canceled. They fixed Billing's reconciliation (**"No
  Salesforce record" 53 → 13**) and made *Cost by project outcome* possible
- **`inScope()` already handled them and needed no change.** A completed survey
  counts regardless of project status; only non-complete rows get the status
  test. So WIP was **unaffected (60 → 60)** — the 126 open tasks on canceled
  projects, median age 119 days, never reach the queue. The rule was written for
  this population and had one row to act on until now
- **History restated, and one metric is biased by it.** Completions 2,381 →
  3,731. Cycle time is unbiased (within each resource the canceled rows sit
  within a few tenths, so the 4.02 → 3.71 move is a mix shift — canceled work is
  86% rep against 72% for active). **FPY is not**: 84.0% → 86.7%, and the whole
  gap is Sales Rep (canceled 92.5% vs active 81.6%, against Radicl −0.2 and
  SunPower −6.2). A rep-surveyed job that cancels never has its photos reviewed,
  so the resurvey is never logged — the defect existed, nobody recorded it. Old
  cohorts corroborate: January's gap is 1.2 points, June's is 16.5.
  **SETTLED 2026-08-26, don't re-open: FPY counts every completed survey,
  canceled projects included.** Doug's reasoning — the point is to measure the
  work this team did, and dropping completed work because the deal died later
  at some other stage just gives us less data to measure with. The survey was
  performed either way. Excluding canceled from the FPY denominator was
  proposed and REJECTED; the bias is recorded here so the number is read with
  it in mind, not corrected for
- **Recent weeks barely move** (4–10%), old ones move 33–71%: cancellation is a
  ratchet, so the further back you look the more of that week has since died.
  The Monday recap is essentially unaffected; the Trends line is not
- **`opp_stage`** (Project Event : Opportunity : Stage) — carried, nothing
  computes with it. **99.75% predicted by `project_status === 'Canceled'`**; 4
  rows in 3,791 disagree. Keep it for the handful where the deal is lost but the
  survey task is live; do not build on it
- **`holding_reason`** — 5 values, multi-select, and **never cleared**: 50% of
  COMPLETED rows still carry one, so it reads "was ever held for X", never "is
  held for X". Two of its values (Site Survey Requested, Resurvey Requested)
  restate `requested` and `isOpenResurvey` and agree with them only 68% of the
  time over history — **the derived versions are better, don't switch**. The
  photo-missing values are the only new information in it. **Carried, unused —
  a WIP surface was considered and REJECTED 2026-08-26, don't re-open it
  without new evidence.** It has no timestamp and is never cleared, so it
  cannot say what a row is waiting on *now*: three live rows carried All Photos
  Missing while already booked (1632CATH scheduled 8/28). It cannot
  discriminate either — "Site Survey Requested" sat on 17 Scheduled, 11 Radicl
  scheduling and 6 Missing UB, i.e. nearly every open row — and it is blind to
  the sharpest category, since the picklist has no utility-bill value at all.
  `wipQueueStatus()` classifies off `last_reviewed_subject`/`last_comment` and
  that is correct: the note's median age across the 58 reviewed open rows is
  **0 days**, 57 of 58 within two days, oldest five, and it is usually the more
  specific of the two ("MISSING PHOTOS - SCHEDULE WITH FIELD 8/27" against a
  bare "All Photos Missing"). The historical read stands as analysis only —
  19.8% of completions were ever held for missing photos, worth +2.2d cycle and
  −6.4 FPY points, consistent across all three resources
- **The parser's "Open date MOVED" warning fired on 913 rows and was a false
  alarm.** Both exports carry byte-identical Open dates; the committed data.json
  was exactly +1 day on all 913, 876 of them evening timestamps, i.e. built by
  an older UTC-shifting parse. The current parser is right and it self-cleared
  on the next push. The anchor's immutability claim holds

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

## Hover tips (`TIP` in index.html)
A tip is a **definition plus the one caveat that changes how the number is
read** — never the case for building the metric that way. Several had grown to
four and five sentences carrying design history (`resSplit` ended "The columns
are equal width on purpose…", `billTravel` "Tracked because it is the one line
a surveyor based in the market removes outright"), which is a source comment
wearing a tooltip's clothes; trimmed 2026-08-27, and the reasoning is already
written where it belongs. `billTravel` / `billCleanup` / `billRework` were
deleted outright when the rail lost those cells — each rule's own `why` in
`lib/billing.cjs` already says the same thing, and it prints under the chips
when the rule is selected. `test/surfaces.test.js` asserts every remaining
entry is referenced by a card, so a tip with no surface fails the build.

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
- **A1 — `/api/send-teams`, `/api/team-opener`, `/api/update-outlook` and
  `/api/update-resmodel` have no auth.** The last two lost their password
  2026-08-26 at Doug's ask, knowingly. Both take any POST and commit, and both
  are bounded by what they will accept: outlook to a two-letter state code, one
  of four flags and 280 characters; resmodel to a whitelist of fourteen numeric
  knobs, each range-checked, with anything unrecognised dropped. Neither file
  feeds a survey metric, and Reset undoes a bad model in a click.
  `api/update.js` and `api/update-billing.js` KEEP their password — those
  commit the dataset and the invoice history, which is data rather than an
  assumption. Anyone who can
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
