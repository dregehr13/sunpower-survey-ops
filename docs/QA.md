# Site Survey QA

A semi-automatic review of every completed survey before it goes to Design.
Phase 1 (2026-10-01) is the engine; phase 2 is the QA page. Neither calls a
model yet.

```
node scripts/qa-run.mjs <report.pdf> [--json] [--coverage] [--sf-address "..."]
node scripts/build-qa-spec.cjs "<Site_Survey_Form_V.14.json>"      # Site Capture spec (id from the form's projectKey)
node scripts/build-qa-radicl-spec.mjs <report.pdf>...              # Radicl specs, per version
```

Reports hold customer names and photos of homes. Run on your own machine; no
report is committed (the tests build synthetic pages, the specs are the blank
template). `qa/samples/` is gitignored for local reports.

## Pipeline

`qa/pdf-blocks.mjs` (pdf.js) → positioned text blocks → `lib/qa.cjs`:
`detectTemplate` → `parseSiteCapture` / `parseRadicl` → one normalized survey →
`evaluate` → `summarize`. Only `pdf-blocks.mjs` touches a PDF, so the engine
runs on plain data and the extractor can move into the browser.

## Standards

- **The template is the standard; the Site Survey Guide is the floor.** Every
  field the template requires is a requirement (Layer A); the guide, Enphase's
  holds and our resurvey categories add design needs (Layer B,
  `REQUIREMENTS`). Each names what satisfies it per template.
- **Layer A, Site Capture** is exact: the form JSON gives each field's type,
  whether it is required and what answer makes it appear (`dependsOn`). The
  report prints every field, hidden or not, so "applies" is computed from the
  surveyor's own answers.
- **Layer A, Radicl is inferred.** Radicl publishes no template; the spec is what
  reference surveys contain, per template version, and is skipped below 3
  reports (`radicl-v1` has 4, `radicl-v2` 7 since the 2026-10-01 audit). Radicl changed its template between 2026-08-29
  and 2026-09-30 ("Inside Breaker Box 1: Dead Front On" became "Breaker Box /
  Electrical Panel #1 — Dead Front…"); refs are canonical across both.
- **Miss vs gap.** A requirement with no field in a template is a TEMPLATE GAP,
  never a surveyor miss, so a vendor's miss rate cannot carry something its form
  could not capture. A *standing* gap is true of every survey on the template
  (reported once, does not change the outcome); an *applied* gap bites because
  this survey's answers make the item apply (existing solar = Yes, no field for
  it) and suggests Passed with Override. Doug's call: flag the gap, pass with
  override if necessary.
- **Severity** is `hard` (stops a handoff) or `warn`; both are Doug's to tune in
  the registry. Outcomes: any hard miss → Failed - Gaps Found; warnings only →
  Needs review (internal, never sent as a picklist value); applied gap →
  Passed with Override; else Passed.

## Site Capture V.14 (2026-10-02)

V.14 is the current Site Capture form and the QA baseline; V.13 reports are still read
while it phases out. V.14 is V.13 plus the fields the QA kept reporting as missing from the
template: roof pitch per plane (in the roof group, so not attic-dependent), one overhang per
house, main breaker rating per panel and per combo meter, service voltage and phase, the
combo's open-enclosure photo, generator make/model/kW, and existing modules and inverters.
The retrofit question kept its key (`is_this_survey_for_a_retr_c1`) and is relabelled
"Existing System Information". Things not to undo:
- **The report prints no form version**, so `detectTemplate` reads a V.14-only label
  (`SC_FINGERPRINTS`, the service-voltage field); without it the report is V.13
- **`scFrom` on a requirement** names the first form with the field. On an older form
  `srcOf()` returns nothing, so the item is a template gap there, exactly as before
- **`tplPhotos`**: the overhang, generator and existing-system rules read the answer and
  leave the field's own photo requirement to Layer A, so a value with no photo still misses
- V.14's checklist and Templates view list no template gaps; a test pins that

## What the data showed (10 reports)

- Both templates lack: roof **overhang**, **service voltage/phase**, the
  meter/main combo **main enclosure** photo, **existing module/inverter**
  make/model/count. Site Capture also lacks a numeric **main breaker rating**,
  an attic-independent **roof pitch** (tilt is only collected inside the attic
  group) and an "existing solar" question. Radicl has pitch, eave/soffit photo,
  main-breaker and bus numbers, existing-solar and generator questions.
