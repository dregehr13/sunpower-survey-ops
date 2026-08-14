---
description: Full-app audit of every surface (functionality, logic, accuracy, organization, aesthetics, motion), then a staged cleanup
---

Do a full audit of the Survey Ops app, then clean it up.

If arguments were given ($ARGUMENTS), scope the audit to those surfaces only and skip
the rest. With no arguments, cover everything below.

SURFACES — cover every one:
  index.html      → Current, Performance, Trends, WIP, Resurveys, Map, Data, Settings
                    (the global filter bar, nav, chips, and modals count as surfaces too)
  compose/index.html → the email generator, incl. the password gate
  api/*.js        → morning-card, generate, update, upload-data, send-teams, team-opener
  lib/metrics.cjs, parse-sf.js, push.sh, scripts/*, geo/*
  docs/METRICS.md, README.md, CLAUDE.md

PHASE 1 — ASSESS. Do not edit anything yet.
Walk each page in the browser preview with real data (data.js). Click every control:
every filter, toggle, tab, expandable row, sort, hover tip, keyboard path. Note what
you actually observe, not what the code implies.

Assess along these axes and keep them separate in your notes:
  1. Functionality  — anything broken, dead, unreachable, or silently no-op. Controls
     that exist but change nothing. States that can't be exited. Empty/zero/one-row
     cases. Filters that don't reach a page. Console + network errors.
  2. Logic          — numbers that disagree with each other across pages, filters that
     should compose but don't, off-by-one in date windows, populations that differ
     between a headline and its own breakdown.
  3. Accuracy       — trace every displayed number back to lib/metrics.cjs. Flag any
     surface computing its own version of a shared definition. Cross-check against
     docs/METRICS.md and report anything displayed that the register doesn't cover.
  4. Organization   — page order, section order within a page, what's above the fold,
     naming consistency, duplicated sections, things on the wrong page.
  5. Aesthetics     — spacing/type/color consistency, alignment, table density, chart
     legibility, band and pill colors, dark-mode and narrow-window behavior.
  6. Motion & feel  — transitions, expand/collapse, page switches, loading and empty
     states, hover/focus affordances, anything janky, abrupt, or slow.
  7. Code health    — dead code, duplicated helpers, stale comments, unreferenced TIP
     entries, unused CSS, orphaned IDs.

Write the findings to docs/AUDIT.md as a table: surface | axis | what I observed |
severity (broken / wrong / rough / nit) | proposed fix | risk. Rank within each page.
Then stop and show me the list before changing anything.

If the audit starts thinning out — findings getting vaguer, pages getting a single
line each — say so and finish the remaining pages in a second pass rather than
padding the table.

PHASE 2 — CLEAN UP, in reviewable batches.
Work one batch at a time, smallest-risk first, and pause between batches:
  batch 1: broken + wrong (correctness)
  batch 2: organization + logic clarity
  batch 3: aesthetics, motion, feel
  batch 4: code health
Each batch: make the change, run `npm test`, verify in the browser preview, screenshot
anything visual, then report before moving on.

HARD RULES — violating any of these is a failed pass:
  - Metric definitions live ONLY in lib/metrics.cjs. Never reimplement one in a surface,
    never inline a band. If a definition genuinely needs to change, say so and wait —
    don't change it as part of cleanup.
  - Don't conflate wipAgeFrom() (cycle-time anchor, Spec 12744) with ssDaysOpen()
    (queue triage, rep grace day). Don't merge ssRatioForWeek() and ssRatioLive().
  - Resurveys and Map have NO time control of their own. The filter bar owns time.
    Both had one, both were removed deliberately. Don't add one back.
  - Filter chips only for state the bar hides. Never duplicate a visible control.
  - Cycle time anchors on Project Start, not agreement_signed. The 42 rows completing
    one day before project start are correct — don't "fix" them.
  - Don't infer around bad data in code. If rows are wrong, list them with SF links.
  - Don't refactor code that isn't part of a finding. No opportunistic rewrites.
  - Anything on the "come back to" list stays parked — raise it, don't build it.
  - snapshot test diffs are a signal you changed a definition. Never pass
    UPDATE_SNAPSHOT=1 without telling me exactly which values moved and why.

Update docs/METRICS.md if any displayed number changes, and CLAUDE.md if a design
decision changes. Ask before committing.
