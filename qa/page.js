// qa/page.js — the Site Survey QA page.
//
// Loaded before the main script, so this file only DEFINES things: every helper
// it leans on (esc, toast, allRows, sfUrl, animateSections ...) is resolved when
// a function runs, never at load. It reads a vendor's report in the browser —
// the PDF never leaves the machine — checks it with lib/qa.cjs, and builds the
// six fields Salesforce wants. Reviews are kept in this browser for now; see
// docs/QA.md for what a shared log needs.

const QA_LOCAL_PASSWORD = 'sunpower';                // only used when there is no server (a local static copy); same word as /compose
const QA_LOG_KEY = 'ops_qa_log', QA_USER_KEY = 'ops_qa_reviewer', QA_PW_KEY = 'ops_qa_pw';
const QA_API = '/api/qa-log';
const QA_SPECS = ['sitecapture-v13', 'radicl-v1', 'radicl-v2'];
const QA_PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/';
const QA_SF_STATUSES = ['Passed', 'Failed - Gaps Found', 'Passed with Override'];
const QA_TEMPLATE_SHORT = { 'sitecapture-v13': 'Site Capture V.13', 'radicl-v2': 'Radicl Sep 2026', 'radicl-v1': 'Radicl Aug 2026' };
const QA_TEMPLATE_NAMES = {
  'sitecapture-v13': 'SunPower · Site Capture form V.13',
  'radicl-v2': 'Radicl · current template',
  'radicl-v1': 'Radicl · August 2026 template',
};

let qaView = 'review', qaLens = 'reviews', qaFlag = null, qaQ = '', qaStatusF = 'all', qaOpen = null;
let qaLog = null, qaRun = null, qaDeps = null, qaPack = null, qaProj = '', qaReviewer = null;
let qaMode = 'checking', qaNote = '', qaSyncing = null, qaUser = '';
let qaVendor = (() => { try { return localStorage.getItem('ops_qa_vendor') === 'radicl' ? 'radicl' : 'sitecapture'; } catch (e) { return 'sitecapture'; } })();
let qaGuess = [];   // qaGuess: possible projects when the report's address fits more than one      // 'checking' | 'shared' | 'local'
let qaBusy = { pdf: '', zip: '' }, qaErr = { pdf: '', zip: '' };
let qaEditing = null, qaEditDraft = null, qaPendingRecord = null, qaTplVendor = null, qaLikelyAll = false;
const qaUrls = [];

