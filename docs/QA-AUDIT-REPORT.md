# Site Survey QA: pre-launch audit (2026-10-01)

Scope: the QA review tool (`#qa`), its engine, its shared history and its two optional
lookups, audited against the 23 real reports in `~/Downloads/QA Test Reports/`. Reports
are named here by their test code and Salesforce project ID only.

## Recommendation: go, with conditions

The tool was not ready this morning. It failed good surveys, passed bad ones and told
people their password was wrong when the database hiccuped. Five of those results would
have shipped wrong to Salesforce on day one. All are fixed (14 commits, 276 tests passing,
up from 257) and re-run against every report.

Go live tomorrow on these conditions:

1. **Push tonight** and run the 10-minute smoke test below on production.
2. **Leave the Claude photo check off.** It has never run against the live API.
3. **Treat it as a second pair of eyes for two weeks, not the decision.** The coordinator
   still opens the report for anything flagged, and every "it was wrong" goes to Doug.
4. **On Radicl, look at the Layout Map and front-of-house photo yourself.** Radicl reports
   carry no photo GPS, so the tool cannot tell the wrong house. That is exactly why Design
   resurveyed RD-08 (5113BLAI): its site map was the neighbor's house. This is the one
   known miss that matters and no setting fixes it.

## Results, report by report

"Before" is the baseline in `INDEX.md`; "After" is with this audit's fixes and the real
Salesforce context (address, resource, survey type). Look = flagged items that need a
check or X call before the survey can be passed (enforced since this audit).

| Report | Project | Before | After | Right? | Why |
|---|---|---|---|---|---|
| SC-01 | 1261KUMA | Needs review | Needs review | Yes | One real shortfall: 1 of 5+ "path to opposite side of wall" photos |
| SC-02 | 2151ARCH | Needs review | Needs review | Yes | Six real photo-count shortfalls (attic MP3 9 of 10, vents, MSP location). Meter/main combo applied gap is real (combo = Yes) |
| SC-03 | 5703TRIP | Needs review | Needs review | Yes | Three real shortfalls; combo gap real |
| SC-04 | 1623WROB | Needs review | Needs review | Yes | Two real MSP-location shortfalls |
| SC-05 | 776NTAYL | Needs review | Needs review | Yes | Retrofit = Yes, so the existing-equipment gap applies (Required, no field: suggest override once the misses are settled) |
| SC-06 | 2639REES-1 | **Failed** | Needs review | Fixed | Was failed for "no photos" of battery fields. The 17 battery photos were in the report; the parser dropped them (P0-2) |
| SC-07 | 900STHOM | Needs review | Needs review | Yes | Six real shortfalls incl. the second panel SP1 |
| SC-08 | 4529GAGN | **Failed** | Needs review | Fixed | Same as SC-06: 66 battery photos dropped, 4 false hard misses |
| SC-09 | 305WDERB | Needs review | Needs review | Yes | The house-number photo really is missing from its field (it may be among the 20 exterior photos: a call) |
| SC-10 | 390NCORT | Needs review | Needs review | Yes | Three real shortfalls |
| SC-11 | (none printed) | Needs review | Needs review | Yes | Matched to 4706CHEM by address. Now also sees the generator the parser had misread (P1-9). One photo on another day, one >250 m from the rest: real |
| SC-12 | 2321LOPE | Needs review | Needs review | Yes | 5 planes surveyed, proposal shows 4 (warn); attic shortfalls real |
| RD-01 | 1411PIZA | Passed | Passed, 2 looks | Yes | Dead Front On/Off cannot be told apart in the report; the look makes someone open the photos |
| RD-02 | 21VADITZ | Passed | Passed, 3 looks | Yes | Now also asks about framing: no attic access ("Attic not accessible per HO") was silently skipped |
| RD-03 | 3219SCHR - Battery Only | **Failed** | Needs review | Fixed | Battery-only job failed for no pitch and no eave. Bus rating really is missing; existing-solar gaps apply |
| RD-04 | 2754BROT | Passed | Passed, 4 looks | Better | Pitch written as a bare "16" (16/12 or 16°?) now asks; no attic access now asks |
| RD-05 | 2822HATH | Passed | Passed, 2 looks | Yes | Three panels, all ratings recorded |
| RD-06 | 3081MURP | **Failed** | Passed, 3 looks | Fixed | Pitch left blank but photographed (gauge photos on p.18, p.20): now a look, as RD-09's "unable to access roof" already was |
| RD-07 | 2870ROGE | Passed | Passed, 2 looks | Yes | Photo export maps 166 of 166 photos, verified pixel for pixel |
| RD-08 | 5113BLAI | Failed (no pitch) | Failed | Right, for another reason | Main breaker "Unknown" and bus "No labels" on both outside boxes used to **pass**. Design resurveyed this job for a wrong-house site map, which the tool cannot see (condition 4) |
| RD-09 | 124VBRAB | Passed | Passed, 3 looks | Yes | "Unable to access roof / drone only" pitch asks for a look |
| RD-10 | Inspection report | Refused: "not a Site Capture or Radicl report" | Refused, named | Fixed | Now says it is a Radicl inspection report, not a site survey |
| RD-11 | 3472IKRO | **Refused** | Passed, 3 looks | Fixed | A Radicl Partial Survey (a go back): the same template under another title. Now reviewed and labelled; the resource alarm no longer fires because Salesforce still names the first surveyor |