- Surveys that passed Design routinely miss the template's own photo minimums
  ("10+ attic photos" runs 3–11), so those shortfalls are warnings only.
- Radicl's report cuts photo captions at ~45 characters; in the Sep 2026
  template that reduces "Dead Front On/Off" to "Dead Front…", so on and off
  cannot be told apart from the report. Ask Radicl for shorter prefixes or full
  captions.
- Radicl pitch is free text ("6/12", "30.07 degree pitch", "5 in 12 for house.
  Panels are going on the shop"); `pitchRise` reads the common forms and sends
  the rest to a human.

## Photo pack (the no-API workaround)

Site Capture's export zip is `<section>/<field label cut to 70 chars>[-k]/<n>.jpg`
with EXIF stripped, 1536×2048 (the PDF embeds 450×600). `indexPhotoPack` reads
the field from the folder and the instance from `-k` (none = first); the export
numbers a repeated folder name whether the repeat is a second plane or a
different field with the same 70-character start, so `crossCheckPack` falls back
to comparing the family total. Both sample packs reconcile exactly with their
PDFs (61/61 and 42/42 folders). The PDF stays the source for counts, geotags and
timestamps; the pack is only for pixels. Radicl's Drive folder is not yet seen.

## The QA page (`#qa`, nav: Ops → QA)

`qa/page.js` + `qa/page.css`, loaded by index.html; it inherits the sidebar,
tokens and shared classes (`.sec`, `.srail`, `.fbar`, `.tbl`, `.pill`) so it reads
as part of the app. Three views:
- **Review** — one upload field, then a project card and two steps:
  **Photo Review → Verdict and Summary** (see the dated rounds
  below). Reads the PDF in the browser (pdf.js from cdnjs); nothing is
  uploaded
- **History** (was Log) — every saved review, the review number per account, a By account
  lens, search, Export (JSON/CSV) and Import. A report already reviewed (by
  anyone) is caught by its SHA-256
- **Templates** — per template, the changes needed and how many saved reviews
  hit each, with Copy change list

Things not to undo:
- **Password, not login** (Doug's call): the same `prompt()` and `ops_auth`
  session key as /compose. Same limits as CLAUDE.md X5 — a plaintext constant in
  a static file is a speed bump, not access control
- **The log is shared**: Postgres (Neon, through the Vercel Marketplace), behind
  `api/qa-log.js` and `lib/qa-store.cjs`. Every viewer sees one history, the
  review number per account is the same for everyone, and the "Report Link" field
  holds a record URL that opens for any teammate. Without the server (a local
  copy) or without the database provisioned, the page falls back to this
  browser's localStorage and says so in the bar. See *The shared log* below
- **Photos come from the export when there is one** (original resolution,
  labelled "Original"), otherwise they are cut out of the report PDF (labelled
  "From the report"; 450x600 for Site Capture). A Site Capture folder name that
  collides across fields (the second equipment panel) falls back to the report
- **pdf.js reads page images one document per page, three at a time.** A second
  page asked of the same document can hang in the browser. A Radicl report's
  photos take ~20s this way; its images folder will be faster

## The shared log

One table, `qa_reviews`, created by the endpoint on first use (every statement
is `IF NOT EXISTS`, so there is no migration step).

```
browser ──x-qa-password──▶ /api/qa-log ──▶ lib/qa-store.cjs ──▶ Neon Postgres
```

- **Each person has their own password, and it names them.** `QA_USERS` (env,
  never the repo) is a JSON object of `{ "<password>": "<name>" }`; `QA_PASSWORD`
  is the manager's own (named by `QA_PASSWORD_NAME`). The server checks the
  password on every call, in constant time, and stamps the review's Reviewer and a
  delete's `deleted_by` with the password's owner, ignoring whatever the page
  sent. The page shows that name read-only. The page's own prompt only decides
  whether to show the page; a static file cannot keep a secret. A wrong password
  is found on the first call and bounces the page
- **Adding or removing a person** is an edit to `QA_USERS` in Vercel plus a
  redeploy; no code changes
- **The server numbers reviews.** The count of the account's reviews so far
  (deleted ones included, so an id is never reused) is computed inside the
  INSERT; two saves in the same instant collide on the primary key and one
  retries. No lock, no transaction, which is also what lets it run over Neon's
  HTTP driver. The number is written into the summary's opening "QA review N"
- **Delete is soft** (`deleted_at`, `deleted_by`) and leaves the list for everyone
- **What is stored**: the review, project ID, surveyor and reviewer, and the
  report's name, size and SHA-256. **What is not**: the PDF, its photos, the
  customer's name or address (the Salesforce task id finds the account; the
  address is dropped server-side even if sent)
- **A browser's old local log** can be moved up (Log → "Move to the shared log"),
  keeping ids; a clash with a different report is renumbered, never lost
- The test suite runs the production SQL against PGlite (Postgres in WASM), so
  `test/qa-store.test.js` covers numbering, the retry, import and the endpoint
  with no database to set up. `node scripts/qa-dev-server.mjs` serves the whole
  dashboard with the shared log on a local PGlite, for trying it before Neon exists

### Turning it on

```bash
vercel integration add neon          # provisions the database; injects DATABASE_URL
vercel env add QA_USERS production      # {"<password>":"<name>", ...}, one per person
git push                             # deploy
```

### The review flow (2026-10-01, Doug's list)
Things not to undo:
- **Findings default to All** (first chip). Rows are two columns, check and what
  we found; no "why it matters" and no template-fix line (both were removed on
  purpose: the check says what it says, and the Templates view holds the fixes).
  The chip is **Not in template**, not "template gaps": it means the template has
  no field for it, so no survey on it can have it
- **Photos show a few per check, on purpose**: the ones that decide the checks (a
  report carries 250+). "Showing 7 of 249" says so, and "+ N more" on a check
  opens the rest. Quality is measured on each photo cut from the report: size
  (long edge under `QA_LOW_RES`, 1000px) and sharpness (Laplacian variance under
  `QA_SOFT_BELOW`, 40). When most are small or several are soft and there is no
  export, the page recommends adding it. The sharpness threshold was set from
  real photos and artificially blurred copies; refine it on real bad photos
- **The report opens in front of you** (`qaViewPdf`, blob URL in an iframe at the
  page that raised a question). The PDF is not stored, so it is available only
  during the review, not from a saved record
- **Project ID is required to save**, here and on the server
- **The Radicl "Drive link" is a reference only**: it is saved with the review and
  opens the folder. Nothing in the app can read a Drive folder (that needs Google
  API credentials and a folder shared with them), so Radicl photos still come
  from the report, which carries them at 810x1080 or better
- **Two functions once shared a name** (`qaRefresh`, for the status buttons and the
  Log's Refresh button), so the later one silently replaced the first and the
  status buttons did nothing. A test now fails on any duplicate top-level function
  name in the page

## Not built yet

Storing the reports themselves (a private bucket), and a real login. The Claude
photo check is built but has never run against the live API (see below).

## 2026-10-01 round
- Tabs are Review / Templates / History. The Reviewer is read-only once a
  password names them; the bar shows the total review count, not "shared log".
- **Expected surveys** lists Radicl and SunPower surveys booked today or earlier
  and still open in Salesforce (`isOpenQueue` + `wipSchedDate`, reps excluded).
  Picking one fills the project ID and the survey type.
- **Start over** discards an in-progress review (asks first if unsaved).
- Templates shows one template at a time (SunPower / Radicl). The pre-Sept Radicl
  template is gone from the page; the engine still reads old Radicl reports.
- The import-a-log feature is gone from the page (the endpoint still accepts it).
- Project IDs may carry Salesforce's suffix (`350VPITT - Battery Only`) or a dot.
- Claude API layer, when built: a Settings toggle, off by default.
- **No survey-type toggle on intake, no Drive link** (2026-10-01). The report says
  whether it is Site Capture or Radicl. The checklist before a report loads keeps a
  view toggle only. One optional **Photos** zip works for both: Site Capture's is a
  folder per field, Radicl's is one flat folder (`Section_Field_N.jpg`, N from 0),
  told apart by its paths. A Radicl report cuts "Dead Front On/Off" to "Dead Front…";
  the zip's full names resolve it by template order (On, then Off) when the counts add
  up, and are not used otherwise. Checked against a real report: 166 of 166 photos.
- **Saved reviews are editable** (2026-10-01). While the review is open the status,
  override, summary, findings and photo marks stay live and the button reads
  *Save changes* (enabled only when something differs from what was saved). From
  History, *Edit* changes the status, its reason and the summary. `PUT
  /api/qa-log?id=` takes `{changes}`; project, number, reviewer and report are
  fixed, and `edited_by` / `edited_at` record who changed it. **Start over** sits in
  the review's strip (and as a link on the intake card before a report is loaded).

### 2026-10-01 — three steps, example photos, marked photos
- **The review is three steps**: Summary of findings (flagged items get ✓ / ✕
  inline; a Pass shows up to three thumbnails of the photos it was judged from),
  Photo review, Verdict (summary left, status right, the suggested status gets a
  coloured border instead of "Looks like…").
- **Photo review lists every key photo**, a row per category that scrolls
  sideways. Photos that need a call come first with a yellow border until marked
  ✓ (green) or ✕ (red): one whose category has an unresolved flagged check
  (`QA_FIND_CAT` maps check id → category), or that looks soft. Nobody has to
  mark the rest.
- **Example photos** (`qa/ref/`, `QA_REFS` in page.js) sit beside the survey's
  photo in the zoom, with what it should show and why Design needs it. Breaker,
  label, meter and rafter size come from the Site Survey Guide; pitch and eave
  come from a past Radicl report because the guide has none. Swap a file in
  `qa/ref/` to change an example.
- **A saved review records which photos were marked** (`photos.marks`: category,
  panel, photo number, good or not usable). Everything else is "not individually
  reviewed", and the review says so. **Export PDF** (Verdict step and History)
  opens a print page; thumbnails appear only while the review is open, since no
  photo is stored.

### 2026-10-01 — Claude photo check (QA → Settings)
- **Off by default**, a checkbox in Settings stored in `S.qaVision`. When on, after a
  review's photos load, each key photo (up to 30, three at a time) is shrunk to
  1280px in the browser and sent to `/api/qa-vision`, which asks Claude
  (`claude-sonnet-5-5`, `lib/qa-vision.cjs`) whether the photo can be read for what its
  category needs. The password is checked server-side like `/api/qa-log`; it needs
  `ANTHROPIC_API_KEY` (already used by `api/generate.js`).
- **Advice only.** A photo Claude doubts gets the yellow "needs your call" border,
  moves to the front of its row, and shows Claude's sentence on the card and in the
  zoom. Claude never marks a photo, settles a check or changes a status; nothing it
  says is saved. This is the one place a photo leaves the browser, and nothing
  keeps it.
- Needs the team server (it does not run against a browser-only log) and says so on the
  Photo review step when it cannot run.

### Terms (Doug, 2026-10-01)
A defect our own QA catches is a **go back**. A **resurvey** is only what Design calls
out after we have already QA'd the survey. Copy in the QA app says go back
(the Salesforce summary reads "Needs go back / follow-up:"); Quality and the metrics
keep "resurvey" because they measure Design's callouts. Radicl's invoices also use
"Go Back" as a charge type; that is the vendor's term for a return visit, not ours.

### 2026-10-01 — summary calls, fixed zoom, verdict
- **Every finding that is not "not in template" takes a ✓ / ✕ call** on the summary
  page, with a "PDF p.N" link where the report prints its answer or photos
  (`pageOf` in `lib/qa.cjs`). ✓ turns a miss into a pass; ✕ turns a pass into a
  miss at the check's own weight. A row whose check rests on photos also shows what the
  photo marks say (✕ if any photo in the category is marked not usable, ✓ if marked
  good), and ✓ on the row marks the thumbnails beside it good. ✕ on a row does not mark
  photos: the check is judged, not the photo. Chips follow the check's original
  result, so a click never moves a row.
- The zoom is two stages of one fixed size, so switching examples never moves
  anything. Marks bottom left, example text bottom right.
- **Design closeout call** is no longer a check (and the template field is not
  held against the survey).
- The status buttons update in place; the old rebuild on every click lost the caret
  and made them flicker. Save sits below both columns so Override cannot move it.
- **Why the SunPower and Radicl checklists differ:** the design needs are the same
  list. The three extras on SunPower (photos deleted before sync, proposal attached,
  photos taken on site on the survey date) exist because only Site Capture's report
  records those answers.

### 2026-10-01 — QA Settings tab, Expected surveys
- **Settings → Site Survey QA** (the app's Settings page; it was briefly a QA tab) holds what each check requires: **Required** (stops a
  handoff, `hard`), **Flagged** (asks for a look, `warn`) or **Off**, per check, over the
  shipped defaults. Only changes are stored (`qa_settings` table, key `checks`), shared by
  the whole team, and only the manager password (`QA_PASSWORD`) can change them
  (`PUT /api/qa-log?settings=1`, 403 otherwise). `OpsQA.evaluate` reads `ctx.checks`; an
  open review re-evaluates when a setting changes. The template-field layer (every field
  the template requires) is not per-check yet. The Claude photo check toggle moved here
  from the dashboard Settings page.
- The review checklist lists the other survey type's extras too, tagged **not on this
  report**, so SunPower and Radicl read as one list.
- "Likely to review" is now **Expected surveys**.

### 2026-10-01 — project card, summary row layout
- Once a report is loaded the Project is a card (ID, customer, address, sales rep and
  office, status, resource, Salesforce link). The ID is text with a pencil; it is a field
  only while changing it, or while nothing matches (amber). Locked once saved.
- Summary rows read: dot · check + **PDF p.N** · what was found · photos · ✓/✕. "What was
  found" is the report's own answer when it is short (bus rating, framing, service
  entrance) or the number of photos for a photo check (`found` in `lib/qa.cjs`).

### Where the Layer B checks came from
`REQUIREMENTS` (lib/qa.cjs) is a synthesis, not a single document. Each carries its
evidence: the **Enphase hold report** Doug forwarded 2026-10-01 (counts such as "Missing
top view image of new construction: 2", "Different address available: 1" are the
`enphase` / `enphaseN` fields), **our resurvey categories** read from `resurvey_details`
(`rs: ['roofMeas','where','redo']`), and the **Site Survey Guide** (photos Design says it
needs). The three Site Capture-only checks (photos deleted, proposal attached, plane
count) come from questions in Site Capture's own form (section 10, Office Feedback, and
"How many Mounting Planes does the Proposal show?"). *Report is from the resource
Salesforce lists* and *Photos taken on site, on the survey date* are integrity checks
added with no hold or guide behind them.