// The hash that opened the page names a record (#qa?r=QA-...). Captured at load,
// before the main script's own routing rewrites the URL.
function qaReadRecordHash() { const m = location.hash.match(/[?&]r=([^&]+)/); if (m && /^#qa/.test(location.hash)) qaPendingRecord = decodeURIComponent(m[1]); }
qaReadRecordHash();
// This listener is registered before the app's own (this file loads first), so it
// sees a pasted or clicked record link before the app rewrites the hash.
window.addEventListener('hashchange', qaReadRecordHash);

const qaH = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const qaPlural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
const qaDate = r => r.date || (r.created ? new Date(r.created).toLocaleDateString('en-US') : '');

// ── Access ─────────────────────────────────────────
// The prompt only decides whether the page is shown. What protects the shared
// history is the server, which checks the same password on every call (see
// api/qa-log.js); a static file cannot keep a secret.
function qaPw() { try { return sessionStorage.getItem(QA_PW_KEY) || ''; } catch (e) { return ''; } }
function qaGate() {
  if (qaPw()) return true;
  const pw = prompt('Password:');
  if (!pw) return false;
  try { sessionStorage.setItem(QA_PW_KEY, pw); } catch (e) {}
  return true;
}
// A wrong password is found out on the first call, not at the prompt: drop it and
// go back to the page the person came from.
function qaBounce(msg) {
  try { sessionStorage.removeItem(QA_PW_KEY); } catch (e) {}
  qaLog = null; qaMode = 'checking'; qaUser = '';
  toast(msg || 'Wrong password');
  nav(['week'].includes(currentPage) || currentPage === 'qa' ? 'week' : currentPage);
}

// ── Storage ────────────────────────────────────────
// Two homes for the log. With the server and database set up it is shared: one
// history for every viewer. Without them (a local copy of the app, or the
// database not provisioned yet) it is this browser's localStorage, so nothing
// breaks, and the bar says which one you are looking at.
function qaLocalLog() { try { return JSON.parse(localStorage.getItem(QA_LOG_KEY) || '[]'); } catch (e) { return []; } }
function qaLoad() {
  if (qaLog) return qaLog;
  qaLog = qaMode === 'shared' ? [] : qaLocalLog();
  if (qaReviewer === null) { try { qaReviewer = localStorage.getItem(QA_USER_KEY) || ''; } catch (e) { qaReviewer = ''; } }
  return qaLog;
}
function qaPersist() {
  if (qaMode === 'shared') return true;                       // the server already has it
  try { localStorage.setItem(QA_LOG_KEY, JSON.stringify(qaLog)); return true; }
  catch (e) { toast('Couldn\'t save. Browser storage is full or blocked'); return false; }
}

async function qaApi(method, query, body) {
  let r;
  try {
    r = await fetch(QA_API + (query || ''), { method, headers: { 'content-type': 'application/json', 'x-qa-password': qaPw() }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { return { status: 0, body: null }; }
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}

// Ask the server for the shared log; fall back to this browser's when there is
// none. Safe to call often (page open, tab focus, the Refresh button).
function qaSync() {
  if (qaSyncing) return qaSyncing;
  qaSyncing = (async () => {
    const r = await qaApi('GET');
    qaSyncing = null;
    if (r.status === 200 && r.body && Array.isArray(r.body.reviews)) {
      qaMode = 'shared'; qaNote = ''; qaLog = r.body.reviews;
      // The password says who this is; the Reviewer is that person and is not editable.
      qaUser = r.body.user || ''; if (qaUser) qaReviewer = qaUser;
    } else if (r.status === 401) { qaBounce('Wrong password'); return false; }
    else {
      qaMode = 'local';
      qaNote = r.status === 503 ? (r.body && r.body.detail) || 'The review database isn\'t set up on the server yet.'
        : 'No server here, so reviews stay in this browser.';
      if (qaPw() !== QA_LOCAL_PASSWORD) { qaBounce('Wrong password'); return false; }
      qaLog = qaLocalLog();
    }
    return true;
  })();
  return qaSyncing;
}
function qaAfterSync() {
  if (currentPage !== 'qa') return;
  if (qaMode === 'shared' && qaUser) _qaBar();        // the Reviewer is now known and locked
  _qaConn(); _qaDup(); if (qaView === 'review' && !qaRun) _qaLikely();
  if (qaView === 'log') _qaLog();
  else if (qaView === 'templates') _qaTemplates();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && currentPage === 'qa' && qaMode === 'shared') qaSync().then(ok => ok && qaAfterSync()); });

// ── Dependencies, loaded on first use so no other page pays for them ──
function qaDepsLoad() {
  if (qaDeps) return qaDeps;
  qaDeps = (async () => {
    const specs = await Promise.all(QA_SPECS.map(n => fetch('qa/specs/' + n + '.json').then(r => { if (!r.ok) throw new Error("Couldn't load the " + n + ' template'); return r.json(); })));
    const mod = await import('/qa/pdf-blocks.mjs');
    const pdfjs = await import(QA_PDFJS + 'pdf.min.mjs');
    // A worker cannot start from another origin, so it is fetched and run from a blob.
    const code = await (await fetch(QA_PDFJS + 'pdf.worker.min.mjs')).text();
    pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    return { specs, mod, pdfjs };
  })();
  qaDeps.catch(() => { qaDeps = null; });
  return qaDeps;
}
function qaJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = () => res(window.JSZip); s.onerror = () => rej(new Error('Couldn\'t load the zip reader'));
    document.head.appendChild(s);
  });
}
async function qaHash(bytes) {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Salesforce project lookup ──────────────────────
function qaProjectRow(id) {
  id = String(id || '').trim().toUpperCase();
  if (!id) return null;
  // Salesforce appends " - Battery Only" to some projects; the bare ID finds them too.
  const hits = allRows.filter(r => { const p = (r.project || '').toUpperCase(); return p === id || p.split(' - ')[0] === id; });
  return hits.find(r => r.task_id) || hits[0] || null;
}
// Which Salesforce project is this report for? Radicl reports carry only the
// address, so match on street number + a street word (+ ZIP when both have one).
const QA_STREET_SKIP = new Set(['north', 'south', 'east', 'west', 'street', 'avenue', 'drive', 'road', 'lane', 'court', 'circle', 'boulevard', 'place', 'way', 'trail', 'terrace', 'highway', 'parkway', 'unit', 'apt', 'suite']);
function qaAddrParts(a) {
  const t = String(a || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const num = t.find(x => /^\d+$/.test(x) && x.length <= 6) || '', zip = (String(a || '').match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1] || '';
  const sig = t.filter(x => x.length >= 3 && !/\d/.test(x) && !QA_STREET_SKIP.has(x) && !['st', 'ave', 'dr', 'rd', 'ln', 'ct', 'cir', 'blvd', 'pl', 'trl', 'ter'].includes(x));
  const words = new Set(sig), first = sig[0] || '';
  return { num, zip, words, first };
}
function qaFindProjects(addr) {
  const a = qaAddrParts(addr); if (!a.num || !a.words.size) return [];
  const by = new Map();
  for (const r of allRows) {
    if (!r.address || !r.project) continue;
    const b = qaAddrParts(r.address);
    if (b.num !== a.num || (a.zip && b.zip && a.zip !== b.zip)) continue;
    if (!b.words.has(a.first)) continue;                        // the street name has to agree
    const cur = by.get(r.project); if (!cur || (!cur.open && isOpenQueue(r))) by.set(r.project, { project: r.project, open: isOpenQueue(r), row: r });
  }
  const all = [...by.values()], open = all.filter(x => x.open);
  return (open.length ? open : all).map(x => x.project);
}
// Fill the project ID from the report: the ID Site Capture prints if Salesforce knows it, else the address.
function qaAutoProject(S) {
  qaGuess = [];
  if (qaProj.trim()) return '';
  const printed = S.meta.project && qaProjectRow(S.meta.project) ? S.meta.project : '';
  if (printed) { qaProj = printed; return 'the project ID on the report'; }
  const hits = qaFindProjects(S.meta.address);
  if (hits.length === 1) { qaProj = hits[0]; return 'the report address'; }
  if (hits.length > 1) { qaGuess = hits.slice(0, 6); return ''; }
  if (S.meta.project) qaProj = S.meta.project;
  return '';
}
// The box is highlighted until it is filled, once a report is loaded and nothing matched.
const qaNeedsProject = () => !!qaRun && !qaRun.saved && !qaProj.trim();
function qaChooseGuess(p) { qaGuess = []; qaSetProject(p); const el = document.getElementById('qa-project'); if (el) el.value = p; qaProjectCommit(); }
function qaMatchHtml() {
  const id = qaProj.trim();
  if (!id && qaGuess.length) return `<div class="qa-match warn">The report address fits ${qaGuess.length} projects. Pick one: ${qaGuess.map(p => `<button class="qa-link" data-p="${qaH(p)}" onclick="qaChooseGuess(this.dataset.p)">${qaH(p)}</button>`).join(' ')}</div>`;
  if (!id) return '';
  const r = qaProjectRow(id);
  if (!r) return `<div class="qa-match warn">No Salesforce project with that ID.</div>`;
  const link = sfUrl(r) ? ` <a href="${qaH(sfUrl(r))}" target="_blank" rel="noopener">Open ↗</a>` : '';
  return `<div class="qa-match ok"><b>${qaH(r.project)}</b> · ${qaH(r.address || 'no address')}<br>${qaH(r.project_status || '')}${r.resource ? ' · ' + qaH(r.resource) : ''}${link}</div>`;
}
// Typing only records the ID and shows the Salesforce match; the checks that read
// the project (address, resource) re-run when the field is left, so the page does
// not rebuild under the cursor.
function qaSetProject(v, fromStep) {
  if (qaRun && qaRun.saved) return;                 // the project is fixed once saved
  qaProj = v;
  const el = document.getElementById('qa-match'); if (el) el.innerHTML = qaMatchHtml();
  const other = document.getElementById(fromStep ? 'qa-project' : 'qa-project2'); if (other) other.value = v;
  for (const id of ['qa-project', 'qa-project2']) { const e = document.getElementById(id); if (e) e.classList.toggle('needs', qaNeedsProject()); }
  _qaBar();
  _qaSaveBtn();
}
// Leaving the field re-runs the checks that read the project. It must not rebuild the
// step: the click that moved focus is often on Save, and a rebuild eats it.
function qaProjectCommit() {
  const run = qaRun; if (!run || run.saved) return;
  qaReeval(true);
  if (!run.edited) run.summary = qaSummaryText();
  _qaStrip();
  if (run.step === 4) { const f = document.getElementById('qa-project-field'); if (f && qaProj.trim()) f.remove(); _qaSaveBtn(); }
  else if ([0, 3].includes(run.step)) _qaStep();
}
function qaSetReviewer(v) {
  if (qaMode === 'shared' && qaUser) return;
  qaReviewer = v;
  try { localStorage.setItem(QA_USER_KEY, v); } catch (e) {}
  if (qaRun) { _qaSaveBtn(); if (qaRun.step === 4) _qaStep(); }
}

// ── Reading a report ───────────────────────────────
async function qaPick(kind, file) {
  if (!file) return;
  if (kind === 'pdf') return qaOpenReport(file);
  return qaOpenPack(file);
}
function qaDropState(kind) {
  const busy = qaBusy[kind], err = qaErr[kind];
  const have = kind === 'pdf' ? qaRun && qaRun.file : qaPack;
  const cls = busy ? ' busy' : err ? ' err' : have ? ' loaded' : '';
  const title = kind === 'pdf' ? 'Drop the report (PDF)' : 'Drop the photo export (zip)';
  const sub = busy || err || (have ? (have.name + ' · ' + (kind === 'pdf' ? qaRun.S.meta.pages + ' pages' : have.note)) : (kind === 'pdf' ? 'Stays in this browser' : 'Optional · original quality'));
  return { cls, title: have && !busy && !err ? (kind === 'pdf' ? 'Report loaded' : 'Photos loaded') : title, sub };
}
function qaDropHtml(kind) {
  const d = qaDropState(kind), id = 'qa-file-' + kind;
  return `<input type="file" id="${id}" accept="${kind === 'pdf' ? '.pdf,application/pdf' : '.zip,application/zip'}" style="display:none;" onchange="qaPick('${kind}',this.files[0]);this.value='';">
    <div class="upd-drophere${d.cls}" id="qa-drop-${kind}" tabindex="0" role="button"
      onclick="document.getElementById('${id}').click()"
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();document.getElementById('${id}').click();}"
      ondragover="event.preventDefault();this.classList.add('drag-over');"
      ondragleave="this.classList.remove('drag-over');"
      ondrop="event.preventDefault();this.classList.remove('drag-over');qaPick('${kind}',event.dataTransfer.files[0]);">
      <strong>${qaH(d.title)}</strong><span>${qaH(d.sub)}</span></div>`;
}
function qaSetBusy(kind, msg, err) {
  qaBusy[kind] = msg || ''; qaErr[kind] = err || '';
  const el = document.getElementById('qa-dz-' + kind); if (el) el.innerHTML = qaDropHtml(kind);
}

// ── Intake ─────────────────────────────────────────
const QA_VENDORS = { sitecapture: 'SunPower survey', radicl: 'Radicl survey' };
// Which checklist to show before a report is loaded. The report decides the survey
// type itself once it is read, so nothing here asks the reviewer to say.
function qaSetCheckVendor(v) {
  qaVendor = v;
  try { localStorage.setItem('ops_qa_vendor', v); } catch (e) {}
  if (!qaRun) _qaChecklist();
}
function _qaIntake() {
  const host = document.getElementById('qa-intake'); if (!host) return;
  const clear = !qaRun && (qaProj.trim() || qaPack) ? `<button class="qa-link qa-clear" onclick="qaStartOver()">Start over</button>` : '';
  host.innerHTML = `${clear}<div class="qa-form">
    <div class="qa-field"><span class="klabel">Project ID</span>
      <input class="qa-in${qaNeedsProject() ? ' needs' : ''}" id="qa-project" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. 2321LOPE" value="${qaH(qaProj)}"${qaRun && qaRun.saved ? ' readonly title="The project is fixed once a review is saved"' : ''}
        oninput="qaSetProject(this.value)" onchange="qaProjectCommit()" aria-label="Project ID">
      <div id="qa-match">${qaMatchHtml()}</div></div>
    <div class="qa-field"><span class="klabel">Report</span><div id="qa-dz-pdf">${qaDropHtml('pdf')}</div></div>
    <div class="qa-field"><span class="klabel">Photos</span><div id="qa-dz-zip">${qaDropHtml('zip')}</div></div>
  </div>`;
}

async function qaOpenReport(file) {
  qaSetBusy('pdf', 'Reading the report…');
  try {
    const deps = await qaDepsLoad();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await qaHash(bytes);
    const { pages } = await deps.mod.pdfToBlocks(bytes, { pdfjs: deps.pdfjs, onPage: (n, t) => qaSetBusy('pdf', `Reading page ${n} of ${t}…`) });
    const det = OpsQA.detectTemplate(pages, deps.specs);
    if (det.vendor === 'unknown') throw new Error('That\'s not a Site Capture or Radicl survey report');
    const spec = deps.specs.find(s => s.id === det.specId) || null;
    const S = det.vendor === 'sitecapture' ? OpsQA.parseSiteCapture(pages, spec) : OpsQA.parseRadicl(pages, { specId: det.specId });
    const how = qaAutoProject(S);
    if (qaRun && qaRun.pdfUrl) URL.revokeObjectURL(qaRun.pdfUrl);
    qaVendor = det.vendor;                                    // the report says what it is
    try { localStorage.setItem('ops_qa_vendor', qaVendor); } catch (e) {}
    qaRun = { file: { name: file.name, size: file.size, hash }, bytes, det, S, spec, specs: deps.specs, R: null, items: null, allKey: [], expand: {},
      verdicts: {}, decisions: {}, status: null, override: '', summary: '', edited: false, saved: null, step: 0, visited: { 0: true }, pdfUrl: null };
    qaFlag = 'all';
    qaReeval(true);
    if (how) toast('Project ' + qaProj + ' filled in from ' + how);
    qaSetBusy('pdf', '');
    if (qaPack) qaCrossCheckPack();
    qaRender();
    requestAnimationFrame(() => animateSections('page-qa'));
    qaLoadPhotos();
  } catch (e) {
    console.error(e);
    qaSetBusy('pdf', '', e.message || 'Couldn\'t read that file');
  }
}

// Run the checks again with the project the coordinator typed.
function qaReeval(full) {
  const run = qaRun; if (!run) return;
  const row = qaProjectRow(qaProj);
  const ctx = { sfAddress: row ? row.address : null, sfResource: row ? (row.resource || null) : null };
  run.ctx = ctx;
  run.R = OpsQA.evaluate(run.S, run.specs, ctx);
  if (!full) qaRefresh();
}

// Findings including what a person saw in the photos.
function qaFindings() {
  const run = qaRun; if (!run) return [];
  // A call made on a flagged item settles it: Good passes it, Bad is a miss at the check's own weight.
  const out = run.R.findings.map(f => {
    const d = run.decisions[qaFlagKey(f)];
    if (!d || !qaIsFlagged(f)) return f;
    return d === 'ok' ? Object.assign({}, f, { status: 'pass', verify: false })
      : Object.assign({}, f, { status: 'miss', verify: false, detail: 'Judged not good from the report' + (f.detail ? ': ' + f.detail : '') });
  });
  for (const it of run.items || []) {
    if (run.verdicts[qaPhotoKey(it)] === 'bad') {
      out.push({ layer: 'P', id: 'photo:' + qaPhotoKey(it), area: 'Photos', status: 'miss', severity: 'hard',
        title: it.label + ' photo not usable', detail: (it.unit ? it.unit + ', ' : '') + 'photo ' + it.n + ' was marked unreadable or wrong', evidence: {} });
    }
  }
  return out;
}
const qaIsFlagged = f => f.status === 'verify' || (f.status === 'pass' && f.verify);
const qaFlagKey = f => f.id + '|' + (f.detail || f.note || '');
function qaOutcome() { return OpsQA.outcomeOf(qaFindings()); }
const qaPhotoKey = it => [it.id, it.unit || '', it.n].join('|');

function qaReviewNumber() {
  if (qaRun && qaRun.savedRec) return qaRun.savedRec.n;
  const id = qaProj.trim().toUpperCase();
  return qaLoad().filter(r => r.project === id).length + 1;
}
function qaSummaryText() {
  const run = qaRun, o = qaOutcome();
  const res = Object.assign({}, run.R, { findings: qaFindings(), counts: o.counts, suggestedStatus: o.suggestedStatus });
  return OpsQA.summarize(res, { reviewNumber: qaReviewNumber(), status: run.status, override: run.status === 'Passed with Override' ? run.override.trim() : '' }).text;
}
// What the findings say changed (a project ID, a photo marked unusable, a status):
// the summary, the strip and whichever step shows them.
function qaRefresh() {
  const run = qaRun; if (!run) return;
  if (!run.edited) run.summary = qaSummaryText();
  _qaStrip();
  if ([0, 3, 4].includes(run.step)) _qaStep();
}

// ── Photo pack (the export from Site Capture) ──────
async function qaOpenPack(file) {
  qaSetBusy('zip', 'Reading the photo export…');
  try {
    const JSZip = await qaJSZip();
    const zip = await JSZip.loadAsync(file);
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
    const deps = await qaDepsLoad();
    // Site Capture's export is one folder per field; Radicl's is one flat folder.
    const kind = names.some(n => n.split('/').length >= 3) ? 'sitecapture' : 'radicl';
    const pack = kind === 'sitecapture' ? OpsQA.indexPhotoPack(names, deps.specs.find(s => s.id === 'sitecapture-v13')) : OpsQA.indexRadiclPack(names);
    qaPack = { name: file.name, zip, pack, kind, note: names.length + ' photos', check: null };
    qaSetBusy('zip', '');
    if (qaRun) { qaCrossCheckPack(); qaRender(); qaLoadPhotos(); }
    else { const el = document.getElementById('qa-dz-zip'); if (el) el.innerHTML = qaDropHtml('zip'); }
  } catch (e) {
    console.error(e);
    qaSetBusy('zip', '', e.message || 'Couldn\'t read that file');
  }
}
function qaCrossCheckPack() {
  if (!qaPack || !qaRun) return;
  if (qaPack.kind !== qaRun.S.template.vendor) { qaPack.check = { skipped: true }; qaPack.note = 'This photo export is from the other survey type, so it is not used'; return; }
  qaPack.check = qaPack.kind === 'radicl' ? OpsQA.crossCheckRadiclPack(qaRun.S, qaPack.pack) : OpsQA.crossCheckPack(qaRun.S, qaPack.pack);
  const c = qaPack.check;
  qaPack.note = `${c.packPhotos} photos · ${c.matched} of ${c.folders} folders match the report`;
}

// ── Photos: from the export when there is one, otherwise cut out of the PDF ──
const qaWrapPhoto = i => Object.assign({}, i, { url: null, from: null, w: 0, h: 0, soft: false });
async function qaLoadPhotos() {
  const run = qaRun; if (!run) return;
  qaUrls.splice(0).forEach(u => URL.revokeObjectURL(u));
  run.photosSettled = false;
  run.allKey = OpsQA.keyPhotos(run.S, run.spec, { all: true });
  run.items = OpsQA.keyPhotos(run.S, run.spec).map(qaWrapPhoto);
  run.expand = {};
  if (run.step === 1) _qaStep();
  await qaFetchImages(run.items);
  run.photosSettled = true;
  _qaPhotoMeta();
}
async function qaMore(id) {
  const run = qaRun; if (!run) return;
  const have = new Set(run.items.map(qaPhotoKey));
  const add = run.allKey.filter(i => i.id === id && !have.has(qaPhotoKey(i))).map(qaWrapPhoto);
  run.items.push(...add); run.expand[id] = true;
  run.photosSettled = false;
  if (run.step === 1) _qaStep();
  await qaFetchImages(add);
  run.photosSettled = true; _qaPhotoMeta();
}
async function qaFetchImages(items) {
  const run = qaRun; if (!run) return;
  if (qaPack && qaPack.kind === run.S.template.vendor) {
    for (const it of items) {
      const path = (qaPack.kind === 'radicl' ? OpsQA.radiclPackFile : OpsQA.packFile)(run.S, qaPack.pack, it.photo);
      const f = path && qaPack.zip.file(path);
      if (f) { const blob = await f.async('blob'); it.url = URL.createObjectURL(blob); qaUrls.push(it.url); it.from = 'Original'; await qaMeasure(it, blob); qaPhotoReady(it); }
    }
  }
  const need = items.filter(i => !i.url);
  if (!need.length) return;
  try {
    const deps = await qaDepsLoad();
    const pages = [...new Set(need.map(i => i.photo.page))];
    const imgs = await deps.mod.pdfImages(run.bytes, pages, { pdfjs: deps.pdfjs });
    for (const it of need) {
      const cap = it.photo.cap; if (!cap) continue;
      const near = (imgs[it.photo.page] || [])
        .filter(m => Math.abs(m.x - cap.x0) < 16 && (cap.y1 - (m.y + m.h)) > -10)
        .sort((a, b) => (cap.y1 - (a.y + a.h)) - (cap.y1 - (b.y + b.h)))[0];
      if (!near) continue;
      const blob = await near.get();
      it.url = URL.createObjectURL(blob); qaUrls.push(it.url); it.from = 'From the report';
      it.w = near.width; it.h = near.height;                  // the source's own size, not the thumbnail's
      await qaMeasure(it, blob);
      qaPhotoReady(it);
    }
  } catch (e) { console.error(e); }
  for (const it of items) if (!it.url) { const c = document.querySelector(`.qa-ph[data-i="${qaRun.items.indexOf(it)}"] .qa-ph-img`); if (c) c.textContent = 'Not found in the report'; }
}

// How sharp is it? The variance of a Laplacian over a small grey copy: a soft or
// motion-blurred photo has few strong edges, so the variance is low. Size comes
// from the picture itself when the report did not say.
async function qaMeasure(it, blob) {
  try {
    const bmp = await createImageBitmap(blob);
    if (!it.w) { it.w = bmp.width; it.h = bmp.height; }
    const W = 200, H = Math.max(8, Math.round(bmp.height * W / bmp.width));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H).data, g = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    let sum = 0, sq = 0, n = 0;
    for (let y = 1; y < H - 1; y++) for (let xx = 1; xx < W - 1; xx++) {
      const i = y * W + xx, l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - W] - g[i + W];
      sum += l; sq += l * l; n++;
    }
    it.sharp = sq / n - (sum / n) * (sum / n);
    it.soft = it.sharp < QA_SOFT_BELOW;
    if (bmp.close) bmp.close();
  } catch (e) { /* an unreadable image simply has no measurement */ }
}
const QA_SOFT_BELOW = 40;           // Laplacian variance at 200px wide; calibrated on real surveys
const QA_LOW_RES = 1000;            // long edge in pixels below which a breaker rating is unlikely to be readable

