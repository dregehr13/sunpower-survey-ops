# Audit prompt: Site Survey QA review tool

Paste the block below into a new Claude Code session (Opus) opened in this repo. Everything it
refers to is in the repo or in `~/Downloads/QA Test Reports/` (linked at `qa/samples/QA-Test-Reports`).

---

You are auditing the Site Survey QA review tool in this repo before it goes live tomorrow
(2026-10-02). Doug Regehr, the Site Survey Manager at SunPower, will use it with his team on real
surveys the same day, so this is a go/no-go review, not a style pass. Be thorough, be skeptical, and
test against real data. Do not assume anything in the docs is true: verify it.

## What the tool is

A semi-automatic review that runs BEFORE a survey is marked complete. A reviewer uploads a Radicl or
Site Capture (SunPower) survey report PDF; the tool parses it in the browser, checks it against the
template and Design's needs, separates template gaps from surveyor misses, lets the reviewer settle
what the checks could not (check/X calls, photo marks), and produces the six Salesforce QA fields
(status, date, source, reviewed by, report link, summary). Every review is logged in a shared Neon
Postgres history. Goal: Design receives surveys at near 100% first-pass yield. Rep surveys ended
2026-10-01, so only Radicl and SunPower surveyors are reviewed.

Vocabulary Doug cares about: a defect OUR QA catches is a **go back**; a **resurvey** is only what
Design calls out after we QA'd it. A **template gap** (the form has no field for something Design
needs) is never a surveyor miss. Radicl's invoices also use "Go Back" as a charge type; that is a
different thing.

Read first: `CLAUDE.md` (the "Site Survey QA" section), `docs/QA.md` (design notes, dated rounds),
and the memory files for this project. Then the code:

- `lib/qa.cjs` the engine: `detectTemplate`, `parseSiteCapture`, `parseRadicl`, `REQUIREMENTS` (Layer B),
  template completeness (Layer A), `evaluate`, `outcomeOf`, `summarize`, `keyPhotos`, photo-pack mapping
- `lib/qa-store.cjs` + `api/qa-log.js` the shared history and settings (Postgres), per-person passwords
- `api/qa-vision.js` + `lib/qa-vision.cjs` the optional Claude photo check; `api/qa-geocode.js` address lookup
- `qa/page.js`, `qa/page.css` the whole UI (about 1,700 lines); `qa/pdf-blocks.mjs` PDF to text blocks
- `qa/specs/*.json` the templates (Site Capture v13 exact; Radicl v1/v2 inferred from reference reports)
- `index.html` Settings page section `#qa-set-host`; `scripts/qa-run.mjs`, `scripts/qa-check-pages.mjs`
- `test/qa.test.js`, `test/qa-store.test.js`, `test/qa-vision.test.js` (run `npm test`, 256 tests)

## Test data

`~/Downloads/QA Test Reports/` has 23 real reports (customer data: never commit, upload, quote at
length, or paste them anywhere). `INDEX.md` there has a baseline run per file. 12 are Site Capture
(`SC-01..12`), 9 are Radicl full surveys (`RD-01..09`), and 2 are Radicl report types the tool does not
recognise (`RD-10` Inspection Report, `RD-11` Partial Survey Report, which is what a go back produces).
The baseline outcomes are NOT an answer key: nobody has confirmed they are right. Part of your job is to
decide, report by report, whether each outcome is correct, and why. Also available: a Site Capture photo
export `~/Downloads/marisela Andres lopez.zip` (matches SC-12), a Radicl photo export
`~/Downloads/Images-20261001T200108Z-1-001.zip`, the Site Survey Guide PDF, the Enphase hold report
(`Fw_ [EXT] Hold Job report.eml`) and the Site Capture form JSON (`Site_Survey_Form_V.13 (2).json`).