### 2026-10-01 — alarm-only checks, photo location, go back reviews
- **Alarm only** is a fourth weight: the check runs but stays out of the checklist, the
  summary, the report PDF and the counts unless it fails. Default for *Report is from the
  resource Salesforce lists*, *No photos deleted before sync* and *Proposal attached*.
  A setting can promote any of them back to Flagged or Required.
- **Photos taken at the Salesforce address** (Required): the median GPS of the report's
  photos against the project's address, looked up with the US Census geocoder through
  `/api/qa-geocode` (the street address only). Within 100 m passes, 100-300 m asks for a
  look, beyond that is a miss. Radicl's report has no photo locations, so it does not
  apply there. It catches the wrong block, not the wrong house on the same street; reading
  the house number from the front-of-house photo would be the next layer, behind the
  Claude photo toggle.
- **Go back reviews:** when the project already has a review, the summary opens with what
  the last one found and which of those misses this report fixed, matched by check and
  title.
- A finding's page is where the answer is printed, not where its label is: a field whose
  label sits at the foot of one page and its answer at the head of the next now links the
  second page.

### Checking the page links (2026-10-01)
`node scripts/qa-check-pages.mjs <report.pdf>...` re-checks the "PDF p.N" links on real
reports: the numbering matches the report's own "Page N of M" footer, every answer and photo
caption is on the page it was given, and every finding's page holds one of its fields. Run
on two Site Capture and three Radicl reports: all ok. A unit test pins the case that was
wrong (label at the foot of one page, answer on the next). Run it on any report whose
links look off.

