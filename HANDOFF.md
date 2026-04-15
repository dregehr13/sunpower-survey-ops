# Survey Ops — Claude Code Handoff

## What this is
An internal ops dashboard + email generator for SunPower's Site Survey department.
Built by Doug Regehr (Site Survey Manager) to replace manual reporting done by previous manager David Richards.

## Current state
- `survey_dashboard_v5.html` — fully built, single HTML file, ready to deploy
- Needs to become a multi-file Vercel project
- Email generator needs to be scaffolded

## Tech stack
- Pure HTML/CSS/JS — no framework, no build step
- Vercel for hosting (free hobby plan)
- Vercel serverless function for Claude API calls (api key in env vars)
- Chart.js + chartjs-plugin-annotation for charts
- Single file per page — everything inline

---

## Project structure to build

```
survey-ops/
├── index.html              ← public dashboard (already built, rename from v5)
├── compose/
│   └── index.html          ← private email generator (scaffold)
├── api/
│   └── generate.js         ← Claude API serverless function
├── vercel.json             ← routing config
└── .env                    ← ANTHROPIC_API_KEY (local only, never commit)
```

---

## Data architecture

**Until Salesforce API is live (a few weeks out):**
- Data is baked into index.html as `const RAW = [...]`
- Morning workflow: pull SF export → drop into dashboard → click Export Dashboard → `vercel --prod`
- Both index.html and compose/index.html get same baked data on deploy
- Export Dashboard button needs to write data into BOTH files simultaneously

**Once Salesforce API is live:**
- Standard OAuth 2.0
- Both tools hit same endpoint, data refreshes on load
- Field registry in both files maps Salesforce column names to internal keys

---

## Field registry (critical architecture)

Both tools share this pattern. Adding a new Salesforce field = one registry entry, shows up everywhere automatically.

```javascript
const FIELDS = [
  {key:'contact',       sfCol:'Primary Contact',           label:'Contact',       type:'text',     filterable:false, editable:true},
  {key:'project',       sfCol:'Project Name',              label:'Project',       type:'text',     filterable:false, editable:true},
  {key:'region',        sfCol:'Sales Region',              label:'Sales Region',  type:'category', filterable:true,  editable:true},
  {key:'type',          sfCol:'Project Installation Type', label:'Survey Type',   type:'category', filterable:true,  editable:true},
  // NOTE: 'type' label is 'Install Type' — do NOT rename to 'Survey Type'. SF uses 'Type of Survey' for a different field (kind of survey: Site Survey / Battery Only / Resurvey). See survey_type future field.
  {key:'start',         sfCol:'Project Start Date',        label:'Project Start', type:'date',     filterable:true,  editable:true},
  {key:'requested',     sfCol:'Site Survey Requested',     label:'Requested',     type:'date',     filterable:false, editable:true},
  {key:'scheduled',     sfCol:'Site Survey Scheduled',     label:'Scheduled',     type:'date',     filterable:false, editable:true},
  {key:'complete',      sfCol:'Site Survey Complete',      label:'Complete',       type:'date',     filterable:false, editable:true},
  // FUTURE FIELDS — uncomment when IT ticket lands (a few weeks):
  // {key:'resource',      sfCol:'Resource',        label:'Resource',        type:'category', filterable:true,  editable:true,
  //   pending:true, values:['Ambia Solar','Sales Rep','RDCL Services','Install Partner']},
  // {key:'surveyor_name', sfCol:'Assigned To',     label:'Assigned To',     type:'text',     filterable:false, editable:true, nullOk:['RDCL Services']},
  // {key:'survey_type',   sfCol:'Type of Survey',  label:'Survey Type',     type:'category', filterable:true,  editable:true,
  //   pending:true, values:['Site Survey','Site Survey + Battery','Battery Only Survey','Resurvey']},
  // {key:'delay_reason',  sfCol:'Site Survey Delay Reason', label:'Delay Reason', type:'category', filterable:true, editable:true, pending:true},
  // {key:'reschedule_reason', sfCol:'Reschedule Reason Category', label:'Reschedule Reason', type:'category', filterable:true, editable:true, pending:true},
  // {key:'resurvey_reason',   sfCol:'Resurvey Reason Category',   label:'Resurvey Reason',   type:'category', filterable:true, editable:true, pending:true},
  // {key:'resurvey_attributed', sfCol:'Resurvey Attributed to',   label:'Attributed To',     type:'category', filterable:true, editable:true, pending:true},
  //   // ^^ This field enables FPY vs Absolute FPY calculation
  {key:'ct_s2r',  computed:true, label:'Start→Req (d)',  type:'number'},
  {key:'ct_r2s',  computed:true, label:'Req→Sched (d)',  type:'number'},
  {key:'ct_total',computed:true, label:'Total (d)',       type:'number'},
];
```

