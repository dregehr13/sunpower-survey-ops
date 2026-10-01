# Site Survey QA

A semi-automatic review of every completed survey before it goes to Design.
Phase 1 (2026-10-01) is the engine; phase 2 is the QA page. Neither calls a
model yet.

```
node scripts/qa-run.mjs <report.pdf> [--json] [--coverage] [--sf-address "..."]
node scripts/build-qa-spec.cjs "<Site_Survey_Form_V.13.json>"      # Site Capture spec
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
  reports (`radicl-v2` has 1). Radicl changed its template between 2026-08-29
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
- **Review** — type the project ID (checked against Salesforce: address,
  status, resource), drop the report PDF and, for Site Capture, the photo
  export. Reads the PDF in the browser (pdf.js from cdnjs); nothing is uploaded.
  Findings by group (Missing · Template gaps · Look at · Passed), the key-photo
  check (each photo marked Readable / Not usable; "Not usable" becomes a hard
  miss), and the Salesforce hand-off: the six fields with a Copy button each,
  an editable summary, and an override reason when passing with an override.
- **Log** — every saved review, with the review number per account, a By
  account lens, search, Export (JSON/CSV) and Import. A report already reviewed
  is caught by its SHA-256.
- **Templates** — per template, the changes needed (what to add or fix, the
  Enphase and resurvey evidence, how many saved reviews hit it) with Copy change
  list.

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

- **Password is checked on the server**, against `QA_PASSWORD`, on every call.
  The page's prompt only decides whether to show the page; a static file cannot
  keep a secret. A wrong password is found on the first call and bounces the page
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
vercel env add QA_PASSWORD production   # the password your team types; also add for preview
git push                             # deploy
```

## Not built yet

Vision checks (legible breaker rating, readable label, tape visible,
blur/duplicates) through the Claude API,
Radicl's images folder (Drive), storing the reports themselves (a private bucket), and a real login. `evaluate` already marks
`verify` items for a model to take.