### Conditional checks, and an audit of the weights (2026-10-01)
- Checks that only apply sometimes carry a `when` (existing modules and interconnection:
  only when solar already exists; battery: battery surveys; generator; meter/main combo;
  attic checks on Radicl: when the attic is accessible). They were already silent
  when they did not apply; the checklist and Settings now say so.
- Attic photos is Flagged but becomes Required when there are none at all (`zeroHard`).
  Choosing a weight in Settings replaces that rule with the one you chose.
- A `verify` result on a Required check (a pitch written as prose) asks for a look and does
  not block a pass.
- Template gaps true of every survey (4 on Site Capture, 3 on Radicl) are listed on every
  review; they are the Templates tab's business more than the review's.

### 2026-10-01 — "What we review" moved to the Templates tab
The Review tab no longer shows the checklist. **Templates** now holds it, per template
(SunPower / Radicl): every check the review runs, its weight (Required / Flagged, from
Settings), when it applies, and whether the template can capture it. Checks the template
lacks are tagged **Add to template** with the fix, followed by template improvements that are
not one of the checks. Checks only the other survey type's report can answer show
**not on this report**. Copy change list / Copy table work on it.

### 2026-10-01 — pre-launch audit
Full findings in `docs/QA-AUDIT-REPORT.md`. Things not to undo:
- **Battery-only surveys** (Salesforce survey type, or "Battery Only" in the project
  name) skip the roof, attic and plane checks, and Site Capture's roof and attic
  sections in Layer A. The page passes `sfSurveyType` in the context