function qaQuality() {
  const run = qaRun, own = qaPack && run && qaPack.kind === run.S.template.vendor;
  const m = (run.items || []).filter(i => i.from === 'From the report' && i.w);
  const low = m.filter(i => Math.max(i.w, i.h) < QA_LOW_RES), soft = m.filter(i => i.soft);
  const size = m.length ? `${Math.max(...m.map(i => i.w))}×${Math.max(...m.map(i => i.h))}` : '';
  const recommend = !own && m.length > 0 && (low.length >= m.length / 2 || soft.length >= Math.max(2, Math.ceil(m.length * 0.3)));
  const why = low.length >= m.length / 2 ? `The photos in this report are small (${size} at most), so breaker ratings and labels may not be readable.`
    : `${soft.length} of ${m.length} photos in this report look soft.`;
  return { recommend, why };
}
function qaQualityHtml() {
  if (!qaRun || !qaRun.items) return '';
  const q = qaQuality(); if (!q.recommend) return '';
  return `<div class="qa-quality"><span>${qaH(q.why)} Add the photo export to look at the originals.</span><button onclick="qaAddPack()">Add the photo export</button></div>`;
}
function qaAddPack() { const f = document.getElementById('qa-file-zip'); if (f) f.click(); }

function qaPhotoSub() {
  const its = qaRun.items || [], loaded = its.filter(x => x.url).length;
  const shown = `Showing ${its.length} of ${qaRun.S.photos.length} photos, the ones that decide the checks.`;
  return loaded < its.length && !qaRun.photosSettled ? `Loading photos ${loaded} of ${its.length}…` : `${shown} Only mark the ones you can't use. “+ more” opens the rest of a check.`;
}
function _qaPhotoMeta() {
  const sub = document.getElementById('qa-ph-sub'); if (sub) sub.textContent = qaPhotoSub();
  const q = document.getElementById('qa-quality'); if (q) q.innerHTML = qaQualityHtml();
}
function qaPhotoReady(it) {
  const i = qaRun.items.indexOf(it), card = document.querySelector(`.qa-ph[data-i="${i}"]`);
  if (card) {
    const box = card.querySelector('.qa-ph-img');
    box.classList.remove('empty'); box.setAttribute('role', 'button'); box.tabIndex = 0; box.setAttribute('onclick', `qaZoom(${i})`);
    box.innerHTML = `<img src="${it.url}" alt="${qaH(it.label)}">`;
    card.querySelector('.qa-ph-cap').innerHTML = qaPhotoCap(it);
  }
  _qaPhotoMeta();
}
const qaPhotoCap = it => `<b>${qaH(it.unit || it.label)}</b> · ${it.n}${it.url ? ` · ${it.from === 'Original' ? 'original' : 'report'}${it.soft ? ' · soft' : ''}` : ''}`;