**Terminology note (IMPORTANT):**
- Salesforce calls it "Resource" = who does the survey (Ambia Solar / Sales Rep / RDCL Services / Install Partner)
- Salesforce calls it "Type of Survey" = what kind (Site Survey / Battery Only / Resurvey)
- Our dashboard currently mislabels these — fix in next rebuild

---

## Dashboard (index.html) — what's built

**Pages:** Exec Summary, Overview, Weekly, Regions, Outliers, Source Data, Settings

**Key features:**
- Filter bar auto-generated from FIELD_REGISTRY filterable:true fields
- Global/per-page filter toggle with memory
- Outlier removal — IQR-based, adjustable multiplier slider
- 3-week rolling average on exec trend + weekly charts
- Annotation plugin for target lines (3d median / 4d avg per Spec 12744)
- Settings page — exec theme (3 options), default landing page, targets, outlier defaults, min region volume, SF credentials, field registry status, Spec 12744 reference
- Update modal — 3-step SF export flow with drag-drop zone
- Export dashboard button — bakes current data into new HTML file

**Known issues / change list for next rebuild:**
- 'type' field label should be 'Survey Type' not 'Install Type'
- 'surveyor_type' sfCol should be 'Resource' not 'Surveyor Type'
- Export dashboard button only writes one file — needs to write both index.html and compose/index.html
- Weekly table shows Mon-Sun range (fixed) but waterfall x-axis still shows only week start date
- Surveyor type breakdown on Regions page hidden until field exists — will show automatically once 'resource' field is in export

---

## Email generator (compose/index.html) — to build

**Access:** JS password prompt on load. Password stored in sessionStorage (persists through same browser session, not across sessions). Not cryptographically secure but sufficient for internal tool.

**Two modes:**
- **Monday** — prior full week recap
- **Daily (Tue-Fri)** — prior day summary

**Monday email contains:**
- Total scheduled vs completed (site surveys + resurveys separately)
- Cycle time for the week (overall + by Resource type: Ambia Solar / Sales Rep / RDCL / Install Partner)
- Outlier callout if any (with and without outlier numbers)
- 3-week rolling average trend direction
- Weekly goal vs actual
- Commentary section (see below)
- One visual — Outlook-safe HTML table-based chart (no Canvas, no external images)
- Dashboard link (subtle, at bottom)

**Daily email (Tue-Fri) contains:**
- Scheduled yesterday + completed yesterday (site surveys + resurveys separate)
- Week-to-date running totals
- One-line pace check vs weekly goal
- Commentary section
- No cycle time (too granular for daily)
- Same subtle dashboard link

**Recipient fields (pre-populated):**
- To: allie.morais@sunpower.com; spencer.jensen@sunpower.com; robert.barker@sunpower.com
- Subject: auto-generated based on mode and date

**Sign-off:**
```
Doug Regehr
Site Survey Manager
Phone: 801-793-1861
douglas.regehr@sunpower.com
```

**Commentary workflow:**
1. Dashboard surfaces 2-3 flagged data observations (auto, from the numbers)
2. "Generate commentary" button calls /api/generate with actual data + voice prompt
3. Returns 3 short options — click one to select
4. Manual note field for operational context model can't know
5. "Generate full commentary" fallback — produces complete draft