- **Site Capture battery captions name no instance** ("Proposed Walls / <field>");
  they go to the group's only instance, or count for every instance when there are
  several. Read as unmatched, they made every required battery photo a hard miss
- **A Radicl blank pitch with gauge photos asks for a look**, as an unreadable one
  does; a bare number ("16") asks for its unit. A breaker or bus rating with no
  number in it ("Unknown", "No labels") is not recorded
- **Radicl no attic access asks for a look** with the surveyor's note, instead of
  silently skipping the framing check
- **Radicl partial surveys (go backs) are reviewed**; an inspection report is named
  and refused. A report whose pages use the August layout under the new contents page
  is read as the August template (the pages decide)
- **A pass needs every flagged item decided.** Failed can be saved without
- **A server error is "History offline"**, never a wrong password and never a silent
  switch to the browser-only log. Only 404 (no API) and 503 (not set up) mean local
- No finding's detail carries an address; the Radicl page header is cut on height

### 2026-10-02 — two steps: Photo review, Verdict
- **Summary of findings and Photo review are one step, "Photo review".** Each line: caret · dot ·
  the check, very simply, with its PDF link · what was found or what is missing · thumbnails of its
  photos · the check/X call. A line that has photos opens onto them, large, each with its own
  check/X (the cards the old photo step had); **Expand all** opens every such line and, pressed
  again, shuts them. Calls and marks redraw the lines in place, so open photos and scroll stay put.