**Is "Needs review" on 11 of 12 Site Capture reports noise?** Mostly, yes. Almost all of it
is the template's own photo minimums ("5+ photos", "10+ photos") missed by one to four.
Doug already decided these are warnings, and surveys that passed Design miss them
routinely. It is not wrong, but if every review says "Needs review" the phrase stops
meaning anything. See P2-1.

## Findings

Status: a commit hash means fixed, with a test that fails without the fix. Every fix was
re-run on all 23 reports.

### P0: would have shipped wrong results or lost work

| # | Finding | Evidence | Status |
|---|---|---|---|
| P0-1 | **A survey could be passed with its Required flagged items never looked at.** Every Radicl review carries two (Dead Front On/Off, because the report cuts both to "Dead Front…"), so every Radicl survey could be passed without opening a photo. The summary said nothing about them | RD-03 in the browser: Passed, Save enabled, 2 undecided | `cd5f715`: Passed and Passed with Override need every flagged item decided; Failed does not |
| P0-2 | **Site Capture battery photos were all dropped**, so each required one was a hard miss. Captions read "Proposed Walls / <field>" with no wall name | SC-06 (17 photos), SC-08 (66 photos) read Failed | `34b1fcb` |
| P0-3 | **Battery-only surveys were held to the roof**: no pitch, no eave = Failed | RD-03 (3219SCHR - Battery Only) | `fd9bd3f`: Salesforce survey type (or "Battery Only" in the name) skips roof, attic and plane checks |
| P0-4 | **A breaker or bus rating of "Unknown" passed** | RD-08: "Unknown", "No labels", "Box closed not able to open" | `fd9bd3f`: a rating needs a number |
| P0-5 | **A database error said "Wrong password"** and signed the person out. With the shared local password it saved reviews into that one browser instead, splitting the history | `qaSync`: any reply but 200/401 fell back to local | `654863e`: "History offline" banner, nothing saved, Save retries. Verified with 500 and 502 forced |

### P1: fixed before the team relies on it

| # | Finding | Evidence | Status |
|---|---|---|---|
| P1-1 | Blank pitch with pitch photos was a hard miss; "unable to access roof" with photos was only a look | RD-06, RD-08 vs RD-09 | `fd9bd3f` |
| P1-2 | A bare pitch number passed as x/12; "panels" in a pitch counted as a second structure | RD-04 "16"; RD-02 | `fd9bd3f` |
| P1-3 | Radicl "no attic access" silently skipped the framing check, the top Enphase hold category | RD-02, RD-04 | `fd9bd3f`: a look, with the surveyor's note |
| P1-4 | **The customer's address was stored** despite the promise: in `address_match`'s detail, and via the Radicl page header read as a photo caption into `newToSpec` | RD-01 (127 photos for 114) | `eba3068`, `fd9bd3f` |
| P1-5 | A one-digit house number fell through to the ZIP: two houses in one ZIP passed | Unit test | `eba3068` |
| P1-6 | Radicl Partial Survey reports (go backs, the thing most worth re-checking) were refused | RD-11 | `b4f87eb` |
| P1-7 | Radicl completeness (Layer A) never ran: the spec came from 2 reports, below the 3 needed. Rebuilt from 7; leave-one-out raises 1 warning across 7 | `qa/specs/radicl-v2.json` | `44d3c0f` |
| P1-8 | An early-September Radicl report (new contents page, August pages) was read against the wrong spec | RD-08 | `44d3c0f`: the pages decide. RD-08 now gets distinct On/Off checks |
| P1-9 | The Site Capture generator answer was misread on **every** report as the label's own tail, so a generator was never seen | All 12 SC; SC-11 has one | `de52030` |
| P1-10 | A survey saved as Failed with only Flagged misses had a summary that never said "go back" | SC-08 in the browser | `2b75ecb` |
| P1-11 | The resource alarm fired on every resurvey done by a different resource (Salesforce keeps the first one) | RD-11: "Salesforce lists Sales Rep" | `f6bfbd9` |
| P1-12 | A reload or closed tab lost a review in progress without asking | `page.js` | `3a66112` |
| P1-13 | An imported review id could carry a quote into History's `onclick`, where it would run for every teammate (needs a team password) | `qa-store.cjs` validate | `38a80da` |

