---
description: Turn work just done into an official SunPower memo (.docx) on the company template, numbered and registered
---

Produce an official memo from $ARGUMENTS, or — with no arguments — from the work
just completed in this conversation.

Per Daniel Fonseca (Yield Engineer, 2026-09-04): anything that is a DOCUMENT
rather than an email goes in memo format, even if it may never be published.
It is then ready if Doug changes his mind, and it carries the SunPower header.
So: reporting, analysis, a recommendation, a plan, a findings write-up. Not a
chat reply, not a Teams message, not a commit message.

STEP 1 — GATHER THE HEADER.
  To:           who it is addressed to. Ask if it is not obvious from context.
  CC:           optional. Chelsea Herrin is Doug's manager and the usual CC.
  Subject:      a noun phrase, not a sentence.
  Attachments:  "None" unless something is genuinely attached.
Author is Douglas Regehr and the Author File # is assigned automatically. Do
not invent one and do not ask Doug for it.

STEP 2 — WRITE THE MARKDOWN. Save it to the scratchpad as `<slug>.md`.
Front matter first, one `Key: value` per line, then a blank line, then the body:

    To: Jimmy Garrett, Ayleen Pedregon
    CC: Chelsea Herrin
    Subject: Site survey first pass yield
    Attachments: None

    ## Introduction
    One paragraph on why this memo exists and what it concludes.

    ## <Section>
    Body. **Bold** carries a figure inside a sentence.
    - bullets
    1. numbered steps

    ## Conclusion
    What follows from it. Optional, per the template.

Structure is the template's: Introduction, then sections, then an optional
Conclusion. Only `##` headings, `**bold**`, `-` bullets and `1.` numbering are
supported — that is the whole vocabulary of the template and enough for a memo.
Do not build tables; a memo that needs one usually wants the figure in a
sentence instead, and if it truly needs a table, say so rather than faking it.

WRITE IT IN DOUG'S VOICE, which is the house style already recorded in
CLAUDE.md: state the number and stop, no em dashes, no restating the case for a
decision already made, no summary paragraph at the end repeating the memo. An
official memo is read once by a VP; every sentence should carry a fact, a
recommendation, or a caveat that changes how a number is read.

STEP 3 — BUILD IT.
    node scripts/build-memo.cjs <path/to/memo.md>
It copies `memos/template.docx` and rewrites only the document body, so the
logo, headers, footers and page setup are untouched. It takes the next number
from `memos/register.json`, writes to `memos/YYYY-MM_DRR-4A_slug.docx`, and
appends to the register.

NUMBERING is `DRR-<number><revision>`, e.g. `DRR-4A`. The number is the memo and
the letter is its revision.
  - A new memo takes the next number and is always `A`.
  - A revision letter moves ONLY when a memo that was already PUBLISHED is
    reworked: `--revise 4` reads the register and issues `DRR-4B`. Redrafting
    before it goes out is still `A` — rebuild with `--number DRR-4A`, since
    nobody has read the other one.
  - `--dry` renders without claiming a number. Use it while iterating on wording.
Ask Doug whether a memo has already gone out before assuming a revision; if it
has not, do not burn a letter on it.

STEP 4 — CHECK IT, then hand it over.
Render page one and LOOK at it before saying it is done:
    qlmanage -t -s 1400 -o <dir> <the .docx>
Confirm the header block, the three rules under it, the logo and the footer.
Then send the .docx with SendUserFile.

Memos are gitignored — the repo deploys to a public URL. `register.json` is
committed, so the numbering survives even though the documents do not. Offer to
commit the register; do not commit the memo itself.