// ── Page entry ─────────────────────────────────────
function renderQA() {
  const el = document.getElementById('qa-content'); if (!el) return;
  qaLoad();
  qaRender();
  qaSync().then(ok => {
    if (!ok) return;
    if (qaPendingRecord) {
      const id = qaPendingRecord; qaPendingRecord = null;
      qaView = 'log'; qaLens = 'reviews'; qaQ = ''; qaStatusF = 'all';
      if (qaLog.some(r => r.id === id)) qaOpen = id;
      else toast(id + ' isn\'t in History. It probably never got saved.');
      qaRender(); requestAnimationFrame(() => { const el = document.getElementById('qa-row-' + id); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
      return;
    }
    qaAfterSync();
  });
}
function qaRender() {
  const el = document.getElementById('qa-content'); if (!el) return;
  el.innerHTML = `<div id="qa-bar"></div><div id="qa-body"></div>`;
  _qaBar();
  if (qaView === 'review') _qaReview();
  else if (qaView === 'log') _qaLog();
  else _qaTemplates();
}
function qaSetView(v) { qaView = v; qaRender(); requestAnimationFrame(() => animateSections('page-qa')); }

function _qaBar() {
  const host = document.getElementById('qa-bar'); if (!host) return;
  const btn = (v, l) => `<button class="fbtn${qaView === v ? ' fbtn-active' : ''}" onclick="qaSetView('${v}')">${l}</button>`;
  const who = qaMode === 'shared' && qaUser
    ? `<span class="qa-conn" title="Set by your password"><span class="fsel-label">Reviewer</span> <b>${qaH(qaUser)}</b></span>`
    : `<span class="fsel-label" style="font-size:11px;color:var(--muted);">Reviewer</span>
      <input class="drill-search" id="qa-reviewer" type="text" placeholder="Your name" value="${qaH(qaReviewer || '')}" oninput="qaSetReviewer(this.value)" style="flex:0 0 150px;min-width:110px;" aria-label="Reviewer name">`;
  host.innerHTML = `<div class="fbar">
    <div class="fbtn-group" role="group" aria-label="QA view">${btn('review', 'Review')}${btn('templates', 'Templates')}${btn('log', 'History')}</div>
    <div class="fgroup" style="margin-left:auto;">
      <span id="qa-conn"></span>
      ${who}
    </div>
  </div>`;
  _qaConn();
}
function _qaConn() {
  const el = document.getElementById('qa-conn'); if (!el) return;
  const n = qaLog ? qaLog.length : 0;
  el.innerHTML = qaMode === 'checking' ? '' : `<span class="qa-conn" title="${qaMode === 'local' ? qaH(qaNote) : 'Reviews saved by the whole team'}">${qaMode === 'local' ? '<span class="qa-sw warn"></span>' : ''}${qaPlural(n, 'review')}${qaMode === 'local' ? ' · this browser only' : ''}</span>`;
}

// ── Review view ────────────────────────────────────
function _qaReview() {
  const host = document.getElementById('qa-body'); if (!host) return;
  host.innerHTML = `<div id="qa-dup"></div><div class="sec qa-intake" id="qa-intake"></div><div id="qa-likely"></div><div id="qa-run"></div>`;
  _qaIntake(); _qaDup();
  if (qaRun) _qaFlow(); else { _qaLikely(); _qaChecklist(); }
}
// A report someone has already reviewed — a colleague included — is flagged
// before it is reviewed twice.
function _qaDup() {
  const host = document.getElementById('qa-dup'); if (!host) return;
  const dup = qaRun && !qaRun.saved && qaLoad().find(r => r.file && r.file.hash === qaRun.file.hash);
  const local = qaMode === 'local' ? `<div class="qa-banner qa-banner-info"><span>${qaH(qaNote)} Reviews you save stay on this computer.</span></div>` : '';
  host.innerHTML = local + (dup ? `<div class="qa-banner"><span>This exact report was already reviewed: review ${dup.n} of ${qaH(dup.project)} on ${qaH(qaDate(dup))} by ${qaH(dup.reviewer)}, ${qaH(dup.status)}.</span>
      <button onclick="qaOpenRecord('${qaH(dup.id)}')">Open it</button></div>` : '');
}

// Surveys that were booked for today or earlier and are not complete in Salesforce:
// the ones most likely to have a report waiting. Rep surveys are phased out, so
// only Radicl and SunPower surveyors are listed.
function qaLikely() {
  const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const out = [], seen = new Set();
  for (const r of allRows) {
    if (!isOpenQueue(r) || r.resource === 'Sales Rep' || !r.resource || seen.has(r.project)) continue;
    const sched = wipSchedDate(r);
    if (!sched || sched > today) continue;
    seen.add(r.project); out.push({ r, sched, ago: Math.round((new Date(today) - new Date(sched)) / 864e5) });
  }
  return out.sort((a, b) => a.ago - b.ago || a.r.project.localeCompare(b.r.project));
}
function _qaLikely() {
  const host = document.getElementById('qa-likely'); if (!host || qaRun) return;
  const all = qaLikely(), list = qaLikelyAll ? all : all.slice(0, 12), log = qaLoad();
  if (!all.length) { host.innerHTML = ''; return; }
  const sel = qaProj.trim().toUpperCase();
  const reviews = p => log.filter(x => x.project === p.toUpperCase()).length;
  host.innerHTML = `<div class="sec"><div class="shead"><div><div class="stitle">Likely to review</div>
    <div class="ssub">${qaPlural(all.length, 'survey')} booked for today or earlier and not complete in Salesforce. Pick one to start.</div></div></div>
    <div class="qa-likely">${list.map(x => {
      const n = reviews(x.r.project), on = sel && sel === x.r.project.toUpperCase();
      return `<button class="qa-lk${on ? ' on' : ''}" data-p="${qaH(x.r.project)}" onclick="qaPickProject(this.dataset.p)">
        <span class="qa-lk-p">${qaH(x.r.project)}</span>
        <span class="qa-lk-a">${qaH((x.r.address || '').replace(/,?\s*[A-Z]{2}\s+\d{5}.*$/, '') || 'no address')}</span>
        <span class="qa-lk-m">${x.r.resource === 'Radicl Services' ? 'Radicl' : 'SunPower'} · ${x.ago === 0 ? 'today' : x.ago === 1 ? 'yesterday' : x.ago + ' days ago'}${n ? ` · reviewed ${n}×` : ''}</span></button>`;
    }).join('')}</div>
    ${all.length > 12 ? `<div class="tbl-foot"><button class="copy-btn" onclick="qaLikelyAll=!qaLikelyAll;_qaLikely()">${qaLikelyAll ? 'Show fewer' : 'Show all ' + all.length}</button></div>` : ''}</div>`;
}
function qaPickProject(p) {
  if (qaRun) return;
  if (qaProj.trim().toUpperCase() === p.toUpperCase()) { qaProj = ''; }
  else {
    qaProj = p;
    const r = qaProjectRow(p);
    if (r && r.resource) { qaVendor = r.resource === 'Radicl Services' ? 'radicl' : 'sitecapture'; try { localStorage.setItem('ops_qa_vendor', qaVendor); } catch (e) {} }
  }
  _qaIntake(); _qaLikely(); _qaChecklist(); _qaBar();
  if (qaProj) { const f = document.getElementById('qa-intake'); if (f) f.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}

// What is checked, before there is anything to check.
function _qaChecklist() {
  const host = document.getElementById('qa-run'); if (!host) return;
  const specId = qaVendor === 'radicl' ? 'radicl-v2' : 'sitecapture-v13';
  const list = OpsQA.checklist(specId);
  const areas = OpsQA.AREA_ORDER.filter(a => list.some(c => c.area === a));
  const cols = [[], [], []];
  const weight = a => list.filter(c => c.area === a).length + 2;
  const load = [0, 0, 0];
  areas.forEach(a => { const k = load.indexOf(Math.min(...load)); cols[k].push(a); load[k] += weight(a); });
  const outside = list.filter(c => !c.inTemplate).length;
  host.innerHTML = `<div class="sec">
    <div class="shead"><div><div class="stitle">What we check</div>
      <div class="ssub">${list.length} checks, plus every field the template requires.${outside ? ` ${qaH(outside === 1 ? 'One' : String(outside))} marked <span class="qa-tag">not in template</span> ${outside === 1 ? 'is' : 'are'} something Design needs that the template doesn't ask for.` : ''}</div></div>
      <div class="toggle-group" role="group" aria-label="Checklist">${['sitecapture', 'radicl'].map(v => `<button class="tgl-btn${qaVendor === v ? ' active' : ''}" onclick="qaSetCheckVendor('${v}')">${v === 'radicl' ? 'Radicl' : 'SunPower'}</button>`).join('')}</div></div>
    <div class="qa-checks">${cols.map(cs => `<div class="qa-checks-col">${cs.map(a => `<div class="qa-checks-h">${qaH(a)}</div>
      ${list.filter(c => c.area === a).map(c => `<div class="qa-chk"><span class="qa-sw ${c.severity === 'hard' ? 'hard' : 'warn'}" title="${c.severity === 'hard' ? 'Stops a handoff' : 'Asks for a look'}"></span><span>${qaH(c.title)}${c.inTemplate ? '' : ' <span class="qa-tag">not in template</span>'}</span></div>`).join('')}`).join('')}</div>`).join('')}</div>
    <div class="note" style="margin-top:10px;"><span class="qa-sw hard"></span> stops a handoff &nbsp; <span class="qa-sw warn"></span> asks for a look</div>
  </div>`;
}

function qaStatusPill(s) {
  const cls = s === 'Passed' ? 'pg' : s === 'Failed - Gaps Found' ? 'pr' : s === 'Passed with Override' ? 'pam' : 'qa-pill-mute';
  return `<span class="pill ${cls}">${qaH(s || 'Not started')}</span>`;
}

// ── The flow: findings, photos, report, summary, status ──
const QA_STEPS = ['Findings', 'Photos', 'Report', 'Summary', 'Status & save'];
function _qaFlow() {
  const host = document.getElementById('qa-run'); if (!host) return;
  host.innerHTML = `<div class="sec qa-flow"><div class="qa-steps" id="qa-steps"></div><div class="qa-strip" id="qa-strip"></div><div class="qa-body" id="qa-step"></div><div class="qa-nav" id="qa-nav"></div></div>`;
  if (!qaRun.edited) qaRun.summary = qaSummaryText();
  _qaSteps(); _qaStrip(); _qaStep(); _qaNav();
}
function _qaSteps() {
  const host = document.getElementById('qa-steps'); if (!host || !qaRun) return;
  host.innerHTML = QA_STEPS.map((l, i) => `<button class="qa-stepbtn${qaRun.step === i ? ' on' : ''}${qaRun.visited[i] && qaRun.step !== i ? ' done' : ''}" onclick="qaGo(${i})"><span class="qa-stepn">${qaRun.visited[i] && qaRun.step !== i ? '✓' : i + 1}</span>${l}</button>`).join('');
}
function qaGo(i) {
  const run = qaRun; if (!run) return;
  run.step = Math.max(0, Math.min(QA_STEPS.length - 1, i)); run.visited[run.step] = true;
  _qaSteps(); _qaStep(); _qaNav();
  const f = document.querySelector('.qa-flow'); if (f && f.getBoundingClientRect().top < 0) f.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
function _qaNav() {
  const host = document.getElementById('qa-nav'); if (!host || !qaRun) return;
  const s = qaRun.step, last = s === QA_STEPS.length - 1;
  host.innerHTML = `<button class="qa-navbtn" onclick="qaGo(${s - 1})"${s === 0 ? ' disabled' : ''}>← Back</button>
    <span class="qa-sfhint">Step ${s + 1} of ${QA_STEPS.length}</span>
    ${last ? '<span></span>' : `<button class="qa-navbtn next" onclick="qaGo(${s + 1})">${QA_STEPS[s + 1]} →</button>`}`;
}
function _qaStrip() {
  const host = document.getElementById('qa-strip'); if (!host || !qaRun) return;
  const o = qaOutcome(), c = o.counts;
  host.innerHTML = `<span class="qa-outcome">${qaStatusPill(o.suggestedStatus)}</span>
    <span><b>${c.missHard}</b> hard ${c.missHard === 1 ? 'miss' : 'misses'}</span><span><b>${c.missWarn}</b> to review</span><span><b>${c.gap + c.standingGaps}</b> not in template</span><span><b>${qaRun.S.photos.length}</b> photos</span>
    <span class="sp"><button onclick="qaViewPdf(1)">View report</button><button class="qa-startover" onclick="qaStartOver()">${qaRun.saved ? 'New review' : 'Start over'}</button></span>`;
}
function _qaStep() {
  const host = document.getElementById('qa-step'); if (!host || !qaRun) return;
  [_qaFindings, _qaPhotosStep, _qaReportStep, _qaSummaryStep, _qaStatusStep][qaRun.step](host);
}

// Step 1 — what we found
const QA_GROUPS = [
  { k: 'all', l: 'All', sw: '', f: x => x.status !== 'na' },
  { k: 'miss', l: 'Missing', sw: 'hard', f: x => x.status === 'miss' },
  { k: 'gap', l: 'Not in template', sw: 'gap', f: x => x.status === 'gap', note: 'The template has no field for these, so no survey on it can have them. They are not the surveyor’s miss.' },
  { k: 'verify', l: 'Look at', sw: 'look', f: x => x.status === 'verify' || (x.status === 'pass' && x.verify) },
  { k: 'pass', l: 'Passed', sw: 'pass', f: x => x.status === 'pass' && !x.verify },
];
function qaSortFindings(a, b) {
  const rank = f => f.status === 'miss' ? (f.severity === 'hard' ? 0 : 1) : f.status === 'gap' ? 2 : f.status === 'verify' || f.verify ? 3 : 4;
  return rank(a) - rank(b) || String(a.area).localeCompare(String(b.area));
}
function qaSetFlag(k) { qaFlag = k; _qaStep(); }
function _qaFindings(host) {
  const all = qaFindings();
  const counts = {}; QA_GROUPS.forEach(g => { counts[g.k] = all.filter(g.f).length; });
  if (!qaFlag || (qaFlag !== 'all' && !counts[qaFlag])) qaFlag = 'all';
  const g = QA_GROUPS.find(x => x.k === qaFlag);
  const rows = all.filter(g.f).sort(qaSortFindings);
  const S = qaRun.S, det = qaRun.det;
  const sub = [QA_TEMPLATE_NAMES[det.specId] || det.reason, S.meta.surveyor, S.meta.assessmentDate || S.meta.surveyDate].filter(Boolean).join(' · ');
  host.innerHTML = `<div class="qa-lede">${qaH(sub)}</div>
    <div class="qa-chips">${QA_GROUPS.filter(x => x.k === 'all' || counts[x.k]).map(x => `<button class="qa-chip${qaFlag === x.k ? ' on' : ''}" aria-pressed="${qaFlag === x.k}" onclick="qaSetFlag('${x.k}')">${x.sw ? `<span class="qa-sw ${x.sw}"></span>` : ''}${x.l}<span class="qa-chip-n">${counts[x.k]}</span></button>`).join('')}</div>
    ${g.note ? `<div class="qa-lede">${qaH(g.note)}</div>` : ''}
    ${rows.length ? rows.map(f => {
      const sw = f.status === 'miss' ? (f.severity === 'hard' ? 'hard' : 'warn') : f.status === 'gap' ? 'gap' : f.status === 'verify' || f.verify ? 'look' : 'pass';
      const pass = f.status === 'pass' && !f.verify;
      return `<div class="qa-find${pass ? ' pass' : ''}"><span class="qa-sw ${sw}"></span>
        <div class="t">${qaH(f.title)}${f.status === 'gap' ? ' <span class="qa-tag">not in template</span>' : ''}</div>
        <div class="d">${qaH(f.detail || (pass ? 'OK' : ''))}${f.page ? ` <button class="qa-link" onclick="qaViewPdf(${f.page})">p.${f.page}</button>` : ''}</div></div>`;
    }).join('') : `<div class="qa-empty">Nothing here.</div>`}`;
}

// Step 2 — the photos
function _qaPhotosStep(host) {
  const items = qaRun.items;
  if (!items) { host.innerHTML = '<div class="qa-empty">Loading…</div>'; return; }
  if (!items.length) { host.innerHTML = '<div class="qa-empty">No key photos were found in this report.</div>'; return; }
  const groups = [];
  items.forEach((it, i) => { let g = groups.find(x => x.id === it.id); if (!g) groups.push(g = { id: it.id, label: it.label, items: [] }); g.items.push({ it, i }); });
  host.innerHTML = `<div class="qa-lede" id="qa-ph-sub">${qaPhotoSub()}</div><div id="qa-quality">${qaQualityHtml()}</div>
    ${groups.map(g => {
      const total = qaRun.allKey.filter(x => x.id === g.id).length, more = total - g.items.length;
      return `<div class="qa-photos-h">${qaH(g.label)}</div><div class="qa-photos">
        ${g.items.map(({ it, i }) => {
          const v = qaRun.verdicts[qaPhotoKey(it)];
          return `<div class="qa-ph${v ? ' ' + v : ''}" data-i="${i}">
            <div class="qa-ph-img${it.url ? '' : ' empty'}"${it.url ? ` onclick="qaZoom(${i})" role="button" tabindex="0"` : ''}>${it.url ? `<img src="${it.url}" alt="${qaH(it.label)}">` : 'Loading…'}</div>
            <div class="qa-ph-cap">${qaPhotoCap(it)}</div>
            <div class="qa-ph-btns"><button class="bad${v === 'bad' ? ' on' : ''}" onclick="qaVerdict(${i},'bad')">${v === 'bad' ? 'Marked not usable' : 'Not usable'}</button></div></div>`;
        }).join('')}
        ${more > 0 ? `<button class="qa-more" onclick="qaMore('${g.id}')">+ ${more} more</button>` : ''}</div>`;
    }).join('')}`;
}
function qaVerdict(i, v) {
  const it = qaRun.items[i], k = qaPhotoKey(it);
  qaRun.verdicts[k] = qaRun.verdicts[k] === v ? null : v;
  // Update the card in place: rebuilding the grid reloads every image.
  const cur = qaRun.verdicts[k], card = document.querySelector(`.qa-ph[data-i="${i}"]`);
  if (card) {
    card.className = 'qa-ph' + (cur ? ' ' + cur : '');
    card.querySelectorAll('.qa-ph-btns button').forEach(b => b.classList.toggle('on', b.classList.contains(cur)));
  }
  if (!qaRun.edited) qaRun.summary = qaSummaryText();
  _qaStrip(); _qaSaveBtn();
}
let qaZoomAt = -1;
function qaZoom(i) {
  const items = qaRun && qaRun.items, it = items && items[i]; if (!it || !it.url) return;
  qaZoomAt = i;
  let lb = document.getElementById('qa-lb');
  if (!lb) { lb = document.createElement('div'); lb.id = 'qa-lb'; lb.className = 'qa-lb hidden'; lb.onclick = qaZoomClose; document.body.appendChild(lb); }
  const ready = items.map((x, k) => x.url ? k : -1).filter(k => k >= 0), pos = ready.indexOf(i);
  lb.innerHTML = `<img src="${it.url}" alt=""><div class="qa-lb-cap">${qaH(it.label)}${it.unit ? ' · ' + qaH(it.unit) : ''} · photo ${it.n}${ready.length > 1 ? ` · ${pos + 1} of ${ready.length} · ← → to move` : ''}</div>`;
  lb.classList.remove('hidden');
}
// Step to the next or previous photo that has loaded, wrapping at the ends.
function qaZoomStep(d) {
  const items = qaRun && qaRun.items; if (!items || qaZoomAt < 0) return;
  const ready = items.map((x, k) => x.url ? k : -1).filter(k => k >= 0); if (ready.length < 2) return;
  const pos = ready.indexOf(qaZoomAt);
  qaZoom(ready[(pos + d + ready.length) % ready.length]);
}
function qaZoomClose() { qaZoomAt = -1; const lb = document.getElementById('qa-lb'); if (lb) lb.classList.add('hidden'); }

// The report itself, in front of you, at the page that raised a question.
function qaViewPdf(page) {
  const run = qaRun; if (!run) return;
  if (!run.pdfUrl) run.pdfUrl = URL.createObjectURL(new Blob([run.bytes], { type: 'application/pdf' }));
  let v = document.getElementById('qa-pdf');
  if (!v) { v = document.createElement('div'); v.id = 'qa-pdf'; v.className = 'qa-pdf hidden'; document.body.appendChild(v); }
  v.innerHTML = `<div class="qa-pdf-bar"><span>${qaH(run.file.name)}${page > 1 ? ' · page ' + page : ''}</span><button onclick="qaPdfClose()">Close</button></div>
    <iframe title="Survey report" src="${run.pdfUrl}#page=${page || 1}"></iframe>`;
  v.classList.remove('hidden');
}
function qaPdfClose() { const v = document.getElementById('qa-pdf'); if (v) { v.classList.add('hidden'); v.innerHTML = ''; } }
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { qaZoomClose(); qaPdfClose(); return; }
  const lb = document.getElementById('qa-lb');
  if (lb && !lb.classList.contains('hidden') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); qaZoomStep(e.key === 'ArrowRight' ? 1 : -1); }
});

// Step 3 — anything the checks could not settle
function _qaReportStep(host) {
  const run = qaRun, flagged = run.R.findings.filter(qaIsFlagged);
  const left = flagged.filter(f => !run.decisions[qaFlagKey(f)]).length;
  host.innerHTML = `<div class="qa-lede" id="qa-rep-sub">${qaReportSub(flagged.length, left)}</div>
    ${flagged.map((f, i) => `<div class="qa-flag-row" data-i="${i}"><span class="t">${qaH(f.title)}</span><span class="d">${qaH(f.detail || f.note || '')}</span>
      <button class="qa-link" onclick="qaViewPdf(${f.page || 1})">${f.page ? 'Open page ' + f.page : 'Open report'}</button>${qaDecideHtml(i, run.decisions[qaFlagKey(f)])}</div>`).join('')}
    <div class="qa-actions"><button class="qa-navbtn" onclick="qaViewPdf(1)">Open the full report</button></div>`;
}
const qaReportSub = (n, left) => !n ? 'Nothing to double-check. Open the report if you want to skim it.'
  : left ? `${qaPlural(n, 'item')} to check against the report. ${left} left to decide.` : 'All decided. Anything marked Bad is now a miss.';
const qaDecideHtml = (i, d) => `<span class="qa-decide"><button class="ok${d === 'ok' ? ' on' : ''}" onclick="qaDecide(${i},'ok')">Good</button><button class="bad${d === 'bad' ? ' on' : ''}" onclick="qaDecide(${i},'bad')">Bad</button></span>`;
function qaDecide(i, v) {
  const run = qaRun, flagged = run.R.findings.filter(qaIsFlagged), f = flagged[i]; if (!f) return;
  const k = qaFlagKey(f);
  if (run.decisions[k] === v) delete run.decisions[k]; else run.decisions[k] = v;
  // Update the row in place so the report step keeps its place on the page.
  const row = document.querySelector(`.qa-flag-row[data-i="${i}"] .qa-decide`);
  if (row) row.outerHTML = qaDecideHtml(i, run.decisions[k]);
  const sub = document.getElementById('qa-rep-sub'); if (sub) sub.textContent = qaReportSub(flagged.length, flagged.filter(x => !run.decisions[qaFlagKey(x)]).length);
  if (!run.edited) run.summary = qaSummaryText();
  _qaStrip(); _qaSaveBtn();
}

// Step 4 — the summary Salesforce receives
function qaSetSummary(v) { qaRun.summary = v; qaRun.edited = true; const n = document.getElementById('qa-sum-n'); if (n) n.textContent = v.length + ' characters'; _qaSaveBtn(); }
function qaResetSummary() { qaRun.edited = false; qaRun.summary = qaSummaryText(); _qaStep(); }
function _qaSummaryStep(host) {
  const run = qaRun;
  host.innerHTML = `<div class="qa-lede">Written from the findings. Edit anything before it goes to Salesforce.${run.edited ? ' <button class="qa-link" onclick="qaResetSummary()">Reset to the written version</button>' : ''}</div>
    <textarea class="qa-in" id="qa-summary" style="min-height:170px;" oninput="qaSetSummary(this.value)" aria-label="Summary">${qaH(run.summary)}</textarea>
    <div class="qa-sfhint" id="qa-sum-n" style="margin-top:4px;">${run.summary.length} characters</div>`;
}

// Step 5 — the status, then save, then the Salesforce fields
function qaToday() { const d = new Date(); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; }
function qaRecordId() { if (qaRun && qaRun.saved) return qaRun.saved; const p = (qaProj.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'REPORT'); return `QA-${p}-${qaReviewNumber()}`; }
function qaRecordLink(id) { return location.origin + location.pathname + '#qa?r=' + encodeURIComponent(id); }
function qaSetStatus(s) { qaRun.status = qaRun.status === s ? null : s; qaRefresh(); }
function qaSetOverride(v) { qaRun.override = v; if (!qaRun.edited) qaRun.summary = qaSummaryText(); _qaSaveBtn(); }

// What a saved review is compared with to tell whether there is anything to save.
function qaSnap() {
  const run = qaRun; if (!run) return '';
  return JSON.stringify([run.status, run.status === 'Passed with Override' ? run.override.trim() : '', run.summary,
    qaFindings().filter(f => f.status !== 'na').map(f => [f.id, f.status, f.detail || ''])]);
}
function qaSaveBlock() {
  const run = qaRun; if (!run) return '';
  if (!qaProj.trim()) return 'Add the project ID before saving';
  if (!run.status) return 'Choose a review status';
  if (!(qaReviewer || '').trim()) return 'Add your name under Reviewer';
  if (run.status === 'Passed with Override' && run.override.trim().length < 5) return 'Say why you are passing it with an override';
  return '';
}
function _qaSaveBtn() {
  const b = document.getElementById('qa-save'); if (!b || !qaRun) return;
  const why = qaSaveBlock();
  const dirty = !qaRun.saved || qaSnap() !== qaRun.snap;
  b.disabled = !!why || !dirty || !!qaRun.saving; b.title = why;
  b.textContent = qaRun.saved ? 'Save changes' : 'Save review';
  const h = document.getElementById('qa-save-why'); if (h) h.textContent = why || (qaRun.saved && !dirty ? 'Up to date' : '');
}
function _qaStatusStep(host) {
  const run = qaRun, o = qaOutcome(), id = qaRecordId();
  const hardMiss = o.counts.missHard > 0;
  const stBtn = s => `<button class="tgl-btn${run.status === s ? ' active' : ''}"${s === 'Passed' && hardMiss ? ' disabled style="opacity:.4;cursor:default;" title="There are hard misses, so use Passed with Override"' : ''} onclick="qaSetStatus('${s}')">${s}</button>`;
  const hint = o.suggestedStatus === 'Needs review' ? 'Only warnings, so it\'s your call.' : `Looks like ${o.suggestedStatus}.`;
  const row = (label, val, key, wide) => `<div class="qa-sfrow${wide ? ' wide' : ''}"><div class="klabel">${label}</div><div class="qa-sfval">${val}</div>${key ? `<button class="copy-btn" onclick="qaCopy('${key}',this)">Copy</button>` : ''}</div>`;
  host.innerHTML = `
    ${qaProj.trim() ? '' : `<div class="qa-field" id="qa-project-field" style="max-width:260px;margin-bottom:12px;"><span class="klabel">Project ID (required)</span>
      <input class="qa-in needs" id="qa-project2" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. 2321LOPE" oninput="qaSetProject(this.value,true)" onchange="qaProjectCommit()" aria-label="Project ID"></div>`}
    <div class="qa-status"><div class="toggle-group">${QA_SF_STATUSES.map(stBtn).join('')}</div><span class="qa-sfhint">${qaH(hint)}</span></div>
    ${run.status === 'Passed with Override' ? `<textarea class="qa-in short" id="qa-override" placeholder="Why this passes despite the gap or miss" oninput="qaSetOverride(this.value)" aria-label="Override reason">${qaH(run.override)}</textarea>` : ''}
    <div class="qa-actions"><button class="qa-primary" id="qa-save" onclick="qaSave()">${run.saved ? 'Save changes' : 'Save review'}</button><span class="qa-sfhint warn" id="qa-save-why"></span>
      ${run.saved ? `<span class="qa-saved">Saved as ${qaH(run.saved)}</span><button class="qa-link" onclick="qaOpenRecord('${qaH(run.saved)}')">Open in History</button><button class="fbtn" style="margin-left:auto;" onclick="qaCopyAll(this)">Copy all</button>` : ''}</div>
    ${run.saved ? `<div class="qa-sf">
      ${row('Site Survey QA Review Status', qaH(run.status), 'status')}
      ${row('Site Survey QA Review Date', qaH(run.savedRec ? run.savedRec.date : qaToday()), 'date')}
      ${row('Site Survey QA Review Source', 'Coordinator', 'source')}
      ${row('Site Survey QA Reviewed By', qaH(run.savedRec ? run.savedRec.reviewer : qaReviewer), 'by')}
      ${row('Site Survey QA Report Link', `<span style="font-size:11px;">${qaH(qaRecordLink(id))}</span><div class="qa-sfhint">${qaH(id)} · ${qaMode === 'shared' ? 'opens this review for anyone on the team' : 'opens in this browser only'}</div>`, 'link', true)}
      ${row('Site Survey QA Summary', `<span style="white-space:pre-wrap;font-size:11.5px;">${qaH(run.summary)}</span>`, 'summary', true)}
    </div>` : ''}`;
  _qaSaveBtn();
}

function qaFieldValue(k) {
  const run = qaRun, id = qaRecordId();
  return ({ status: run.status || '', date: run.savedRec ? run.savedRec.date : qaToday(), by: (run.savedRec ? run.savedRec.reviewer : (qaReviewer || '')).trim(), source: 'Coordinator', summary: run.summary, link: qaRecordLink(id) })[k];
}
function qaCopy(k, btn) {
  const text = qaFieldValue(k);
  navigator.clipboard.writeText(text).then(() => qaCopied(btn)).catch(_copyFail);
}
function qaCopyAll(btn) {
  if (!qaRun || !qaRun.saved) return;
  const L = { status: 'Site Survey QA Review Status', date: 'Site Survey QA Review Date', by: 'Site Survey QA Reviewed By', source: 'Site Survey QA Review Source', summary: 'Site Survey QA Summary', link: 'Site Survey QA Report Link' };
  const text = Object.keys(L).map(k => L[k] + '\t' + String(qaFieldValue(k)).replace(/\n/g, ' / ')).join('\n');
  navigator.clipboard.writeText(text).then(() => qaCopied(btn)).catch(_copyFail);
}
function qaCopied(btn) {
  const was = btn.textContent; btn.classList.add('done'); btn.textContent = 'Copied';
  setTimeout(() => { btn.classList.remove('done'); btn.textContent = was; }, 1400);
}

// ── Save ───────────────────────────────────────────
async function qaSave() {
  const run = qaRun; if (!run || run.saving || qaSaveBlock()) return;
  if (run.saved) return qaUpdate();
  const o = qaOutcome(), id = qaRecordId(), row = qaProjectRow(qaProj);
  const rec = {
    id, project: qaProj.trim().toUpperCase(), n: qaReviewNumber(), created: new Date().toISOString(), date: qaToday(),
    reviewer: qaReviewer.trim(), source: 'Coordinator', status: run.status, override: run.status === 'Passed with Override' ? run.override.trim() : '',
    summary: run.summary, template: run.det.specId, vendor: run.det.vendor,
    surveyor: run.S.meta.surveyor || '', surveyDate: run.S.meta.assessmentDate || run.S.meta.surveyDate || '', reportCreated: run.S.meta.reportCreated || '',
    file: run.file, counts: o.counts, suggested: o.suggestedStatus,
    // the customer's address is not sent: the task id finds the account in Salesforce
    sf: row ? { task_id: row.task_id || '', resource: row.resource || '', status: row.project_status || '' } : null,
    pack: qaPack && qaPack.check && !qaPack.check.skipped ? { name: qaPack.name, matched: qaPack.check.matched, folders: qaPack.check.folders } : null,
    photos: { total: (run.items || []).length, bad: Object.values(run.verdicts).filter(v => v === 'bad').length },
    findings: qaFindings().filter(f => f.status !== 'na').map(f => ({ id: f.id, layer: f.layer, area: f.area, status: f.status, severity: f.severity, standing: !!f.standing, title: f.title, detail: f.detail || '' })),
    newToSpec: (run.R.templateReport.newToSpec || []).slice(0, 25),
  };
  run.saving = true; _qaSaveBtn();
  let saved = rec;
  if (qaMode === 'shared') {
    // The server numbers the review (it can see a colleague's save and a delete
    // that this browser cannot) and writes that number into the summary.
    const r = await qaApi('POST', '', { review: rec });
    if (r.status === 401) { run.saving = false; qaBounce('Wrong password'); return; }
    if (r.status !== 201 || !r.body || !r.body.review) { run.saving = false; _qaSaveBtn(); toast((r.body && r.body.error) || 'Couldn\'t save. Check your connection and try again'); return; }
    saved = r.body.review;
    qaLoad().unshift(saved);
  } else {
    qaLoad().unshift(rec);
    if (!qaPersist()) { qaLoad().shift(); run.saving = false; return; }
  }
  run.saving = false; run.saved = saved.id; run.savedRec = saved;
  if (saved.summary !== run.summary) run.summary = saved.summary;
  run.snap = qaSnap();
  const pf = document.getElementById('qa-project'); if (pf) { pf.readOnly = true; pf.title = 'The project is fixed once a review is saved'; pf.classList.remove('needs'); }
  toast('Saved ' + saved.id);
  _qaStatusStepRefresh(); _qaConn(); _qaBar(); _qaStrip();
}
// Revise a saved review: the status and its reason, the summary, and the findings behind them.
async function qaUpdate() {
  const run = qaRun, o = qaOutcome();
  const changes = {
    status: run.status, override: run.status === 'Passed with Override' ? run.override.trim() : '', summary: run.summary,
    counts: o.counts, suggested: o.suggestedStatus,
    photos: { total: (run.items || []).length, bad: Object.values(run.verdicts).filter(v => v === 'bad').length },
    findings: qaFindings().filter(f => f.status !== 'na').map(f => ({ id: f.id, layer: f.layer, area: f.area, status: f.status, severity: f.severity, standing: !!f.standing, title: f.title, detail: f.detail || '' })),
  };
  run.saving = true; _qaSaveBtn();
  const out = await qaApplyChanges(run.saved, changes);
  run.saving = false;
  if (!out) return _qaSaveBtn();
  run.savedRec = out; run.snap = qaSnap();
  toast('Changes saved');
  _qaSaveBtn(); _qaStatusStepRefresh();
}
// Send changes for a saved review to the server, or apply them to this browser's own log.
async function qaApplyChanges(id, changes) {
  const log = qaLoad(), i = log.findIndex(r => r.id === id);
  let rec;
  if (qaMode === 'shared') {
    const r = await qaApi('PUT', '?id=' + encodeURIComponent(id), { changes });
    if (r.status === 401) { qaBounce('Wrong password'); return null; }
    if (r.status !== 200 || !r.body || !r.body.review) { toast((r.body && r.body.error) || "Couldn't save the changes. Try again"); return null; }
    rec = r.body.review;
  } else {
    if (i < 0) { toast('That review is no longer in this browser'); return null; }
    rec = Object.assign({}, log[i], changes, { editedBy: qaReviewer || '', editedAt: new Date().toISOString() });
  }
  if (i >= 0) log[i] = rec; else log.unshift(rec);
  if (qaMode !== 'shared') qaPersist();
  return rec;
}
function _qaStatusStepRefresh() { if (qaRun.step === 4) _qaStep(); }
function qaStartOver() {
  if (qaRun && !qaRun.saved && !confirm('Discard this review and start over? Nothing has been saved.')) return;
  if (qaRun && qaRun.pdfUrl) URL.revokeObjectURL(qaRun.pdfUrl);
  qaRun = null; qaPack = null; qaProj = ''; qaFlag = null; qaErr = { pdf: '', zip: '' }; qaBusy = { pdf: '', zip: '' };
  qaUrls.splice(0).forEach(u => URL.revokeObjectURL(u));
  qaRender();
}
function qaOpenRecord(id) { qaView = 'log'; qaLens = 'reviews'; qaOpen = id; qaQ = ''; qaStatusF = 'all'; qaRender(); requestAnimationFrame(() => { const el = document.getElementById('qa-row-' + id); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }); }

// ── Log ────────────────────────────────────────────
function qaWeekStart() { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
function _qaLog() {
  const host = document.getElementById('qa-body'); if (!host) return;
  const log = qaLoad();
  const where = qaMode === 'shared' ? '' : 'Saved in this browser only.';
  const migrate = '';
  if (!log.length) {
    host.innerHTML = migrate + `<div class="sec"><div class="shead"><div><div class="stitle">No reviews yet</div>
      <div class="ssub">Saved reviews appear here, with how many times each account has been reviewed.</div></div></div>
      ${where ? `<div class="note" style="padding:6px 0 4px;">${where}</div>` : ''}</div>`;
    return;
  }
  const wk = qaWeekStart();
  const byProj = {}; log.forEach(r => { (byProj[r.project] = byProj[r.project] || []).push(r); });
  const accounts = Object.values(byProj);
  const rev2 = accounts.filter(a => a.length > 1).length;
  const thisWeek = log.filter(r => new Date(r.created).getTime() >= wk).length;
  const firstPass = log.filter(r => r.n === 1);
  const fp = firstPass.length ? Math.round(firstPass.filter(r => r.status === 'Passed').length / firstPass.length * 100) : null;
  const overrides = log.filter(r => r.status === 'Passed with Override').length;
  const cell = (label, val, sub, tip) => `<div class="srail-cell"><div class="klabel">${label}${tip ? kinfo(tip) : ''}</div><div class="srail-val">${val}${sub ? `<span class="srail-sub">${sub}</span>` : ''}</div></div>`;
  host.innerHTML = migrate + `
    <div class="srail">
      ${cell('Reviews', log.length, thisWeek + ' this week', 'Every saved review.')}
      ${cell('Passed first time', fp == null ? '—' : fp + '%', firstPass.length + ' first reviews', 'Of first reviews of an account, the share that passed with nothing to fix.')}
      ${cell('Reviewed again', rev2, rev2 === 1 ? 'account' : 'accounts', 'Accounts with more than one review: a failed survey that came back.')}
      ${cell('Overrides', overrides, log.length ? Math.round(overrides / log.length * 100) + '% of reviews' : '', 'Reviews passed with an override. Mostly template gaps until the templates are fixed.')}
    </div>
    <div class="sec"><div class="shead"><div><div class="stitle" id="qa-log-title"></div><div class="ssub" id="qa-log-sub"></div></div>
      <div class="toggle-group"><button class="tgl-btn${qaLens === 'reviews' ? ' active' : ''}" onclick="qaSetLens('reviews')">Reviews</button><button class="tgl-btn${qaLens === 'accounts' ? ' active' : ''}" onclick="qaSetLens('accounts')">By account</button></div></div>
      <div class="fbar" style="margin:0 0 10px;box-shadow:none;border-color:var(--border);">
        <input class="drill-search" id="qa-log-q" type="search" placeholder="Search project, surveyor, reviewer…" value="${qaH(qaQ)}" oninput="qaSetQ(this.value)" style="max-width:260px;">
        <span class="fselgrp${qaStatusF !== 'all' ? ' on' : ''}"><span class="fsel-label">Status</span><select onchange="qaSetStatusF(this.value)" aria-label="Filter by status">
          <option value="all">All</option>${QA_SF_STATUSES.map(s => `<option${qaStatusF === s ? ' selected' : ''}>${s}</option>`).join('')}</select></span>
        <div class="fgroup" style="margin-left:auto;">${qaMode === 'shared' ? `<button class="fbtn" onclick="qaRefreshLog(this)">Refresh</button>` : ''}<button class="fbtn" onclick="qaExport()">Export CSV</button></div>
      </div>
      <div id="qa-log-table"></div>
      ${where ? `<div class="note">${where}</div>` : ''}
    </div>`;
  _qaLogTable();
}
async function qaRefreshLog(btn) {
  const was = btn.textContent; btn.textContent = 'Refreshing…';
  const ok = await qaSync();
  if (ok) { _qaConn(); _qaLog(); }
}
function qaSetLens(l) { qaLens = l; qaOpen = null; _qaLog(); }
function qaSetQ(v) { qaQ = v; _qaLogTable(); }
function qaSetStatusF(v) { qaStatusF = v; _qaLogTable(); }
function qaToggleOpen(id) { qaEditing = null; qaOpen = qaOpen === id ? null : id; _qaLogTable(); }
function qaLogFiltered() {
  const q = qaQ.trim().toLowerCase();
  return qaLoad().filter(r => (qaStatusF === 'all' || r.status === qaStatusF)
    && (!q || [r.project, r.surveyor, r.reviewer, r.id, r.status].join(' ').toLowerCase().includes(q)));
}
function _qaLogTable() {
  const host = document.getElementById('qa-log-table'); if (!host) return;
  const rows = qaLogFiltered();
  const title = document.getElementById('qa-log-title'), sub = document.getElementById('qa-log-sub');
  if (title) title.textContent = qaLens === 'reviews' ? 'Reviews' : 'Accounts';
  const tname = r => QA_TEMPLATE_SHORT[r.template] || r.template;
  if (qaLens === 'accounts') {
    const by = {}; rows.forEach(r => { (by[r.project] = by[r.project] || []).push(r); });
    const accts = Object.entries(by).map(([p, a]) => { a.sort((x, y) => x.n - y.n); return { p, a, first: a[0], last: a[a.length - 1] }; })
      .sort((x, y) => y.a.length - x.a.length || y.last.created.localeCompare(x.last.created));
    if (sub) sub.textContent = qaPlural(accts.length, 'account') + ' · ' + qaPlural(rows.length, 'review');
    host.innerHTML = accts.length ? `<div class="xscroll"><table class="tbl" id="qa-acct-tbl"><thead><tr><th>Project</th><th class="r">Reviews</th><th>First review</th><th>Latest</th><th>Last reviewed</th></tr></thead><tbody>
      ${accts.map(x => `<tr class="drill-tgt" style="cursor:pointer;" onclick="qaLens='reviews';qaQ='${qaH(x.p)}';_qaLog();"><td><b>${qaH(x.p)}</b>${x.last.surveyor ? `<div class="cmeta">${qaH(x.last.surveyor)}</div>` : ''}</td>
        <td class="r">${x.a.length}</td><td>${qaStatusPill(x.first.status)}</td><td>${qaStatusPill(x.last.status)}</td><td style="color:var(--muted);white-space:nowrap;">${qaH(qaDate(x.last))}</td></tr>`).join('')}
    </tbody></table></div>` : `<div class="note" style="padding:10px 0;">Nothing matches.</div>`;
    return;
  }
  if (sub) sub.textContent = qaPlural(rows.length, 'review') + (qaQ ? ' matching "' + qaQ + '"' : '');
  host.innerHTML = rows.length ? `<div class="xscroll"><table class="tbl" id="qa-rev-tbl"><thead><tr><th></th><th>Date</th><th>Project</th><th class="r">Review</th><th>Template</th><th>Outcome</th><th class="r">Misses</th><th>Reviewed by</th></tr></thead><tbody>
    ${rows.map(r => {
      const open = qaOpen === r.id;
      return `<tr id="qa-row-${qaH(r.id)}" class="${open ? 'qa-row-open ' : ''}drill-tgt" style="cursor:pointer;" onclick="qaToggleOpen('${qaH(r.id)}')">
        <td style="width:18px;"><span class="qa-caret">›</span></td><td style="white-space:nowrap;">${qaH(qaDate(r))}</td>
        <td><b>${qaH(r.project)}</b>${r.surveyor ? `<div class="cmeta">${qaH(r.surveyor)}</div>` : ''}</td>
        <td class="r">${r.n}</td><td style="color:var(--muted);">${qaH(tname(r))}</td><td>${qaStatusPill(r.status)}</td>
        <td class="r">${r.counts.missHard ? `<span style="color:var(--red);font-weight:600;">${r.counts.missHard}</span>` : '0'}<span style="color:var(--faint);"> / ${r.counts.missWarn}</span></td>
        <td style="color:var(--muted);">${qaH(r.reviewer)}</td></tr>${open ? `<tr><td class="qa-expand" colspan="8">${qaRecordDetail(r)}</td></tr>` : ''}`;
    }).join('')}
  </tbody></table></div>
  <div class="tbl-foot"><button class="copy-btn" onclick="copyTableEl('qa-rev-tbl',this,'reviews')">Copy table</button></div>` : `<div class="note" style="padding:10px 0;">Nothing matches.</div>`;
}
function qaRecordDetail(r) {
  const misses = r.findings.filter(f => f.status === 'miss'), gaps = r.findings.filter(f => f.status === 'gap');
  const line = f => `<div>${f.severity === 'hard' ? '<span class="qa-sw hard"></span> ' : '<span class="qa-sw warn"></span> '}<b>${qaH(f.title)}</b> · ${qaH(f.detail)}</div>`;
  const left = qaEditing === r.id ? qaEditForm(r) : `<div class="klabel">Summary sent to Salesforce</div><pre class="qa-pre">${qaH(r.summary)}</pre>
      ${r.override ? `<div class="klabel" style="margin-top:12px;">Override</div><div class="qa-mini">${qaH(r.override)}</div>` : ''}
      ${r.editedAt ? `<div class="qa-sfhint" style="margin-top:8px;">Edited by ${qaH(r.editedBy || 'someone')} on ${qaH(new Date(r.editedAt).toLocaleDateString('en-US'))}</div>` : ''}
      <div class="qa-actions"><button class="copy-btn" onclick="qaCopyRecord('${qaH(r.id)}','summary',this)">Copy summary</button>
        <button class="copy-btn" onclick="qaCopyRecord('${qaH(r.id)}','link',this)">Copy link</button>
        <button class="qa-link" style="margin-left:auto;" onclick="qaEditRecord('${qaH(r.id)}')">Edit</button>
        <button class="qa-link" style="color:var(--red);" onclick="qaDelete('${qaH(r.id)}')">Delete</button></div>`;
  return `<div class="qa-expand-grid" onclick="event.stopPropagation()">
    <div>${left}</div>
    <div><div class="klabel">Record</div><div class="qa-mini">
        <b>${qaH(r.id)}</b> · ${qaH(r.source)}<br>
        Report: ${qaH(r.file.name)}<br>${r.reportLink || r.photoLink ? `Files: <a href="${qaH(r.reportLink || r.photoLink)}" target="_blank" rel="noopener">Drive ↗</a><br>` : ''}
        <span style="font-size:10px;">SHA-256 ${qaH(r.file.hash.slice(0, 16))}…</span><br>
        Checks pointed to ${qaH(r.suggested)}${r.photos && r.photos.total ? (r.photos.bad ? ` · ${r.photos.bad} of ${r.photos.total} photos marked not usable` : '') : ''}${r.pack ? `<br>Photo export: ${r.pack.matched} of ${r.pack.folders} folders matched` : ''}</div>
      <div class="klabel" style="margin-top:12px;">${qaPlural(misses.length, 'miss')} · ${qaPlural(gaps.filter(g => !g.standing).length, 'applied gap')}</div>
      <div class="qa-mini">${misses.slice(0, 10).map(line).join('') || 'No misses.'}${misses.length > 10 ? `<div>+${misses.length - 10} more</div>` : ''}</div></div>
  </div>`;
}
// Revise a saved review from History: the status, its reason and the summary. The findings
// stay as they were reviewed; change those from the review itself while it is open.
function qaEditForm(r) {
  const d = qaEditDraft;
  return `<div class="qa-edit"><div class="klabel">Status</div>
    <div class="toggle-group">${QA_SF_STATUSES.map(s => `<button class="tgl-btn${d.status === s ? ' active' : ''}" onclick="qaEditSet('status','${s}')">${s}</button>`).join('')}</div>
    ${d.status === 'Passed with Override' ? `<textarea class="qa-in short" placeholder="Why this passes despite the gap or miss" oninput="qaEditSet('override',this.value,true)" aria-label="Override reason">${qaH(d.override)}</textarea>` : ''}
    <div class="klabel">Summary</div>
    <textarea class="qa-in" style="min-height:150px;" oninput="qaEditSet('summary',this.value,true)" aria-label="Summary">${qaH(d.summary)}</textarea>
    <div class="qa-actions"><button class="qa-primary" id="qa-edit-save" onclick="qaEditSave('${qaH(r.id)}')">Save changes</button><button class="qa-link" onclick="qaEditRecord(null)">Cancel</button><span class="qa-sfhint warn" id="qa-edit-why"></span></div></div>`;
}
function qaEditRecord(id) {
  qaEditing = id; const r = id && qaLoad().find(x => x.id === id);
  qaEditDraft = r ? { status: r.status, override: r.override || '', summary: r.summary || '' } : null;
  _qaLogTable();
}
function qaEditSet(k, v, quiet) { qaEditDraft[k] = v; if (!quiet) return _qaLogTable(); }
async function qaEditSave(id) {
  const d = qaEditDraft, why = d.status === 'Passed with Override' && d.override.trim().length < 5 ? 'Say why you are passing it with an override' : !d.summary.trim() ? 'The summary can\'t be empty' : '';
  const el = document.getElementById('qa-edit-why'); if (el) el.textContent = why; if (why) return;
  const out = await qaApplyChanges(id, { status: d.status, override: d.status === 'Passed with Override' ? d.override.trim() : '', summary: d.summary });
  if (!out) return;
  qaEditing = null; qaEditDraft = null; toast('Changes saved'); _qaLog();
}
function qaCopyRecord(id, what, btn) {
  const r = qaLoad().find(x => x.id === id); if (!r) return;
  navigator.clipboard.writeText(what === 'link' ? qaRecordLink(id) : r.summary).then(() => qaCopied(btn)).catch(_copyFail);
}
async function qaDelete(id) {
  if (!confirm('Delete review ' + id + '? It disappears for everyone.')) return;
  if (qaMode === 'shared') {
    const r = await qaApi('DELETE', '?id=' + encodeURIComponent(id));
    if (r.status === 401) return qaBounce('Wrong password');
    if (r.status !== 200 && r.status !== 404) return toast('Couldn\'t delete. Try again');
  }
  qaLog = qaLoad().filter(r => r.id !== id); qaPersist(); qaOpen = null; _qaConn(); _qaLog();
}
function qaExport() {
  const log = qaLoad(); if (!log.length) return;
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['Review', 'Project', 'Review #', 'Date', 'Reviewed by', 'Source', 'Status', 'Template', 'Surveyor', 'Hard misses', 'Warnings', 'Applied gaps', 'Override', 'Summary', 'Report file', 'SHA-256'];
  const body = [head.map(q).join(',')].concat(log.map(r => [r.id, r.project, r.n, qaDate(r), r.reviewer, r.source, r.status, r.template, r.surveyor, r.counts.missHard, r.counts.missWarn, r.counts.gap, r.override, r.summary, r.file.name, r.file.hash].map(q).join(','))).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type: 'text/csv' })); a.download = 'qa-reviews.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ── Templates ──────────────────────────────────────
function _qaTemplates() {
  const host = document.getElementById('qa-body'); if (!host) return;
  qaDepsLoad().then(d => _qaTemplatesBody(d.specs), () => { host.innerHTML = `<div class="sec"><div class="note" style="padding:12px 0;">Couldn't load the templates.</div></div>`; });
  host.innerHTML = `<div class="sec"><div class="note" style="padding:14px 0;">Loading the templates…</div></div>`;
}
function qaSetTplVendor(v) { qaTplVendor = v; qaDepsLoad().then(d => _qaTemplatesBody(d.specs)); }
function _qaTemplatesBody(specs) {
  const host = document.getElementById('qa-body'); if (!host || qaView !== 'templates') return;
  const vendor = qaTplVendor || qaVendor, id = vendor === 'radicl' ? 'radicl-v2' : 'sitecapture-v13';
  const spec = specs.find(s => s.id === id), ch = OpsQA.templateChanges(id);
  const vbtn = v => `<button class="tgl-btn${vendor === v ? ' active' : ''}" onclick="qaSetTplVendor('${v}')">${v === 'radicl' ? 'Radicl' : 'SunPower'}</button>`;
  const note = !spec ? '' : vendor === 'radicl'
    ? (spec.inferredFrom >= 3 ? `Standard built from ${spec.inferredFrom} reference reports.` : `Standard built from ${qaPlural(spec.inferredFrom, 'reference report')}. Completeness checks start at three.`)
    : `${spec.fields.length} fields, ${spec.fields.filter(f => f.type === 'FOTO').length} of them photos.`;
  const tid = 'qa-chg-' + id;
  host.innerHTML = `<div class="fbar qa-tplbar"><div class="toggle-group" role="group" aria-label="Template">${vbtn('sitecapture')}${vbtn('radicl')}</div></div>
    <div class="sec">
      <div class="shead"><div><div class="stitle">${qaH(QA_TEMPLATE_NAMES[id])}</div>
        <div class="ssub">${qaH(note)} ${ch.length ? qaPlural(ch.length, 'change') + ' needed.' : ''}</div></div>
        ${ch.length ? `<button class="fbtn" onclick="qaCopyChanges('${id}',this)">Copy change list</button>` : ''}</div>
      ${ch.length ? `<div class="xscroll"><table class="tbl qa-tbl" id="${tid}"><thead><tr><th>Change</th><th>What to add or fix</th></tr></thead><tbody>
        ${ch.map(c => `<tr><td class="qa-check"><span class="qa-sev"><span class="qa-sw ${c.severity === 'hard' ? 'hard' : 'warn'}"></span></span> ${qaH(c.title)}</td><td class="qa-detail">${qaH(c.fix)}</td></tr>`).join('')}
      </tbody></table></div><div class="tbl-foot"><button class="copy-btn" onclick="copyTableEl('${tid}',this,'changes')">Copy table</button></div>`
        : `<div class="note" style="padding:10px 0;">Nothing to change.</div>`}
    </div>`;
}
function qaCopyChanges(id, btn) {
  const ch = OpsQA.templateChanges(id);
  const text = `${QA_TEMPLATE_NAMES[id]}: changes needed\n\n` + ch.map((c, i) => `${i + 1}. ${c.title}${c.severity === 'hard' ? ' (required)' : ''}\n   ${c.fix}`).join('\n\n');
  navigator.clipboard.writeText(text).then(() => qaCopied(btn)).catch(_copyFail);
}