- **One photo is enough.** Every photo requirement is a minimum of 1, template field or check
  (the template's "5+", "8+", "10+" no longer produce a miss; none at all still does). The one
  exception is Radicl v2's Dead Front On/Off pair, which stays at 2 because the report cuts both
  captions to "Dead Front…" and one photo cannot show both.
- **Titles are plain.** Check titles are short ("Dead front on", "Rafter size and spacing"); the
  template's long photo labels become "Mounting planes", "Each roof obstruction", "MSP location"
  (sub panels: "Sub panel location") and "Roof condition" (`photoTitle` in `lib/qa.cjs`). The
  go back comparison matches Layer B checks by id, so reviews saved under the old titles still match.

### 2026-10-02 — several reports at once (was: find the report in Downloads)
The first version read the Downloads folder through the File System Access API. **Chrome
refuses Downloads itself as a "system folder"**, so it only worked if every reviewer moved
Chrome's download location into a subfolder — too much to ask of the team. Removed the same
day. What replaced it:
- Before a review, the report drop takes **many files at once** (select all of the day's
  reports in the file chooser, or drag them in). Each PDF is matched to an Expected survey
  with `OpsQA.namesProject` — file name first (project ID, or street number + first street
  word of the Salesforce address), else the text of its **first page only** (`pdfToBlocks`
  `maxPages`). A match must be unique; an ambiguous one is left unmatched. A photo zip is
  matched by file name only
- A matched card reads **Report ready**, and clicking it opens that report (and zip) through
  the normal `qaOpenReport` path. A line under the drop says how many matched and names the
  ones that did not
- One file still behaves exactly as before. Held in memory for the visit; nothing uploaded