### P1: open (cannot be fixed in code tonight)

| # | Finding | Recommendation |
|---|---|---|
| O-1 | **Wrong house on Radicl is undetectable.** No photo GPS in the report. RD-08's real Design resurvey was this | Condition 4. Next layer: compare the Layout Map / front photo with the Salesforce address by eye (a Radicl-only manual check), or the house-number reading behind the Claude toggle |
| O-2 | The stored record keeps the **report's file name**. If a vendor's download names carry the customer's name or address, that is stored | Check the names a real download produces tomorrow. If they do, keep only size and SHA-256 server-side |

### P2: polish after launch (all open)

| # | Finding | Recommendation |
|---|---|---|
| P2-1 | 11 of 12 SC reviews read "Needs review", mostly template photo minimums missed by 1–4 | Either accept it as the normal state, or treat "some but fewer than N+" as information and keep "none" as a miss |
| P2-2 | The same "Standing template gaps: …" line ends every Salesforce summary. It asks nothing of the coordinator | Keep it in the review and on Templates; drop it from the summary |
| P2-3 | Photo location: Census placed 10 of 12 SC addresses; distances 13–62 m, one at 119 m (asks for a look). The 2 unplaced also ask. So 3 of 12 ask for a look on day one | Pass to 150 m; fall back to the report's own address when Census has none |
| P2-4 | Example photos: the panel-label example's text is not legible, and the rafter-spacing example is too dark to read the tape. Both contradict their own captions. RD-05's own label photo was clearer than the example | Swap `qa/ref/label.jpg` and `framing-spacing.jpg` |
| P2-5 | With a Radicl photo export the tool knows On from Off (RD-07: 36 of 36 mapped exactly, On then Off then Reattached), yet still asks about both | Settle the two Dead Front looks from the export's file names |
| P2-6 | Site Capture's report prints no form version; v13 is assumed. A new form would show up only as unmatched blocks nobody sees | Banner when label-like unmatched blocks spike |
| P2-7 | Old-template Radicl reports count surveyor photo notes ("16ft height") as captions (RD-08: 287 for 279). Harmless to the checks | Cut notes under a caption |
| P2-8 | `QA_FIND_CAT` has no photo category for Dead Front Off, panel location, meter location or site map, so those rows show no thumbnails and never pull photos forward | Add categories |
| P2-9 | One photo marked not usable is a hard miss even when other photos in its category are fine | Make a photo mark a look on its check, not a miss of its own |
| P2-10 | `lib/qa.cjs` + `qa/page.js` + CSS load on every dashboard page: 62 KB gzipped, used only on `#qa` | Load on first visit to `#qa` |
| P2-11 | Most page tests match source text. This audit added a VM harness that runs `page.js` for real (`loadPage()` in `test/qa.test.js`) | Move the source-text tests onto it |
| P2-12 | 148 of SC-08's 416 photos carry no GPS; the location checks skip them silently | Say how many photos had no location |
| P2-13 | Softness: none of RD-05's 84 photos flagged (median 1133 against a threshold of 40). No noise, but never shown to catch a bad photo | Tune on the first real bad photos |

## Things checked and found sound