**Voice / tone for Claude prompt:**
- Direct, confident, not corporate
- Short sentences that carry weight
- States conclusions plainly — "cycle time is trending down" not "we are pleased to report..."
- Casual but not sloppy — "refined casual"
- No: "it's worth noting", "additionally", "as we can see", "moving forward", passive voice
- Audience: Allie Morais (Site Survey Senior Lead), Rob Barker (Director Ops Pre-Install), Spencer Jensen (SVP Ops — reads it in 45 seconds, wants to know if there's a problem)
- Site survey is a minor department when running smoothly. Don't oversell it. Flag problems, explain outliers, note if help is needed. Deeper analysis → dashboard link.

**Email preview:**
- 600px width (standard Outlook)
- Rendered in iframe so what you see = what they get
- Updates live as you edit

**Send workflow:**
- "Copy HTML" button — copies email HTML to clipboard
- "Open in Outlook" button — opens mailto: with To + Subject pre-filled, HTML already on clipboard, user pastes body

**Data inputs (manual until SF reports confirmed with David):**
- Scheduled count (yesterday or week)
- Completed count (yesterday or week)
- Resurvey scheduled count
- Resurvey completed count
- Weekly goal — scheduled target
- Weekly goal — completed target
- All labeled "pending SF report confirmation" until David meeting

---

## api/generate.js — serverless function

```javascript
// Vercel serverless function
// ANTHROPIC_API_KEY lives in Vercel environment variables only
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { data, mode, manualNote } = req.body;
  // Call claude-sonnet-4-6
  // Return 3 commentary options in Doug's voice
  // See voice spec above
}
```

---

## vercel.json

```json
{
  "rewrites": [
    { "source": "/compose", "destination": "/compose/index.html" },
    { "source": "/compose/(.*)", "destination": "/compose/index.html" }
  ]
}
```

---

## Targets (from Spec 12744)
- Median target: 3 days (booking to completed site survey)
- Average target: 4 days
- Quality standard: Zero Defects, 100% FPY
- FPY = (Total Completions – Total Internal Defects) / Total Completions
- Absolute FPY = (Total Completions – Total Resurveys) / Total Completions
- Internal defects = Resurvey Attributed to: SunPower Field or Radicl Agent
- Customer defects = Resurvey Attributed to: Customer or Sales Rep

---

## People
- Doug Regehr — Site Survey Manager (the user, email sender)
- Allie Morais — Site Survey Senior Lead (email recipient, Doug's direct lead)
- Spencer Jensen — SVP Operations (email recipient, most senior — reads fast, wants problems flagged)
- Rob Barker — Director of Operations Pre-Install (email recipient)
- David Richards — previous Site Survey Manager (Doug is replacing him)

---

## Pending after David meeting
- Which SF report(s) to pull for scheduled/completed counts
- Confirm which fields are accurate/functional in SF currently
- Historical data from Albatross if available
- IT contact for SF field additions
- Where weekly goals come from (Spencer sets them? capacity model?)
- Status of any pending IT requests already in flight

---

## Change list (dashboard — next rebuild)
### Bugs
- 'type' label stays 'Install Type' — see NOTE in field registry
- Future 'resource' field: sfCol is 'Resource', label is 'Resource' (already correct in registry comments)
- Future 'survey_type' field: sfCol is 'Type of Survey' — distinct from Project Installation Type
- Weekly waterfall x-axis shows only week start — should show Mon-Sun range

### Features pending
- Exec Summary: on load, auto-filter to last full Mon–Sun week (e.g. if today is Tuesday Apr 14, default to Apr 6–12). Currently shows all data. Should set dateFrom/dateTo in filter state on init, not just from autoDateRange.
- Resource breakdown on Regions page (auto-shows when field exists)
- FPY + Absolute FPY metrics (needs Resurvey Attributed To field)
- Delay reason filter + chart (needs IT ticket field)
- Reschedule reason breakdown (needs IT ticket field)
- Aging view — open projects accumulating days (needs different SF report)
- Week-over-week delta → replaced with 3-week rolling avg (done)
- Outlier export option

### Architecture
- Booking date = Project Start Date? — confirm with David (affects target accuracy)
- Survey Complete = Design-accepted? — confirm with David