Run the engine on each report (`node scripts/qa-run.mjs <pdf> --json`) and drive the real UI in the
browser (start it with the `qa` entry in `.claude/launch.json`; password `sunpower`; load a report with
the page's own functions or the file picker). Use `scripts/qa-check-pages.mjs` for the PDF page links.

## What to audit (all of it)

1. **Correctness of the checks.** For every one of the 12 + 9 reports, open the PDF and confirm each
   finding is true: every miss is a real miss, every pass is a real pass, and nothing real is missed.
   Cover Layer A (template fields, photo minimums, per-plane and per-panel logic, dependsOn/applicability)
   and Layer B (every entry in `REQUIREMENTS`: its applies/custom logic, severity, evidence, and the
   `when` text). Look hard for false passes (they ship bad surveys to Design) and false misses (they
   waste the team's time and erode trust). Check conditional logic: existing solar, battery, generator,
   meter/main combo, attic access, retrofit, exterior MSP/combo panels, sub panels, multiple panels,
   multiple planes, outbuildings. Check the pitch parser, the plane count, the per-panel photo logic,
   and the cut Radicl captions ("Dead Front..." resolved by template order: the On-before-Off assumption
   is unverified by eye; verify it on real photos).
2. **Parsing robustness.** Page and field extraction, wrapped and multi-line answers, fields whose label
   and answer split across pages, duplicate labels, unmatched blocks, reports with no project ID
   (`SC-11`), very large reports (132 pages, 57 MB), timing and memory in the browser. Recognition: what
   happens with `RD-10` and `RD-11`, a scanned or wrong PDF, a non-report PDF, a re-exported or
   re-signed PDF, a Radicl v1 report, a Site Capture version other than v13? The messages shown must be
   clear and the tool must never crash or silently mislead. Decide the right behaviour for Radicl
   Partial Survey reports (they are go backs, the thing Doug most needs to QA again).
3. **PDF page links.** `scripts/qa-check-pages.mjs` passes, but extend it or test by hand: every "PDF p.N"
   link must open the page showing the answer or photos it describes, in the real UI's report viewer.
4. **Outcome and status logic.** `outcomeOf`, suggested status, hard vs warn vs verify vs gap vs
   standing gap vs alarm, "Passed" disabled with hard misses, Override rules, how decisions (check/X on
   rows, photo marks, row calls that mark evidence photos) change the findings and the summary, and
   whether the saved findings, counts and summary always match what was on screen. Try to break the
   invariants: toggling calls on and off, changing Settings mid-review, re-evaluating after a project
   change, marking and unmarking photos, a go back review of the same project.
5. **The Salesforce summary.** Wording, length, accuracy, what a coordinator must do with each line,
   the "go back" vocabulary, how template gaps and alarms read, and that nothing misleading or
   customer-identifying leaks into it. Compare the six copy buttons with the real Salesforce fields.
6. **Photos.** Key photo selection per category and per plane/panel, cutting images from the PDF vs the
   original-resolution zip, zip-to-report mapping for both vendors (Radicl flat `Section_Field_N.jpg`,
   Site Capture folder per field), softness and size heuristics (`QA_SOFT_BELOW` was never tuned on real
   bad photos), the zoom with the example photo (`qa/ref/`: confirm each example is genuinely a good
   standard and the descriptions are accurate to the guide), photo marks and how they are saved, listed
   and exported.
7. **The shared history and Settings.** Postgres schema creation on first use, server-assigned review
   numbers (race conditions, duplicates, deletes), soft delete, edits and audit fields, passwords
   (`QA_USERS`, `QA_PASSWORD`, manager-only settings), constant-time compare, what the server stores
   (the customer's address must not be stored; the report and photos must not be stored), input
   validation on every endpoint, error and offline fallbacks (the localStorage mode), the History table,
   filters, CSV export, and the PDF export (print window, popup blockers, thumbnails only while open).
   Settings: Required / Flagged / Alarm only / Off per check, the zeroHard nuance, reset, defaults.
8. **The optional Claude photo check and address lookup.** Never run live. Review the request and
   parsing code, the model id, the installed `@anthropic-ai/sdk` version (^0.37.0: does it handle this
   call and model?), cost per review (up to 30 photos), failure modes, Vercel Hobby limits (function
   duration, 4.5 MB body), and that it is truly off by default and advisory only. Same for the Census
   geocoder (address quality, 100/300 m thresholds, Radicl has no photo GPS, privacy). Try both end to
   end if you can (you may need to ask Doug for `ANTHROPIC_API_KEY`; do not request secrets in chat).
9. **UI, design, accessibility, copy.** The two steps (Photo review, Verdict), the one-field start, the project card and pencil,
   Expected surveys, summary rows, zoom, Verdict, History, Settings, empty and error states, loading
   states, keyboard use (arrow keys in the zoom, focus, Tab order), screen widths from 375 px to 1600 px
   (the flow was mostly checked in a narrow pane), dark mode if the app has it, long names and addresses,
   overflow and clipping, layout shift when clicking (Doug reports shifting controls as "weird"), and
   consistency with the rest of the dashboard (tokens, label scale, hover rules in `CLAUDE.md`). Copy:
   professional, plain, no filler or AI-sounding phrasing, consistent terms (go back vs resurvey,
   Required/Flagged/Alarm only, "not in template" vs "not on this report"), no instruction-to-developer
   text in the UI.
10. **Code quality and coherence.** Dead code (old report/summary/status steps, removed toggles), duplicate
    helpers, names that no longer match behaviour, stale comments, `docs/QA.md` and `CLAUDE.md` that no
    longer match the code, test gaps (what real failure would the 256 tests NOT catch?), tests that assert
    source text instead of behaviour, security of the new endpoints, bundle and load cost of `qa/page.js`
    on every dashboard page, and anything in the QA code that could break the rest of the dashboard.
11. **Go-live readiness.** The exact list of things that must be true in Vercel before a real user opens
    it: env vars (`QA_PASSWORD`, `QA_USERS`, `QA_PASSWORD_NAME`, `DATABASE_URL`/`POSTGRES_URL`,
    `ANTHROPIC_API_KEY`), the Neon database, first-use schema creation, what happens on a cold start,
    the first-ever review, two people reviewing at once, a bad password, no database. A smoke-test
    script someone can run in 10 minutes after deploy. A rollback plan. What to tell the team (what the
    tool is and is not, what to do when it is wrong, how to report a bad finding).

## Known uncertainties (start here, but do not stop here)

- Radicl v2 spec is inferred from reference reports; the old rule "skip completeness below 3 reports"
  now has 9 to build from. Regenerate or confirm (`scripts/build-qa-radicl-spec.mjs`).
- Most Site Capture reviews come out "Needs review" and most Radicl "Passed" with 2-3 `verify` items. Is the
  default status useful, or is it noise? Are 4 standing template gaps on every Site Capture review (3 on
  Radicl) helpful in the review or only on the Templates tab?
- Alarm-only checks never appear unless they fail; confirm each still fires correctly when it should.
- The photo-location check was only hand-tested (33 m on one report, thresholds guessed). Run it over every
  Site Capture report with a real Census lookup and see the distances.
- `needsLook` photos, evidence thumbnails and the row-call/photo-mark sync were designed in one session and
  verified on two reports.
- Page layout was verified at one desktop width and in a narrow pane only.
- `QA_FIND_CAT` maps check ids to photo categories; confirm it is complete and right.
- Radicl `Partial Survey` and `Inspection` reports are rejected as "not a survey report".

## How to work

- Read, run, and test before you edit. Reproduce each problem on a real report and say which one.
- Rank everything: **P0** blocks going live tomorrow (wrong results that ship bad surveys, data loss, security,
  crashes), **P1** fix before the team relies on it, **P2** polish after launch. Be willing to say "no-go".
- Fix P0 and P1 items yourself in small, separate, well-described commits, each with a test that fails
  without the fix. Do not refactor beyond the finding. Do not rewrite working code to taste.
- Never commit customer data (`qa/samples/` is gitignored; keep it that way). Ask Doug before pushing; he pushes
  when he says so. Do not add AI attribution beyond what the repo already does.
- Match the codebase's idiom and comment density. Keep the QA code's one rule about uploads: reports are never
  uploaded or stored; only the opt-in Claude check sends a downsized photo, and the address lookup sends
  a street address.
- Doug values: nothing that shifts under the cursor, plain accurate wording, explaining the reason before
  defending a choice, and verifying UI changes in the browser rather than reading the diff.

## Deliverable

1. `docs/QA-AUDIT-REPORT.md`: an executive summary with a clear **go / go with conditions / no-go**
   recommendation; a per-report table (all 21 recognised reports plus the 2 unrecognised ones: expected
   outcome, what the tool said, correct or not, why); findings ranked P0/P1/P2, each with evidence (file:line,
   report, steps to reproduce), the fix or recommendation, and its status (fixed in commit X / open); the
   go-live checklist and smoke test; and a short list of things you could not verify and why.
2. The fixes, committed locally (not pushed), `npm test` green.
3. A final message to Doug in plain language: can he go live tomorrow, what must he do tonight, and what to
   watch on day one.