- **PDF page links**: `qa-check-pages.mjs` passes on all 22 readable reports. Re-checked after the fixes
- **Browser vs CLI**: SC-08 (132 pages) gives identical fields, photos, unmatched blocks and misses in the browser (pdf.js 4.4) and the CLI (4.10). Text parse 0.34 s, heap 79 MB
- **Photo exports**: SC-12's export cross-checks 61 of 61 folders (297 photos each side). RD-07's maps 166 of 166 photos, with every Dead Front photo pixel-identical to its report image
- **Phone and wide layouts**: no horizontal overflow at 375 px or 1600 px. Arrow keys step through the zoom
- **History**: save (server numbers it, stamps the reviewer, stores no address), duplicate-report banner, go back banner, edit with `edited_by`, soft delete. Concurrency, retry and number reuse are covered by the PGlite tests
- **Alarm-only checks**: promoted to Flagged on all 12 SC reports, they read the surveyor's answers correctly ("No photos deleted", "Proposal attached: Yes" on all 12)
- **Claude photo check**: off by default (`qaVision: false`), advice only, never saved. SDK 0.37 passes the model id through and supports base64 images. Rough cost, assuming Sonnet-class pricing and ~1,600 tokens per 1280 px image: about $0.15–0.25 a review at 30 photos. Requests are well under Vercel's 4.5 MB limit. No request timeout is set (SDK default 10 min, 2 retries)
- **Production today**: the page and API are deployed; `QA_USERS`, `QA_PASSWORD`, `QA_PASSWORD_NAME`, `DATABASE_URL` and `ANTHROPIC_API_KEY` are set in Production; `/api/qa-log` answers 401 without a password

## Go-live checklist

Before anyone opens it:

- [ ] Push the 14 audit commits (`git push`) and wait for the Vercel deploy (~30 s)
- [ ] `QA_USERS` holds one password per reviewer, `{"<password>":"<Name>"}`. Names print on every review
- [ ] The QA passwords are only set for **Production**, so preview deploys fall back to "this browser only". Fine, but test on the production URL
- [ ] Claude photo check stays **off** (Settings → Site Survey QA)
- [ ] No reviews from testing sit in the history. Delete any (they are soft-deleted; their numbers are never reused)

## 10-minute smoke test (production, after the push)

1. Open `/#qa` with your manager password. The bar shows "0 reviews" and Reviewer = your name, not a text box. **If you see "this browser only", stop: the database or passwords are not reaching the function.**
2. Upload RD-03 (battery-only). The project card says 3219SCHR - Battery Only, and no roof or attic row is missing.
3. Go to Verdict, choose Passed. Save says "Decide the 2 flagged items…". Decide them on the summary; Save enables.
4. Choose Failed instead and save. The summary opens "QA review 1 · Radicl", lists the go back, and the six copy buttons fill.
5. Open History: the review is there with its number. Open it in a second browser with a teammate's password: same review, same number.
6. Upload RD-03 again: the "already reviewed" banner and the go back banner both show. Start over.
7. Settings → Site Survey QA: change one check to Flagged, then Reset. Try with a teammate's password: the buttons are disabled.
8. Delete the test review from History. Reload: it is gone for both browsers.
9. Upload RD-10: it says it is a Radicl inspection report. Upload RD-11: it reads "Partial survey (a go back)".

## Rollback

The QA page is self-contained: it reads nothing other pages write, and its only server
state is the `qa_reviews` and `qa_settings` tables.

- **Wrong results**: revert the offending commit and push. Saved reviews keep the findings
  they were saved with
- **The whole tool**: `git revert` the QA commits, or remove the `qa` entry from the nav
  (`data-page="qa"` in `index.html`) and push. The tables stay in Neon untouched
- **Database trouble**: the page now says "History offline" and saves nothing, so nothing
  is lost or split. Reviews resume when the database answers

## What to tell the team

- **What it is**: a checklist that reads the report for you and points at what is missing.
  It never marks a survey complete and never writes to Salesforce; you copy the six fields
- **What it is not**: it cannot see the wrong house on a Radicl survey, cannot read a breaker
  rating off a photo, and does not know the contract. Open the photos it puts first
- **Words**: a miss our QA catches is a **go back**. A **resurvey** is only what Design calls
  out after us. "Not in template" is never the surveyor's fault
- **When it is wrong**: decide the row yourself (check or X); it is your call that is saved.
  Then send Doug the review ID and one line saying what it got wrong. That list is how the
  checks get fixed

## Could not verify

- **The live Claude photo check and the live geocode endpoint.** Both need a password and,
  for Claude, spend money; neither was called on production. The geocoder was run directly
  against the Census API for all 12 SC addresses
- **Production with a real password**: the smoke test above covers it
- **Printing / Export PDF** in a real popup-blocking browser, and the in-iframe PDF viewer
  jumping to `#page=N` in Safari (Chrome honours it)
- **A real bad photo** for the softness threshold: none of the reports has one
- **Whether a Radicl download's file name carries the customer's name** (O-2)
- **Two people saving the same account at the same instant on Neon**: proven on PGlite
  (same SQL), not on Neon's HTTP driver
