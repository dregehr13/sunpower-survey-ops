// qa/page.js — the Site Survey QA page.
//
// Loaded before the main script, so this file only DEFINES things: every helper
// it leans on (esc, toast, allRows, sfUrl, animateSections ...) is resolved when
// a function runs, never at load. It reads a vendor's report in the browser —
// the PDF never leaves the machine — checks it with lib/qa.cjs, and builds the
// six fields Salesforce wants. Reviews go to the team's shared history
// (api/qa-log.js); see docs/QA.md.

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
let qaChecks = {}, qaManager = false;     // which checks are Required / Flagged / Off over the defaults, and whether this password may change them
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
// A reload or a closed tab would lose every call and photo mark of a review not yet saved.
window.addEventListener('beforeunload', e => {
  if (qaRun && (!qaRun.saved || qaSnap() !== qaRun.snap)) { e.preventDefault(); e.returnValue = ''; }
});

const qaH = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const qaPlural = (n, w) => n + ' ' + w + (n === 1 ? '' : /s$/.test(w) ? 'es' : 's');
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
      qaChecks = (r.body.settings && r.body.settings.checks) || {}; qaManager = !!r.body.manager;
    } else if (r.status === 401) { qaBounce('Wrong password'); return false; }
    else if (r.status !== 404 && r.status !== 503) {
      // The server is there but failing (or the connection dropped). That is not a wrong password,
      // and saving into this browser instead would split the team's history without anyone knowing.
      qaMode = 'down'; qaNote = `Can't reach the review history (${r.status ? 'error ' + r.status : 'no connection'}). Nothing can be saved until it is back.`;
      if (!qaLog) qaLog = [];
    } else {
      // 404: a local copy with no API at all. 503: the server says the history is not set up.
      qaMode = 'local';
      qaNote = r.status === 503 ? (r.body && r.body.detail) || 'The review database isn\'t set up on the server yet.'
        : 'No server here, so reviews stay in this browser.';
      if (qaPw() !== QA_LOCAL_PASSWORD) { qaBounce('Wrong password'); return false; }
      qaLog = qaLocalLog();
      try { qaChecks = JSON.parse(localStorage.getItem('ops_qa_checks') || '{}') || {}; } catch (e) { qaChecks = {}; }
      qaManager = true;
    }
    return true;
  })();
  return qaSyncing;
}
// Before anything is written: a history that was down gets one more try.
async function qaReady() {
  const was = qaMode;
  if (qaMode === 'down' || qaMode === 'checking') await qaSync();
  if (was !== qaMode && currentPage === 'qa') { _qaBar(); _qaDup(); }     // back up: the offline banner goes
  if (qaMode === 'shared' || qaMode === 'local') return true;
  toast(qaNote || 'Can\'t reach the review history. Try again in a minute');
  return false;
}
function qaAfterSync() {
  if (currentPage !== 'qa') return;
  if (qaMode === 'shared' && qaUser) _qaBar();        // the Reviewer is now known and locked
  _qaConn(); _qaDup(); if (qaView === 'review' && !qaRun) _qaLikely();
  if (qaView === 'log') _qaLog();
  else if (qaView === 'templates') _qaTemplates();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && currentPage === 'qa' && (qaMode === 'shared' || qaMode === 'down')) qaSync().then(ok => ok && qaAfterSync()); });

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
// The project this review is for: who it is, from Salesforce. The ID is text with a pencil;
// it becomes a field only while it is being changed, or when there is nothing to show yet.
let qaProjEdit = false;
function qaProjCard() {
  const id = qaProj.trim(), r = id ? qaProjectRow(id) : null, locked = !!(qaRun && qaRun.saved);
  if (r && !qaProjEdit) {
    const link = sfUrl(r) ? ` · <a href="${qaH(sfUrl(r))}" target="_blank" rel="noopener">Open in Salesforce ↗</a>` : '';
    const rep = [r.sales_rep, r.sales_office].filter(Boolean).join(' · ');
    return `<div class="qa-projcard"><div class="qa-pc-top"><span class="qa-pc-id">${qaH(r.project)}</span>${locked ? '' : `<button class="qa-pc-edit" title="Change the project" aria-label="Change the project" onclick="qaEditProject()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>`}</div>
      ${r.contact ? `<div class="qa-pc-name">${qaH(r.contact)}</div>` : ''}
      <div class="qa-pc-meta">${qaH(r.address || 'no address')}</div>
      ${rep ? `<div class="qa-pc-meta">Sales rep ${qaH(rep)}</div>` : ''}
      <div class="qa-pc-meta">${qaH([r.project_status, r.resource, r.region].filter(Boolean).join(' · '))}${link}</div></div>`;
  }
  return `<div class="qa-projcard"><input class="qa-in${qaNeedsProject() ? ' needs' : ''}" id="qa-project" type="text" autocomplete="off" spellcheck="false" placeholder="Project ID, e.g. 2321LOPE" value="${qaH(qaProj)}"
      oninput="qaSetProject(this.value)" onchange="qaProjectCommit()" onblur="qaProjDone()" aria-label="Project ID"><div id="qa-match">${qaMatchHtml()}</div></div>`;
}
function qaEditProject() { qaProjEdit = true; const h = document.getElementById('qa-projcard'); if (h) { h.innerHTML = qaProjCard(); const i = document.getElementById('qa-project'); if (i) { i.focus(); i.select(); } } }
// Leaving the field with a project that exists puts the card back.
function qaProjDone() {
  if (!qaProjEdit && qaProjectRow(qaProj)) return;
  if (qaProjectRow(qaProj)) { qaProjEdit = false; const h = document.getElementById('qa-projcard'); if (h) h.innerHTML = qaProjCard(); }
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
  qaProjDone();
  if (!run.edited) run.summary = qaSummaryText();
  _qaStrip();
  if (run.step === 1) { const f = document.getElementById('qa-project-field'); if (f && qaProj.trim()) f.remove(); _qaSaveBtn(); }
  else if (run.step === 0) _qaStep();
}
function qaSetReviewer(v) {
  if (qaMode === 'shared' && qaUser) return;
  qaReviewer = v;
  try { localStorage.setItem(QA_USER_KEY, v); } catch (e) {}
  if (qaRun) { _qaSaveBtn(); if (qaRun.step === 1) _qaStep(); }
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
  // Before a report is loaded the report drop is the page's one call to action.
  const big = kind === 'pdf' && !qaRun;
  const title = big ? 'Upload a survey report to begin a review' : kind === 'pdf' ? 'Drop the report (PDF)' : 'Full-resolution photos (optional)';
  const sub = busy || err || (have ? (have.name + ' · ' + (kind === 'pdf' ? qaRun.S.meta.pages + ' pages' : have.note)) : (big ? 'Drop the PDF here or click to choose.' : kind === 'pdf' ? 'Drop the PDF here or click to choose' : 'Drop the photo export (zip)'));
  return { cls: cls + (big ? ' big' : ''), title: have && !busy && !err ? (kind === 'pdf' ? 'Report loaded' : 'Photos loaded') : title, sub };
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
function _qaIntake() {
  const host = document.getElementById('qa-intake'); if (!host) return;
  // No report yet: one field. A job picked from the list rides along and the report
  // is matched to it; otherwise the report names the project itself.
  if (!qaRun) {
    host.innerHTML = `<div class="qa-hero"><div id="qa-dz-pdf">${qaDropHtml('pdf')}</div>
      ${qaProj.trim() ? `<div class="qa-picked">Starting with <b>${qaH(qaProj.trim().toUpperCase())}</b> <button class="qa-link" onclick="qaStartOver()">Clear</button></div><div id="qa-match">${qaMatchHtml()}</div>` : '<div id="qa-match"></div>'}</div>`;
    return;
  }
  host.innerHTML = `<div class="qa-form">
    <div class="qa-field"><span class="klabel">Project</span><div id="qa-projcard">${qaProjCard()}</div></div>
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
    if (det.vendor === 'unknown') throw new Error(/^This is a Radicl/.test(det.reason) ? det.reason + '. Only site surveys are reviewed here.' : 'That\'s not a Site Capture or Radicl survey report');
    const spec = deps.specs.find(s => s.id === det.specId) || null;
    const S = det.vendor === 'sitecapture' ? OpsQA.parseSiteCapture(pages, spec) : OpsQA.parseRadicl(pages, { specId: det.specId, partial: det.partial });
    const how = qaAutoProject(S);
    if (qaRun && qaRun.pdfUrl) URL.revokeObjectURL(qaRun.pdfUrl);
    qaVendor = det.vendor;                                    // the report says what it is
    try { localStorage.setItem('ops_qa_vendor', qaVendor); } catch (e) {}
    qaRun = { file: { name: file.name, size: file.size, hash }, bytes, det, S, spec, specs: deps.specs, R: null, items: null, allKey: [], expand: {},
      verdicts: {}, decisions: {}, status: null, override: '', summary: '', edited: false, saved: null, step: 0, visited: { 0: true }, pdfUrl: null };
    qaFlag = 'all'; qaProjEdit = false;
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
// Where Salesforce's address is, looked up once per address: {lat,lon}, null (not found) or false (no lookup here).
const qaGeo = {}, qaGeoBusy = new Set();
async function qaGeoLookup(addr) {
  if (qaGeoBusy.has(addr)) return;
  qaGeoBusy.add(addr);
  let out = false;
  if (qaMode === 'shared') {
    try {
      const r = await fetch('/api/qa-geocode', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qa-password': qaPw() }, body: JSON.stringify({ address: addr }) });
      if (r.status === 200) { const j = await r.json(); out = { lat: j.lat, lon: j.lon }; } else if (r.status === 404) { const j = await r.json().catch(() => null); out = j && j.error === 'no_match' ? null : false; }
    } catch (e) { out = false; }
  }
  qaGeo[addr] = out; qaGeoBusy.delete(addr);
  if (qaRun && qaProjectRow(qaProj) && qaProjectRow(qaProj).address === addr) { qaReeval(true); qaRefresh(); }
}
function qaReeval(full) {
  const run = qaRun; if (!run) return;
  const row = qaProjectRow(qaProj);
  const addr = row ? row.address : null;
  // A battery-only project says so in its survey type, or in the " - Battery Only" on its name.
  const type = row ? (row.survey_type || (/battery only/i.test(row.project || '') ? 'Battery Only Survey' : null)) : null;
  const reopened = !!row && (row.reopened_by_design === '1' || !!row.resurvey_requested);
  const ctx = { sfAddress: addr, sfResource: row ? (row.resource || null) : null, sfSurveyType: type, sfReopened: reopened, checks: qaChecks, sfGeo: addr ? qaGeo[addr] : undefined };
  if (addr && !(addr in qaGeo)) qaGeoLookup(addr);
  run.ctx = ctx;
  run.R = OpsQA.evaluate(run.S, run.specs, ctx);
  if (!full) qaRefresh();
}

// Findings including what a person saw in the photos.
function qaFindings() {
  const run = qaRun; if (!run) return [];
  // A call made on a finding settles it: Good passes it, Bad is a miss at the check's own weight.
  const out = run.R.findings.map(f => {
    if (!qaActionable(f)) return f;
    const k = qaFlagKey(f), d = run.decisions[k], fl = qaIsFlagged(f), base = Object.assign({}, f, { fk: k, fl, orig: f });
    if (!d) return base;
    if (d === 'ok') return Object.assign(base, { status: 'pass', verify: false, decision: d, detail: f.status === 'miss' ? 'Reviewer: fine as is' + (f.detail ? ' (' + f.detail + ')' : '') : f.detail });
    return Object.assign(base, { status: 'miss', verify: false, decision: d, severity: f.severity || 'warn',
      detail: f.status === 'miss' ? f.detail : 'Judged not good' + (fl ? ' from the report' : '') + (f.detail ? ': ' + f.detail : '') });
  });
  for (const it of run.items || []) {
    if (run.verdicts[qaPhotoKey(it)] === 'bad') {
      out.push({ layer: 'P', id: 'photo:' + qaPhotoKey(it), area: 'Photos', status: 'miss', severity: 'hard',
        title: it.label + ' photo not usable', detail: (it.unit ? it.unit + ', ' : '') + 'photo ' + it.n + ' was marked unreadable or wrong', evidence: {} });
    }
  }
  return out;
}
const qaActionable = f => f.status !== 'na' && f.status !== 'gap';
// Flagged items still waiting for ✓ or ✕: what blocks a pass, and what the strip and step 1 count.
const qaUndecided = () => qaRun ? qaRun.R.findings.filter(f => qaIsFlagged(f) && !qaRun.decisions[qaFlagKey(f)]).length : 0;
const qaBase = f => f.orig || f;
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
  _qaStep();
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
// The checks that read each photo category. A photo needs a person's eye when one of
// its category's checks could not be settled from the report, or the image looks soft.
// A list is tried in order: Dead Front Off reads its own row, or the breaker row on a Radicl
// report that cuts both captions to "Dead Front…".
const QA_FIND_CAT = { msp_dead_front_on: 'breaker', main_breaker_rating: 'breaker', msp_label: 'label', meter_closeup: 'meter', roof_pitch: 'pitch', attic_framing: 'framing', roof_overhang: 'eave',
  msp_location: 'location', msp_dead_front_off: ['deadoff', 'breaker'], meter_location: 'meterloc', site_map: 'sitemap',
  attic_photos: 'attic', bus_rating: 'label', service_entrance: 'meterloc' };   // the bus rating is read off the label; overhead or underground shows on the meter wall
const qaCatOf = f => { const c = [].concat(QA_FIND_CAT[f.id] || []); return c.find(x => qaRun && qaRun.items && qaRun.items.some(it => it.id === x)) || c[0] || null; };
// A check that could not be settled asks for the few photos shown beside it on the summary (the
// first three of its category), not all 36 dead-front photos; a decided check asks for none.
const qaNeedsLook = it => !!(qaRun && (it.soft || (it.ai && !it.ai.readable) ||
  (qaRun.R.findings.some(f => qaIsFlagged(f) && !qaRun.decisions[qaFlagKey(f)] && qaCatOf(f) === it.id)
    && qaRun.items.filter(x => x.id === it.id && x.url).slice(0, 3).includes(it))));
// Categories keep their order; inside one, the photos that need a look come first.
function qaOrderItems() {
  const run = qaRun, cats = []; run.items.forEach(it => { if (!cats.includes(it.id)) cats.push(it.id); });
  const rank = it => cats.indexOf(it.id) * 2 + (qaNeedsLook(it) ? 0 : 1);
  run.items = run.items.map((it, n) => [it, n]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
}
async function qaLoadPhotos() {
  const run = qaRun; if (!run) return;
  qaUrls.splice(0).forEach(u => URL.revokeObjectURL(u));
  run.photosSettled = false;
  run.allKey = OpsQA.keyPhotos(run.S, run.spec, { all: true });
  run.items = run.allKey.map(qaWrapPhoto);
  qaOrderItems();
  if (run.step === 0) _qaStep();
  await qaFetchImages(run.items);
  run.photosSettled = true;
  qaOrderItems();                                  // soft photos are known now
  if (run.step === 0) _qaStep();
  _qaPhotoMeta();
  qaVisionRun();
}

// ── Claude photo check (Settings → Site Survey QA) ──
// Advice only: it can pull a photo forward and say why, never mark it.
const QA_VISION_MAX = 30;
const qaVisionOn = () => { try { return !!(S && S.qaVision); } catch (e) { return false; } };
async function qaShrink(url) {
  const img = new Image(); img.src = url; await img.decode();
  const k = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82).split(',')[1];
}
async function qaVisionCall(category, image) {
  let r;
  try { r = await fetch('/api/qa-vision', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qa-password': qaPw() }, body: JSON.stringify({ category, image }) }); }
  catch (e) { return { status: 0, body: null }; }
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
async function qaVisionRun() {
  const run = qaRun; if (!run || !qaVisionOn()) return;
  if (qaMode !== 'shared') { run.vision = { error: 'The Claude photo check needs the team server.' }; return _qaPhotoMeta(); }
  const list = run.items.filter(it => it.url && !it.ai).slice(0, QA_VISION_MAX);
  if (!list.length) return;
  const v = run.vision = { total: list.length, done: 0, flagged: 0, error: '' };
  _qaPhotoMeta();
  let next = 0;
  const worker = async () => {
    while (qaRun === run && !v.error && next < list.length) {
      const it = list[next++];
      try {
        const r = await qaVisionCall(it.id, await qaShrink(it.url));
        if (r.status === 401) { v.error = 'Wrong password'; qaBounce('Wrong password'); break; }
        if (r.status === 503) { v.error = 'Claude is not set up on the server (ANTHROPIC_API_KEY).'; break; }
        if (r.status === 200 && r.body) { it.ai = r.body; if (!r.body.readable) v.flagged++; qaPhotoAi(it); }
      } catch (e) { /* one photo failing does not stop the rest */ }
      v.done++; _qaPhotoMeta();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (qaRun !== run) return;
  qaOrderItems();
  if (run.step === 0) _qaStep();
  _qaPhotoMeta();
}
function qaPhotoAi(it) {
  const i = qaRun.items.indexOf(it); if (!it.ai) return;
  document.querySelectorAll(`.qa-ph[data-i="${i}"]`).forEach(card => {
    const el = card.querySelector('.qa-ph-ai');
    if (el) { el.textContent = (it.ai.readable ? '' : 'Claude: ') + it.ai.note; el.title = 'Claude: ' + it.ai.note; el.className = 'qa-ph-ai ' + (it.ai.readable ? 'good' : 'doubt'); }
    card.classList.toggle('need', !qaRun.verdicts[qaPhotoKey(it)] && qaNeedsLook(it));
  });
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
  for (const it of items) if (!it.url) { const c = document.querySelector(`.qa-ph[data-i="${qaRun.items.indexOf(it)}"] .qa-ph-img`); if (c) { c.classList.remove('loading'); c.textContent = 'Not found in the report'; } }
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
  const need = its.filter(qaNeedsLook).length, v = qaRun.vision;
  const ai = !v ? '' : v.error ? ` ${v.error}` : v.done < v.total ? ` Claude is checking the photos (${v.done} of ${v.total})…` : ` Claude checked ${v.total} photos${v.flagged ? ' and doubts ' + v.flagged : ''}.`;
  return ai && loaded >= its.length ? `${its.length} of ${qaRun.S.photos.length} photos, the ones that decide the checks.${ai}${need ? ` ${need} with a yellow border need your call.` : ''}` : loaded < its.length && !qaRun.photosSettled ? `Loading photos ${loaded} of ${its.length}…`
    : `${its.length} of ${qaRun.S.photos.length} photos, the ones that decide the checks.${need ? ` ${need} with a yellow border need your call: ✓ if it does the job, ✕ if it doesn't.` : ' Mark one ✓ or ✕ only if you checked it.'}`;
}
function _qaPhotoMeta() {
  const sub = document.getElementById('qa-ph-sub'); if (sub) sub.textContent = qaPhotoSub();
  const q = document.getElementById('qa-quality'); if (q) q.innerHTML = qaQualityHtml();
}
function qaPhotoReady(it) {
  const i = qaRun.items.indexOf(it);
  document.querySelectorAll(`.qa-ph[data-i="${i}"]`).forEach(card => {
    const box = card.querySelector('.qa-ph-img');
    box.classList.remove('empty', 'loading'); box.setAttribute('role', 'button'); box.tabIndex = 0; box.setAttribute('onclick', `qaZoom(${i})`);
    box.innerHTML = `<img src="${it.url}" alt="${qaH(it.label)}">`;
    const cap = card.querySelector('.qa-ph-cap'); cap.innerHTML = qaPhotoCap(it); cap.title = qaPhotoTip(it);
    card.classList.toggle('need', !qaRun.verdicts[qaPhotoKey(it)] && qaNeedsLook(it));
  });
  qaRowsSoon(); _qaPhotoMeta();
}
// Radicl numbers its panels "1", "in1", "out1"; Site Capture names them (MSP, SP1, MP2).
const qaUnitName = u => !u ? '' : /^\d+$/.test(u) ? 'Panel ' + u : /^(in|out)\d+$/.test(u) ? (u[0] === 'i' ? 'Inside ' : 'Outside ') + u.replace(/\D/g, '') : u;
// The row header names the category, so a card names only its panel or plane and the photo;
// where the picture came from is in the hover text and the zoom.
const qaPhotoCap = it => `${it.unit ? `<b>${qaH(qaUnitName(it.unit))}</b> · photo ${it.n}` : `Photo ${it.n}`}${it.soft ? ' · soft' : ''}`;
const qaPhotoTip = it => [it.label, qaUnitName(it.unit), 'photo ' + it.n, it.url ? (it.from === 'Original' ? 'original from the photo export' : 'cut from the report') : ''].filter(Boolean).join(' · ');

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
    <span class="qa-title">Site Survey QA</span>
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
  el.innerHTML = qaMode === 'checking' ? '' : qaMode === 'down' ? `<span class="qa-conn" title="${qaH(qaNote)}"><span class="qa-sw hard"></span>History offline</span>`
    : `<span class="qa-conn" title="${qaMode === 'local' ? qaH(qaNote) : 'Reviews saved by the whole team'}">${qaMode === 'local' ? '<span class="qa-sw warn"></span>' : ''}${qaPlural(n, 'review')}${qaMode === 'local' ? ' · this browser only' : ''}</span>`;
}

// ── Review view ────────────────────────────────────
function _qaReview() {
  const host = document.getElementById('qa-body'); if (!host) return;
  host.innerHTML = `<div id="qa-dup"></div><div class="sec qa-intake" id="qa-intake"></div><div id="qa-likely"></div><div id="qa-run"></div>`;
  _qaIntake(); _qaDup();
  if (qaRun) _qaFlow(); else _qaLikely();
}
// A report someone has already reviewed — a colleague included — is flagged
// before it is reviewed twice.
function _qaDup() {
  const host = document.getElementById('qa-dup'); if (!host) return;
  const dup = qaRun && !qaRun.saved && qaLoad().find(r => r.file && r.file.hash === qaRun.file.hash);
  const local = qaMode === 'local' ? `<div class="qa-banner qa-banner-info"><span>${qaH(qaNote)} Reviews you save stay on this computer.</span></div>`
    : qaMode === 'down' ? `<div class="qa-banner"><span>${qaH(qaNote)} You can keep reviewing; Save tries again.</span></div>` : '';
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
  // Show everything unless the list is long; a "Show all" that reveals one more card is not worth a click.
  const all = qaLikely(), list = qaLikelyAll || all.length <= 18 ? all : all.slice(0, 12), log = qaLoad();
  if (!all.length) { host.innerHTML = ''; return; }
  const sel = qaProj.trim().toUpperCase();
  const reviews = p => log.filter(x => x.project === p.toUpperCase()).length;
  // Grouped by how long it has been waiting, so the late ones stand out.
  const groups = [['Today', x => x.ago === 0], ['Yesterday', x => x.ago === 1], ['Earlier', x => x.ago > 1]];
  const card = x => {
    const n = reviews(x.r.project), on = sel && sel === x.r.project.toUpperCase();
    return `<button class="qa-lk${on ? ' on' : ''}" data-p="${qaH(x.r.project)}" onclick="qaPickProject(this.dataset.p)">
      <span class="qa-lk-p">${qaH(x.r.project)}</span>
      <span class="qa-lk-a">${qaH((x.r.address || '').replace(/,?\s*[A-Z]{2}\s+\d{5}.*$/, '') || 'no address')}</span>
      <span class="qa-lk-m">${x.r.resource === 'Radicl Services' ? 'Radicl' : 'SunPower'}${x.ago > 1 ? ' · ' + x.ago + ' days ago' : ''}${n ? ` · reviewed ${n}×` : ''}</span></button>`;
  };
  host.innerHTML = `<div class="sec"><div class="shead"><div><div class="stitle">Expected surveys</div>
    <div class="ssub">${qaPlural(all.length, 'survey')} booked for today or earlier and not complete in Salesforce. Pick one, then upload its report.</div></div></div>
    ${groups.map(([label, test]) => { const g = list.filter(test); return g.length ? `<div class="qa-lk-h">${label}<span>${g.length}</span></div><div class="qa-likely">${g.map(card).join('')}</div>` : ''; }).join('')}
    ${all.length > list.length || (qaLikelyAll && all.length > 18) ? `<div class="tbl-foot"><button class="copy-btn" onclick="qaLikelyAll=!qaLikelyAll;_qaLikely()">${qaLikelyAll ? 'Show fewer' : 'Show all ' + all.length}</button></div>` : ''}</div>`;
}
function qaPickProject(p) {
  if (qaRun) return;
  if (qaProj.trim().toUpperCase() === p.toUpperCase()) { qaProj = ''; }
  else {
    qaProj = p;
    const r = qaProjectRow(p);
    if (r && r.resource) { qaVendor = r.resource === 'Radicl Services' ? 'radicl' : 'sitecapture'; try { localStorage.setItem('ops_qa_vendor', qaVendor); } catch (e) {} }
  }
  _qaIntake(); _qaLikely(); _qaBar();
  if (qaProj) { const f = document.getElementById('qa-intake'); if (f) f.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}

function qaStatusPill(s) {
  const cls = s === 'Passed' ? 'pg' : s === 'Failed - Gaps Found' ? 'pr' : s === 'Passed with Override' ? 'pam' : 'qa-pill-mute';
  return `<span class="pill ${cls}">${qaH(s || 'Not started')}</span>`;
}

// ── The flow: photo review, then the verdict ──
const QA_STEPS = ['Photo review', 'Verdict'];
function _qaFlow() {
  const host = document.getElementById('qa-run'); if (!host) return;
  host.innerHTML = `<div class="sec qa-flow"><div class="qa-steps" id="qa-steps"></div><div class="qa-strip" id="qa-strip"></div><div class="qa-body" id="qa-step"></div><div class="qa-nav" id="qa-nav"></div></div>`;
  if (!qaRun.edited) qaRun.summary = qaSummaryText();
  _qaSteps(); _qaStrip(); _qaStep(); _qaNav();
}
function _qaSteps() {
  const host = document.getElementById('qa-steps'); if (!host || !qaRun) return;
  // Step 1 is not done while a flagged item waits for a call; it shows how many instead of a tick.
  const open = qaUndecided();
  host.innerHTML = QA_STEPS.map((l, i) => {
    const on = qaRun.step === i, left = i === 0 && open && !on, done = qaRun.visited[i] && !on && !left;
    // The count sits after the title as a pill, so it never reads as a step number.
    return `<button class="qa-stepbtn${on ? ' on' : ''}${done ? ' done' : ''}" onclick="qaGo(${i})"><span class="qa-stepn">${done ? '✓' : i + 1}</span><span class="qa-stepl">${l}</span>${left ? `<span class="qa-stepbadge">${open} to decide</span>` : ''}</button>`;
  }).join('');
}
function qaGo(i) {
  const run = qaRun; if (!run) return;
  const was = run.step;
  run.step = Math.max(0, Math.min(QA_STEPS.length - 1, i)); run.visited[run.step] = true;
  _qaSteps(); _qaStep(); _qaNav();
  const b = document.getElementById('qa-step');
  if (b && was !== run.step) { b.classList.remove('enter'); void b.offsetWidth; b.classList.add('enter'); }
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
    <span><b>${c.missHard}</b> hard ${c.missHard === 1 ? 'miss' : 'misses'}</span><span><b>${c.missWarn}</b> to review</span>${qaUndecided() ? `<span class="open"><b>${qaUndecided()}</b> to decide</span>` : ''}<span><b>${c.gap + c.standingGaps}</b> not in template</span><span><b>${qaRun.S.photos.length}</b> photos</span>
    <span class="sp"><button onclick="qaViewPdf(1)">View report PDF</button><button class="qa-startover" onclick="qaStartOver()">${qaRun.saved ? 'New review' : 'Start over'}</button></span>`;
}
function _qaStep() {
  const host = document.getElementById('qa-step'); if (!host || !qaRun) return;
  [_qaReviewStep, _qaVerdictStep][qaRun.step](host);
}

// Step 1 — what we found
// What needs a person comes first: misses, then what to look at, then what passed. What the
// template cannot capture is no one's to fix on this survey, so it closes the list.
const QA_GROUPS = [
  { k: 'all', l: 'All', sw: '', f: x => x.status !== 'na' },
  { k: 'miss', l: 'Missing', sw: 'hard', f: x => qaBase(x).status === 'miss' && !x.fl },
  { k: 'verify', l: 'Look at', sw: 'look', f: x => !!x.fl },
  { k: 'pass', l: 'Passed', sw: 'pass', f: x => qaBase(x).status === 'pass' && !qaBase(x).verify && !x.fl },
  { k: 'gap', l: 'Not in template', sw: 'gap', f: x => x.status === 'gap', note: 'The template has no field for these, so no survey on it can have them. They are not the surveyor’s miss.' },
];
function qaSortFindings(a, b) {
  const rank = f0 => { const f = qaBase(f0); return f0.fl ? 2 : f.status === 'miss' ? (f.severity === 'hard' ? 0 : 1) : f.status === 'gap' ? 4 : f.status === 'verify' || f.verify ? 2 : 3; };
  return rank(a) - rank(b) || String(a.area).localeCompare(String(b.area));
}
function qaSetFlag(k) { qaFlag = k; _qaStep(); }
// A second look after a go back: what the last review for this project found, and whether this
// report fixes it. Matched by check id; a repeat of the same miss reads as still open.
function qaPrior() {
  const id = qaProj.trim().toUpperCase(); if (!id || !qaRun) return null;
  const prev = qaLoad().filter(r => r.project === id && r.id !== qaRun.saved && r.findings).sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')))[0];
  return prev || null;
}
function qaGoBackHtml() {
  const prev = qaPrior(); if (!prev) return '';
  const misses = prev.findings.filter(f => f.status === 'miss' && !f.standing); if (!misses.length) return '';
  const now = qaFindings(), still = f => now.some(x => x.id === f.id && x.status === 'miss' && (!/^tpl:/.test(f.id) || x.title === f.title));
  const open = misses.filter(still), fixed = misses.filter(f => !still(f));
  const line = (f, ok) => `<div class="qa-gb-row"><span class="qa-mk ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✕'}</span> ${qaH(f.title)}${f.detail ? ` <span class="qa-gb-d">${qaH(f.detail)}</span>` : ''}</div>`;
  return `<div class="qa-banner qa-banner-info qa-gb"><div><b>Go back review.</b> Last review (${qaH(qaDate(prev))}, ${qaH(prev.status)}) found ${qaPlural(misses.length, 'miss')}: ${fixed.length} fixed, ${open.length} still open.
    ${open.map(f => line(f, false)).join('')}${fixed.map(f => line(f, true)).join('')}</div></div>`;
}

// A photo or two the check was judged from, so a Pass can be seen as well as read.
function qaEvidenceIdx(f) {
  const cat = qaCatOf(f), its = qaRun.items; if (!cat || !its) return [];
  const idx = []; its.forEach((it, i) => { if (it.id === cat && it.url && idx.length < 3) idx.push(i); });
  return idx;
}
function qaEvidence(f) {
  const idx = qaEvidenceIdx(f), its = qaRun.items;
  return idx.length ? `<span class="qa-ev">${idx.map(i => { const v = qaRun.verdicts[qaPhotoKey(its[i])]; return `<button class="qa-ev-th${v ? ' ' + v : ''}" title="Open this photo" onclick="qaZoom(${i})"><img src="${its[i].url}" alt=""></button>`; }).join('')}</span>` : '';
}
// What the row says right now: the reviewer's own call, else what the photo marks in its category say.
function qaRowState(f) {
  const d = qaRun.decisions[f.fk]; if (d) return d;
  const cat = qaCatOf(f); if (!cat || !qaRun.items) return null;
  const vs = qaRun.items.filter(it => it.id === cat).map(it => qaRun.verdicts[qaPhotoKey(it)]).filter(Boolean);
  return vs.includes('bad') ? 'bad' : vs.includes('ok') ? 'ok' : null;
}
// The photo categories a check rests on that this report has photos for.
function qaCatsOf(f) { const c = [].concat(QA_FIND_CAT[f.id] || []); return c.filter(x => qaRun.items && qaRun.items.some(it => it.id === x)); }
const qaOpenRows = () => qaRun.open || (qaRun.open = {});
const qaActs = () => qaRun.R.findings.filter(qaActionable);
const qaFindingAt = fi => { const a = qaActs()[fi]; return a && qaFindings().find(x => x.fk === qaFlagKey(a)); };
// One line: caret · dot · the check and its PDF link · what was found or is missing · thumbnails · the call.
function qaRowInner(f, fi, open) {
  const sw = f.status === 'miss' ? (f.severity === 'hard' ? 'hard' : 'warn') : f.status === 'gap' ? 'gap' : f.status === 'verify' || f.verify ? 'look' : 'pass';
  const dim = f.status === 'pass' && !f.verify, has = fi >= 0 && qaCatsOf(f).length > 0;
  const link = f.page ? `<button class="qa-link" onclick="qaViewPdf(${f.page})">PDF p.${f.page}</button>` : f.fl ? `<button class="qa-link" onclick="qaViewPdf(1)">Open report PDF</button>` : '';
  return `<div class="qa-find${dim ? ' pass' : ''}${has ? ' xp' : ''}${open ? ' open' : ''}"${has ? ` onclick="qaRowClick(event,${fi})" role="button" aria-expanded="${!!open}" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();qaToggleRow(${fi});}"` : ''}>
    <span class="qa-caret">${has ? '›' : ''}</span><span class="qa-sw ${sw}"></span>
    <div class="t">${qaH(f.title)}${f.status === 'gap' ? ' <span class="qa-tag">not in template</span>' : ''}${link ? ' &nbsp;' + link : ''}</div>
    <div class="d">${qaH(f.detail || f.note || f.found || (dim ? 'OK' : ''))}</div>
    <div class="ev">${qaEvidence(f)}</div>
    <div class="act">${fi >= 0 ? qaDecideHtml(fi, qaRowState(f)) : ''}</div></div>`;
}
// The photos behind a check, large enough to judge, each with its own call.
function qaPanelHtml(f) {
  return `<div class="qa-find-x">${qaCatsOf(f).map(c => { const its = qaRun.items.map((it, i) => [it, i]).filter(([it]) => it.id === c);
    return `<div class="qa-photos-h"><span>${qaH(its[0][0].label)}</span>${QA_REFS[c] ? `<button class="qa-link" onclick="qaZoom(${its[0][1]})">Compare with an example</button>` : ''}</div>
      <div class="qa-photos">${its.map(([it, i]) => qaPhotoCardHtml(it, i)).join('')}</div>`; }).join('')}</div>`;
}
function qaRowHtml(f, fi) {
  const open = fi >= 0 && qaCatsOf(f).length > 0 && !!qaOpenRows()[fi];
  return `<div class="qa-fr" data-fi="${fi}">${qaRowInner(f, fi, open)}${open ? qaPanelHtml(f) : ''}</div>`;
}
function qaRowClick(e, fi) { if (e.target.closest('button,a,.qa-decide,.qa-ev')) return; qaToggleRow(fi); }
function qaToggleRow(fi) {
  const o = qaOpenRows(); o[fi] = !o[fi];
  const el = document.querySelector(`.qa-fr[data-fi="${fi}"]`), f = qaFindingAt(fi);
  if (el && f) el.outerHTML = qaRowHtml(f, fi);
  _qaExpandBtn();
}
// Every row that has photos, open or shut together; a second press shuts them.
function qaPhotoRows() { const acts = qaActs(); return qaFindings().filter(f => f.fk).map(f => acts.findIndex(a => qaFlagKey(a) === f.fk)).filter(fi => fi >= 0 && qaCatsOf(qaFindingAt(fi)).length); }
function qaExpandAll() {
  const fis = qaPhotoRows(), o = qaOpenRows(), all = fis.every(fi => o[fi]);
  fis.forEach(fi => { o[fi] = !all; });
  const y = window.scrollY; _qaStep(); window.scrollTo(0, y);
}
function _qaExpandBtn() {
  const b = document.getElementById('qa-expand-all'); if (!b || !qaRun) return;
  const fis = qaPhotoRows(), o = qaOpenRows(), all = fis.length && fis.every(fi => o[fi]);
  b.textContent = all ? 'Collapse all' : 'Expand all'; b.hidden = !fis.length;
}
// After a call or a mark: redraw the lines, not the page, so open photos and scroll stay put.
function qaRefreshRows() {
  const run = qaRun; if (!run) return;
  const byK = {}; qaFindings().forEach(f => { if (f.fk) byK[f.fk] = f; });
  const acts = qaActs();
  document.querySelectorAll('.qa-fr[data-fi]').forEach(el => {
    const fi = +el.dataset.fi; if (fi < 0 || !acts[fi]) return;
    const f = byK[qaFlagKey(acts[fi])], row = el.querySelector(':scope > .qa-find'); if (!f || !row) return;
    row.outerHTML = qaRowInner(f, fi, !!qaOpenRows()[fi] && qaCatsOf(f).length > 0);
  });
  const flagged = run.R.findings.filter(qaIsFlagged), sub = document.getElementById('qa-rep-sub');
  if (sub) sub.textContent = qaReportSub(flagged.length, flagged.filter(x => !run.decisions[qaFlagKey(x)]).length);
}
let qaRowsTimer = 0;
const qaRowsSoon = () => { if (!qaRowsTimer) qaRowsTimer = requestAnimationFrame(() => { qaRowsTimer = 0; if (qaRun && qaRun.step === 0) qaRefreshRows(); }); };
function _qaReviewStep(host) {
  const all = qaFindings(), run = qaRun;
  const counts = {}; QA_GROUPS.forEach(g => { counts[g.k] = all.filter(g.f).length; });
  if (!qaFlag || (qaFlag !== 'all' && !counts[qaFlag])) qaFlag = 'all';
  const g = QA_GROUPS.find(x => x.k === qaFlag);
  const rows = all.filter(g.f).sort(qaSortFindings);
  const S = run.S, det = run.det;
  const acts = qaActs(), flagged = run.R.findings.filter(qaIsFlagged), left = flagged.filter(f => !run.decisions[qaFlagKey(f)]).length;
  const sub = [QA_TEMPLATE_NAMES[det.specId] || det.reason, det.partial ? 'Partial survey (a go back)' : '', S.meta.surveyor, S.meta.assessmentDate || S.meta.surveyDate].filter(Boolean).join(' · ');
  host.innerHTML = `<div class="qa-lede">${qaH(sub)}</div>
    ${qaGoBackHtml()}
    ${flagged.length ? `<div class="qa-lede" id="qa-rep-sub">${qaReportSub(flagged.length, left)}</div>` : ''}
    <div class="qa-lede" id="qa-ph-sub">${qaPhotoSub()}</div><div id="qa-quality">${qaQualityHtml()}</div>
    <div class="qa-chips">${QA_GROUPS.filter(x => x.k === 'all' || counts[x.k]).map(x => `<button class="qa-chip${qaFlag === x.k ? ' on' : ''}" aria-pressed="${qaFlag === x.k}" onclick="qaSetFlag('${x.k}')">${x.sw ? `<span class="qa-sw ${x.sw}"></span>` : ''}${x.l}<span class="qa-chip-n">${counts[x.k]}</span></button>`).join('')}
      <button class="fbtn qa-expand-all" id="qa-expand-all" onclick="qaExpandAll()">Expand all</button></div>
    ${g.note ? `<div class="qa-lede">${qaH(g.note)}</div>` : ''}
    ${rows.length ? rows.map(f => qaRowHtml(f, f.fk ? acts.findIndex(x => qaFlagKey(x) === f.fk) : -1)).join('') : `<div class="qa-empty">Nothing here.</div>`}`;
  _qaExpandBtn();
}
const qaReportSub = (n, left) => left ? `${qaPlural(n, 'item')} to check against the report or photos. ${left} left to decide: ✓ if it is fine, ✕ if it is a miss.` : 'Every flagged item is decided. Anything marked ✕ is now a miss.';
const qaDecideHtml = (i, d) => `<span class="qa-decide"><button class="ok${d === 'ok' ? ' on' : ''}" title="Good" aria-label="Good" onclick="qaDecide(${i},'ok')">✓</button><button class="bad${d === 'bad' ? ' on' : ''}" title="Bad" aria-label="Bad" onclick="qaDecide(${i},'bad')">✕</button></span>`;
function qaDecide(i, v) {
  const run = qaRun, f = qaActs()[i]; if (!f) return;
  const k = qaFlagKey(f), was = run.decisions[k];
  if (was === v) delete run.decisions[k]; else run.decisions[k] = v;
  // Good on a check that rests on photos also marks the photos beside it good, so
  // the two views agree. A bad call is the check's, not the photos': the photos stay as marked.
  if (v === 'ok') for (const n of qaEvidenceIdx(f)) {
    const pk = qaPhotoKey(run.items[n]);
    if (was === 'ok') { if (run.verdicts[pk] === 'ok') delete run.verdicts[pk]; } else if (!run.verdicts[pk]) run.verdicts[pk] = 'ok';
  }
  if (!run.edited) run.summary = qaSummaryText();
  qaCardsSync(); qaRefreshRows();
  _qaSteps(); _qaStrip(); _qaSaveBtn();
}

// Step 2 — the photos
// A good example of each category, from Doug's Site Survey Guide or, where the guide's picture
// is not legible or there is none, a clear photo from a past survey (the image says which).
// They sit beside the survey's photo in the zoom.
const QA_REFS = {
  breaker: { what: 'A picture of the main breaker, with its rating readable.', why: 'The main breaker is the largest breaker and shuts off the whole panel. Its rating tells Design how the solar system ties into the grid.',
    imgs: [{ src: 'qa/ref/breaker.jpg', cap: 'Panel with the dead front on' }, { src: 'qa/ref/breaker-rating.jpg', cap: 'Rating on the breaker handle' }] },
  label: { what: 'A picture of the label on the main service panel, clear enough to read the text.', why: 'It shows what the bus bar is rated for and which parts are allowed inside the panel. The text has to be legible.',
    imgs: [{ src: 'qa/ref/label.jpg', cap: 'Whole label, every line readable', from: 'a past SunPower survey' },
      { src: 'qa/ref/label-rating.jpg', cap: 'Main ratings close up: 200 A max', from: 'a past Radicl survey' }] },
  sitemap: { what: 'A top-down map of the house with every mounting plane numbered, the pitch of each, north, and where the meter, main panel and attic access are.', why: 'Design lays out the array from it and finds the equipment by it. A site map of the wrong house means a resurvey.',
    imgs: [{ src: 'qa/ref/sitemap.jpg', cap: 'Digital: planes and equipment marked on an aerial', from: 'a past SunPower survey' },
      { src: 'qa/ref/sitemap-sketch.jpg', cap: 'Handwritten: planes, pitch, sizes and north on grid paper', from: 'a past Radicl survey' }] },
  location: { what: 'The whole wall the panel is on, floor to ceiling and corner to corner, so the panel can be seen in its room.', why: 'Design plans the conduit run and the clearances from it, and decides whether new equipment fits beside the panel.',
    imgs: [{ src: 'qa/ref/location.jpg', cap: 'Inside: the whole wall around the panel', from: 'a past SunPower survey' },
      { src: 'qa/ref/location-outside.jpg', cap: 'Outside: panel and meter with what surrounds them', from: 'a past Radicl survey' }] },
  deadoff: { what: 'The panel with its cover off, top to bottom in one shot, then the main lugs and terminations close enough to see the wire.', why: 'Design checks for room to land new breakers or taps, and for double taps or damage that would hold up the install.',
    imgs: [{ src: 'qa/ref/deadoff.jpg', cap: 'Full panel, cover off', from: 'a past SunPower survey' },
      { src: 'qa/ref/deadoff-lugs.jpg', cap: 'Main lugs and terminations', from: 'a past Radicl survey' }] },
  meterloc: { what: 'The whole side of the house the meter is on, with the meter, any disconnect, the conduit and whatever sits in front of it.', why: 'Design places the new equipment on that wall and checks the clearances in front of the meter.',
    imgs: [{ src: 'qa/ref/meter-location.jpg', cap: 'The meter wall and what is near it', from: 'a past SunPower survey' }] },
  meter: { what: 'A close-up of the meter face showing the numbers.', why: 'The plan reviewer matches the meter number to the utility bill so net metering lands on the right home. It also shows which utility owns the meter. Colorado Springs Utilities also needs a photo with a tape from the ground to the center of the glass.',
    imgs: [{ src: 'qa/ref/meter.jpg', cap: 'Meter number readable' }] },
  framing: { what: 'A measurement of the rafter size, and of how far apart the rafters are. The tape or the Measure app has to be in the shot.', why: 'The structural engineer needs 2x4, 2x6 or 2x8, and the spacing (12, 18, 24, 30 or 36 inches).',
    imgs: [{ src: 'qa/ref/framing.jpg', cap: 'Rafter size with a tape' }, { src: 'qa/ref/framing-spacing.jpg', cap: 'Spacing: the next rafter at 24"', from: 'a past SunPower survey' }] },
  attic: { what: 'The whole attic over each mounting plane: every rafter or truss, the supports and the decking, in photos that overlap.', why: 'The structural engineer checks the framing can carry the array, and looks for damage, sagging or anything in the way.',
    imgs: [{ src: 'qa/ref/attic.jpg', cap: 'Trusses, plates and decking in one shot', from: 'a past SunPower survey' },
      { src: 'qa/ref/attic-radicl.jpg', cap: 'Down the length of the attic', from: 'a past Radicl survey' }] },
  pitch: { what: 'The roof pitch, readable from the photo.', why: 'Design models the roof from the pitch. A number nobody can read has to be re-shot.', from: 'a past Radicl report',
    imgs: [{ src: 'qa/ref/pitch.jpg', cap: 'Pitch readable in the photo' }] },
  eave: { what: 'The overhang measured with a tape against the eave.', why: 'Design needs the overhang to place the array against the roof edge. The tape and the numbers have to be in frame.', from: 'a past Radicl report',
    imgs: [{ src: 'qa/ref/eave.jpg', cap: 'Overhang measured with a tape' }] },
};
const qaMarkBtns = (i, v) => `<button class="ok${v === 'ok' ? ' on' : ''}" title="Good" aria-label="Mark good" onclick="qaVerdict(${i},'ok')">✓</button><button class="bad${v === 'bad' ? ' on' : ''}" title="Not usable" aria-label="Mark not usable" onclick="qaVerdict(${i},'bad')">✕</button>`;
function qaPhotoCardHtml(it, i) {
  const v = qaRun.verdicts[qaPhotoKey(it)];
  return `<div class="qa-ph${v ? ' ' + v : qaNeedsLook(it) ? ' need' : ''}" data-i="${i}">
    <div class="qa-ph-img${it.url ? '' : qaRun.photosSettled ? ' empty' : ' empty loading'}"${it.url ? ` onclick="qaZoom(${i})" role="button" tabindex="0"` : ''}>${it.url ? `<img src="${it.url}" alt="${qaH(it.label)}">` : qaRun.photosSettled ? 'Not found in the report' : ''}</div>
    <div class="qa-ph-cap" title="${qaH(qaPhotoTip(it))}">${qaPhotoCap(it)}</div>
    <div class="${it.ai ? 'qa-ph-ai ' + (it.ai.readable ? 'good' : 'doubt') : 'qa-ph-ai'}" title="${it.ai ? 'Claude: ' + qaH(it.ai.note) : ''}">${it.ai ? (it.ai.readable ? '' : 'Claude: ') + qaH(it.ai.note) : ''}</div>
    <div class="qa-ph-btns">${qaMarkBtns(i, v)}</div></div>`;
}
// Every open photo card agrees with the marks, wherever the same photo is shown.
function qaCardsSync() {
  document.querySelectorAll('.qa-ph[data-i]').forEach(card => {
    const it = qaRun.items[+card.dataset.i]; if (!it) return;
    const cur = qaRun.verdicts[qaPhotoKey(it)];
    card.className = 'qa-ph' + (cur ? ' ' + cur : qaNeedsLook(it) ? ' need' : '');
    card.querySelectorAll('.qa-ph-btns button').forEach(b => b.classList.toggle('on', b.classList.contains(cur)));
  });
}
function qaVerdict(i, v) {
  const it = qaRun.items[i], k = qaPhotoKey(it);
  qaRun.verdicts[k] = qaRun.verdicts[k] === v ? null : v;
  // Update the cards in place: rebuilding the grid reloads every image.
  qaCardsSync();
  const mk = document.getElementById('qa-lb-marks'); if (mk && qaZoomAt === i) mk.innerHTML = qaMarkBtns(i, qaRun.verdicts[k]);
  // A photo mark shows on the lines that rest on its category.
  if (qaRun.step === 0) qaRefreshRows();
  if (!qaRun.edited) qaRun.summary = qaSummaryText();
  _qaSteps(); _qaStrip(); _qaSaveBtn();
}
let qaZoomAt = -1, qaRefAt = 0;
// Magnify a photo inside the zoom: click it (or the magnifier) to go in, move to look around,
// scroll to change how far, click again to come out. Changing photo starts from the whole picture.
const qaMagBtn = '<button class="qa-mag-btn" title="Zoom in" aria-label="Zoom in" onclick="qaMagToggle(event,this)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/></svg></button>';
function qaMagToggle(e, el) {
  e.stopPropagation();
  const st = el.closest('.qa-lb-stage'), on = !st.classList.contains('mag');
  st.classList.toggle('mag', on); st.dataset.z = st.dataset.z || 2.5;
  const img = st.querySelector('img');
  if (on) qaMagMove(e, st); else { img.style.transform = ''; img.style.transformOrigin = ''; }
}
function qaMagMove(e, st) {
  if (!st.classList.contains('mag')) return;
  const r = st.getBoundingClientRect(), img = st.querySelector('img');
  img.style.transformOrigin = `${Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100))}% ${Math.max(0, Math.min(100, (e.clientY - r.top) / r.height * 100))}%`;
  img.style.transform = `scale(${st.dataset.z || 2.5})`;
}
function qaMagWheel(e, st) {
  if (!st.classList.contains('mag')) return;
  e.preventDefault();
  st.dataset.z = Math.max(1.5, Math.min(8, (+st.dataset.z || 2.5) + (e.deltaY < 0 ? 0.5 : -0.5)));
  qaMagMove(e, st);
}
function qaZoom(i) {
  const run = qaRun, items = run && run.items, it = items && items[i]; if (!it || !it.url) return;
  if (qaZoomAt >= 0 && items[qaZoomAt] && items[qaZoomAt].id !== it.id) qaRefAt = 0;
  qaZoomAt = i;
  let lb = document.getElementById('qa-lb');
  if (!lb) { lb = document.createElement('div'); lb.id = 'qa-lb'; lb.className = 'qa-lb hidden'; lb.onclick = qaZoomClose; document.body.appendChild(lb); }
  const ready = items.map((x, k) => x.url ? k : -1).filter(k => k >= 0), pos = ready.indexOf(i);
  const ref = QA_REFS[it.id], at = ref ? Math.min(qaRefAt, ref.imgs.length - 1) : 0, img = ref && ref.imgs[at];
  // Both photos sit in a stage of one fixed size, so changing photo or example never moves the page around them.
  lb.innerHTML = `<button class="qa-lb-close" onclick="qaZoomClose()">Close</button>
    <div class="qa-lb-main" onclick="event.stopPropagation()"><div class="qa-lb-cols${ref ? ' two' : ''}">
      <div class="qa-lb-col mine"><div class="qa-lb-head"><span class="qa-lb-tag">This survey</span><span class="qa-lb-sub">${qaH(it.label)}${it.unit ? ' · ' + qaH(it.unit) : ''} · photo ${it.n}${ready.length > 1 ? ` · ${pos + 1} of ${ready.length}` : ''}</span></div>
        <div class="qa-lb-stage" onmousemove="qaMagMove(event,this)" onwheel="qaMagWheel(event,this)"><img src="${it.url}" alt="" onclick="qaMagToggle(event,this)">${qaMagBtn}</div>
        <div class="qa-lb-foot mine"><span class="qa-lb-marks" id="qa-lb-marks">${qaMarkBtns(i, run.verdicts[qaPhotoKey(it)])}</span>
          ${it.ai ? `<span class="qa-lb-cap">Claude: ${qaH(it.ai.note)}</span>` : ''}</div></div>
      ${ref ? `<div class="qa-lb-col ref"><div class="qa-lb-head"><span class="qa-lb-tag ex">Example</span><span class="qa-lb-sub">${qaH(img.cap)}${ref.from ? ` (from ${qaH(ref.from)})` : ''}</span>
          ${ref.imgs.length > 1 ? `<span class="qa-lb-tabs">${ref.imgs.map((x, k) => `<button class="${k === at ? 'on' : ''}" onclick="qaRefPick(${k})">${k + 1}</button>`).join('')}</span>` : ''}</div>
        <div class="qa-lb-stage" onmousemove="qaMagMove(event,this)" onwheel="qaMagWheel(event,this)"><img src="${qaH(img.src)}" alt="" onclick="qaMagToggle(event,this)">${qaMagBtn}</div>
        <div class="qa-lb-foot right"><div class="qa-lb-desc">
          <p><b>What it should show</b>${qaH(ref.what)}</p><p><b>Why Design needs it</b>${qaH(ref.why)}</p></div></div></div>` : ''}
    </div></div>`;
  lb.classList.remove('hidden');
}
function qaRefPick(k) { qaRefAt = k; qaZoom(qaZoomAt); }
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

// Step 3 — the verdict: the summary Salesforce receives, and the status
function qaSetSummary(v) { qaRun.summary = v; qaRun.edited = true; const n = document.getElementById('qa-sum-n'); if (n) n.textContent = v.length + ' characters'; _qaSaveBtn(); }
function qaResetSummary() { qaRun.edited = false; qaRun.summary = qaSummaryText(); _qaStep(); }

// The status, then save, then the Salesforce fields
function qaToday() { const d = new Date(); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; }
function qaRecordId() { if (qaRun && qaRun.saved) return qaRun.saved; const p = (qaProj.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'REPORT'); return `QA-${p}-${qaReviewNumber()}`; }
function qaRecordLink(id) { return location.origin + location.pathname + '#qa?r=' + encodeURIComponent(id); }
// Changes the buttons where they are: rebuilding the step on every click is what made them flicker and lose the caret.
function qaSetStatus(s) {
  const run = qaRun; run.status = run.status === s ? null : s;
  if (run.step !== 1) return qaRefresh();
  const rec = qaOutcome().suggestedStatus;
  document.querySelectorAll('.qa-stbtn').forEach(b => { const n = b.dataset.s; b.classList.toggle('on', run.status === n); b.classList.toggle('rec', rec === n && run.status !== n); });
  const ov = document.getElementById('qa-override'); if (ov) { ov.hidden = run.status !== 'Passed with Override'; if (!ov.hidden) ov.focus(); }
  if (!run.edited) { run.summary = qaSummaryText(); const ta = document.getElementById('qa-summary'); if (ta) ta.value = run.summary; const n = document.getElementById('qa-sum-n'); if (n) n.textContent = run.summary.length + ' characters'; }
  _qaStrip(); _qaSaveBtn();
}
function qaSetOverride(v) { qaRun.override = v; if (!qaRun.edited) qaRun.summary = qaSummaryText(); _qaSaveBtn(); }

// The photos a person marked: the rest were not individually reviewed.
function qaPhotoRec() {
  const run = qaRun, its = run.items || [];
  const marks = its.filter(it => run.verdicts[qaPhotoKey(it)]).map(it => ({ k: it.id, label: it.label, unit: it.unit || '', n: it.n, m: run.verdicts[qaPhotoKey(it)] }));
  return { total: its.length, ok: marks.filter(x => x.m === 'ok').length, bad: marks.filter(x => x.m === 'bad').length, marks };
}
// What a saved review is compared with to tell whether there is anything to save.
function qaSnap() {
  const run = qaRun; if (!run) return '';
  return JSON.stringify([run.status, run.status === 'Passed with Override' ? run.override.trim() : '', run.summary, run.verdicts,
    qaFindings().filter(f => f.status !== 'na').map(f => [f.id, f.status, f.detail || ''])]);
}
function qaSaveBlock() {
  const run = qaRun; if (!run) return '';
  if (!qaProj.trim()) return 'Add the project ID before saving';
  if (!run.status) return 'Choose a review status';
  if (!(qaReviewer || '').trim()) return 'Add your name under Reviewer';
  if (run.status === 'Passed with Override' && run.override.trim().length < 5) return 'Say why you are passing it with an override';
  // A pass says someone looked. A flagged item still waiting for ✓ or ✕ has not been looked at.
  const open = run.status !== 'Failed - Gaps Found' ? qaUndecided() : 0;
  if (open) return `Decide the ${qaPlural(open, 'flagged item')} on the Summary of findings before passing it`;
  return '';
}
function _qaSaveBtn() {
  const b = document.getElementById('qa-save'); if (!b || !qaRun) return;
  const why = qaSaveBlock();
  const dirty = !qaRun.saved || qaSnap() !== qaRun.snap;
  b.disabled = !!why || !dirty || !!qaRun.saving; b.title = why;
  b.textContent = qaRun.saved ? 'Save changes' : 'Save review';
  // Amber only for what stops a save; "Up to date" is good news.
  const h = document.getElementById('qa-save-why'); if (h) { h.textContent = why || (qaRun.saved && !dirty ? 'Up to date' : ''); h.classList.toggle('warn', !!why); }
}
function _qaVerdictStep(host) {
  const run = qaRun, o = qaOutcome(), id = qaRecordId();
  const hardMiss = o.counts.missHard > 0, rec = o.suggestedStatus;
  const stBtn = s => `<button class="qa-stbtn ${s === 'Passed' ? 'st-pass' : s === 'Failed - Gaps Found' ? 'st-fail' : 'st-over'}${run.status === s ? ' on' : ''}${rec === s && run.status !== s ? ' rec' : ''}" data-s="${s}"${s === 'Passed' && hardMiss ? ' disabled title="There are hard misses, so use Passed with Override"' : ''} onclick="qaSetStatus('${s}')"><b>${s}</b>${rec === s ? `<span>Suggested by the checks${s !== 'Failed - Gaps Found' && qaUndecided() ? `, once ${qaPlural(qaUndecided(), 'flagged item')} ${qaUndecided() === 1 ? 'is' : 'are'} decided` : ''}</span>` : ''}</button>`;
  const row = (label, val, key, wide) => `<div class="qa-sfrow${wide ? ' wide' : ''}"><div class="klabel">${label}</div><div class="qa-sfval">${val}</div>${key ? `<button class="copy-btn" onclick="qaCopy('${key}',this)">Copy</button>` : ''}</div>`;
  host.innerHTML = `<div class="qa-verdict">
    <div class="qa-vleft"><div class="klabel">Summary</div>
      <div class="qa-lede">Written from the findings. Edit here and then paste into Salesforce.${run.edited ? ' <button class="qa-link" onclick="qaResetSummary()">Reset to the written version</button>' : ''}</div>
      <textarea class="qa-in" id="qa-summary" style="min-height:230px;" oninput="qaSetSummary(this.value)" aria-label="Summary">${qaH(run.summary)}</textarea>
      <div class="qa-sfhint" id="qa-sum-n" style="margin-top:4px;">${run.summary.length} characters</div></div>
    <div class="qa-vright">
      ${qaProj.trim() ? '' : `<div class="qa-field" id="qa-project-field" style="margin-bottom:12px;"><span class="klabel">Project ID (required)</span>
        <input class="qa-in needs" id="qa-project2" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. 2321LOPE" oninput="qaSetProject(this.value,true)" onchange="qaProjectCommit()" aria-label="Project ID"></div>`}
      <div class="klabel">Status</div>
      <div class="qa-stlist">${QA_SF_STATUSES.map(stBtn).join('')}</div>
      <textarea class="qa-in short" id="qa-override" placeholder="Why this passes despite the gap or miss" oninput="qaSetOverride(this.value)" aria-label="Override reason"${run.status === 'Passed with Override' ? '' : ' hidden'}>${qaH(run.override)}</textarea>
    </div></div>
    <div class="qa-vfoot"><button class="qa-primary" id="qa-save" onclick="qaSave()">${run.saved ? 'Save changes' : 'Save review'}</button><span class="qa-sfhint warn" id="qa-save-why"></span>
      ${run.saved ? `<span class="qa-saved">Saved as ${qaH(run.saved)}</span><button class="qa-link" onclick="qaOpenRecord('${qaH(run.saved)}')">Open in History</button><button class="qa-link" onclick="qaPrintRecord('${qaH(run.saved)}')">Export PDF</button>` : ''}</div>
    ${run.saved ? `<div class="qa-actions" style="justify-content:flex-end;margin-bottom:0;"><button class="fbtn" onclick="qaCopyAll(this)">Copy all</button></div><div class="qa-sf">
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
  if (!(await qaReady())) return;
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
    photos: qaPhotoRec(),
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
  qaProjEdit = false; { const h = document.getElementById('qa-projcard'); if (h) h.innerHTML = qaProjCard(); }   // fixed once saved: no pencil
  toast('Saved ' + saved.id);
  _qaStatusStepRefresh(); _qaConn(); _qaBar(); _qaStrip();
}
// Revise a saved review: the status and its reason, the summary, and the findings behind them.
async function qaUpdate() {
  const run = qaRun, o = qaOutcome();
  const changes = {
    status: run.status, override: run.status === 'Passed with Override' ? run.override.trim() : '', summary: run.summary,
    counts: o.counts, suggested: o.suggestedStatus,
    photos: qaPhotoRec(),
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
  if (!(await qaReady())) return null;
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
function _qaStatusStepRefresh() { if (qaRun.step === 1) _qaStep(); }
function qaStartOver() {
  if (qaRun && !qaRun.saved && !confirm('Discard this review and start over? Nothing has been saved.')) return;
  if (qaRun && qaRun.pdfUrl) URL.revokeObjectURL(qaRun.pdfUrl);
  qaRun = null; qaPack = null; qaProj = ''; qaProjEdit = false; qaFlag = null; qaErr = { pdf: '', zip: '' }; qaBusy = { pdf: '', zip: '' };
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
  if (!log.length) {
    host.innerHTML = `<div class="sec"><div class="shead"><div><div class="stitle">No reviews yet</div>
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
  host.innerHTML = `
    <div class="srail">
      ${cell('Reviews', log.length, thisWeek + ' this week', 'Every saved review.')}
      ${cell('Passed first time', fp == null ? '—' : fp + '%', qaPlural(firstPass.length, 'first review'), 'Of first reviews of an account, the share that passed with nothing to fix.')}
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
// Which photos were marked, by name. Anything not listed was not individually reviewed.
function qaMarksHtml(r) {
  const ph = r.photos; if (!ph || !ph.total) return '';
  const marks = ph.marks || [], good = marks.filter(x => x.m === 'ok'), bad = marks.filter(x => x.m === 'bad');
  const name = x => `${qaH(x.label)}${x.unit ? ' · ' + qaH(qaUnitName(x.unit)) : ''} · photo ${x.n}`;
  const none = !marks.length && !ph.bad && !ph.ok;
  return `<div class="klabel" style="margin-top:12px;">Photos</div><div class="qa-mini">
    ${none ? 'None marked.' : `${good.length || ph.ok ? `<span class="qa-mk ok">✓</span> ${ph.ok} good` : ''}${(good.length || ph.ok) && (bad.length || ph.bad) ? ' · ' : ''}${bad.length || ph.bad ? `<span class="qa-mk bad">✕</span> ${ph.bad} not usable` : ''}`}
    ${marks.map(x => `<div><span class="qa-mk ${x.m}">${x.m === 'ok' ? '✓' : '✕'}</span> ${name(x)}</div>`).join('')}
    <div class="qa-sfhint">${ph.total} key photos shown; the others were not individually reviewed.</div></div>`;
}
// A printable page for one review. The browser's print dialog saves it as a PDF.
function qaPrintRecord(id) {
  const r = qaLoad().find(x => x.id === id); if (!r) return;
  const live = qaRun && qaRun.saved === id ? qaRun : null;     // thumbnails only while the review is open
  const ph = r.photos || { marks: [] }, marks = ph.marks || [];
  const thumb = x => { const it = live && (live.items || []).find(i => i.id === x.k && (i.unit || '') === (x.unit || '') && i.n === x.n); return it && it.url ? `<img src="${it.url}" alt="">` : ''; };
  const line = f => `<li><b>${qaH(f.title)}</b>${f.detail ? ' — ' + qaH(f.detail) : ''}</li>`;
  const misses = r.findings.filter(f => f.status === 'miss'), gaps = r.findings.filter(f => f.status === 'gap' && !f.standing);
  const css = `body{font:13px/1.5 -apple-system,Helvetica,Arial,sans-serif;color:#1a1a1a;margin:32px auto;max-width:760px;padding:0 20px}h1{font-size:20px;margin:0 0 2px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:#666;margin:22px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px}.meta{color:#555;font-size:12px}pre{white-space:pre-wrap;font:inherit;background:#f6f5f2;padding:10px 12px;border-radius:6px}ul{margin:4px 0;padding-left:18px}.st{display:inline-block;font-weight:700;padding:2px 10px;border:1.5px solid #1a1a1a;border-radius:99px;font-size:12px}.mk{display:flex;gap:10px;align-items:center;margin:4px 0}.mk img{height:54px;border-radius:4px}.ok{color:#1d7a46;font-weight:700}.bad{color:#b3261e;font-weight:700}.fine{color:#777;font-size:11px;margin-top:6px}@media print{body{margin:0}}`;
  const html = `<!doctype html><meta charset="utf-8"><title>${qaH(r.id)}</title><style>${css}</style>
    <h1>Site Survey QA review · ${qaH(r.project)}</h1>
    <div class="meta">${qaH(r.id)} · ${qaH(qaDate(r))} · reviewed by ${qaH(r.reviewer)}${r.surveyor ? ' · surveyor ' + qaH(r.surveyor) : ''} · ${qaH(QA_TEMPLATE_NAMES[r.template] || r.template || '')}</div>
    <p><span class="st">${qaH(r.status)}</span>${r.override ? ` &nbsp; Override: ${qaH(r.override)}` : ''}</p>
    <h2>Summary</h2><pre>${qaH(r.summary)}</pre>
    <h2>Photos marked</h2>
    ${marks.length ? marks.map(x => `<div class="mk"><span class="${x.m}">${x.m === 'ok' ? '✓ Good' : '✕ Not usable'}</span>${thumb(x)}<span>${qaH(x.label)}${x.unit ? ' · ' + qaH(x.unit) : ''} · photo ${x.n}</span></div>`).join('') : '<div>No photos were marked.</div>'}
    <div class="fine">${ph.total ? `${ph.total} key photos were shown. Photos not listed were not individually reviewed.` : ''}</div>
    <h2>${misses.length === 1 ? '1 miss' : misses.length + ' misses'}</h2>${misses.length ? `<ul>${misses.map(line).join('')}</ul>` : '<div>None.</div>'}
    ${gaps.length ? `<h2>Not in the template</h2><ul>${gaps.map(line).join('')}</ul>` : ''}
    <div class="fine">Report ${qaH(r.file.name)} · SHA-256 ${qaH(r.file.hash.slice(0, 16))}…</div>`;
  const w = window.open('', '_blank'); if (!w) { toast('Allow pop-ups to export the PDF'); return; }
  w.document.open(); w.document.write(html); w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 400);
}
function qaRecordDetail(r) {
  const misses = r.findings.filter(f => f.status === 'miss'), gaps = r.findings.filter(f => f.status === 'gap');
  const line = f => `<div>${f.severity === 'hard' ? '<span class="qa-sw hard"></span> ' : '<span class="qa-sw warn"></span> '}<b>${qaH(f.title)}</b> · ${qaH(f.detail)}</div>`;
  const left = qaEditing === r.id ? qaEditForm(r) : `<div class="klabel">Summary sent to Salesforce</div><pre class="qa-pre">${qaH(r.summary)}</pre>
      ${r.override ? `<div class="klabel" style="margin-top:12px;">Override</div><div class="qa-mini">${qaH(r.override)}</div>` : ''}
      ${r.editedAt ? `<div class="qa-sfhint" style="margin-top:8px;">Edited by ${qaH(r.editedBy || 'someone')} on ${qaH(new Date(r.editedAt).toLocaleDateString('en-US'))}</div>` : ''}
      <div class="qa-actions"><button class="copy-btn" onclick="qaCopyRecord('${qaH(r.id)}','summary',this)">Copy summary</button>
        <button class="copy-btn" onclick="qaCopyRecord('${qaH(r.id)}','link',this)">Copy link</button>
        <button class="fbtn" onclick="qaPrintRecord('${qaH(r.id)}')">Export PDF</button>
        <button class="qa-link" style="margin-left:auto;" onclick="qaEditRecord('${qaH(r.id)}')">Edit</button>
        <button class="qa-link" style="color:var(--red);" onclick="qaDelete('${qaH(r.id)}')">Delete</button></div>`;
  return `<div class="qa-expand-grid" onclick="event.stopPropagation()">
    <div>${left}</div>
    <div><div class="klabel">Record</div><div class="qa-mini">
        <b>${qaH(r.id)}</b> · ${qaH(r.source)}<br>
        Report: ${qaH(r.file.name)}<br>${r.reportLink || r.photoLink ? `Files: <a href="${qaH(r.reportLink || r.photoLink)}" target="_blank" rel="noopener">Drive ↗</a><br>` : ''}
        <span style="font-size:10px;">SHA-256 ${qaH(r.file.hash.slice(0, 16))}…</span><br>
        Suggested by the checks: ${qaH(r.suggested)}${r.pack ? `<br>Photo export: ${r.pack.matched} of ${r.pack.folders} folders matched` : ''}</div>
      ${qaMarksHtml(r)}
      <div class="klabel" style="margin-top:12px;">Misses${misses.length ? ' · ' + misses.length : ''}</div>
      <div class="qa-mini">${misses.slice(0, 10).map(line).join('') || 'None.'}${misses.length > 10 ? `<div>+${misses.length - 10} more</div>` : ''}</div></div>
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
  if (!(await qaReady())) return;
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

// ── Settings ───────────────────────────────────────
// What each check requires, in the app's Settings page. Required stops a handoff; Flagged asks
// for a look; Alarm only stays out of every review and the report unless it fails; Off drops the
// check. Only changes from a check's own default are stored. The whole team reviews against
// this, so it lives on the server and only the manager's password may change it.
const QA_CHECK_SET = [['hard', 'Required'], ['warn', 'Flagged'], ['alarm', 'Alarm only'], ['off', 'Off']];
function _qaSettings() {
  const host = document.getElementById('qa-set-host'); if (!host) return;
  const head = `<div class="set-title">Site Survey QA</div>`;
  if (!qaPw()) { host.innerHTML = `${head}<div class="set-desc" style="margin-bottom:10px;">Sign in to the QA page to see what each check requires.</div><button class="fbtn" onclick="qaSettingsSignIn()">Sign in</button>`; return; }
  if (qaMode === 'checking') { host.innerHTML = `${head}<div class="set-desc">Loading…</div>`; qaSync().then(ok => { if (ok !== false) _qaSettings(); }); return; }
  const checks = OpsQA.allChecks(), areas = OpsQA.AREA_ORDER.filter(a => checks.some(c => c.area === a));
  const can = qaManager, cur = c => qaChecks[c.id] || c.def, changed = checks.filter(c => cur(c) !== c.def).length;
  const btn = (c, v, l) => `<button class="tgl-btn${cur(c) === v ? ' active' : ''}"${can ? '' : ' disabled'} onclick="qaSetCheck('${c.id}','${v}')">${l}</button>`;
  host.innerHTML = `${head}
    <div class="set-row"><div><div class="set-label">What each check requires</div><div class="set-desc"><b>Required</b> stops a handoff. <b>Flagged</b> asks for a look. <b>Alarm only</b> stays out of the review and the report unless it fails. <b>Off</b> drops the check. ${can ? 'Changes apply to everyone on the next review.' : 'Only the manager can change these.'}</div></div>
      ${changed && can ? `<div class="set-control"><button class="fbtn" onclick="qaResetChecks()">Reset ${changed} to the defaults</button></div>` : ''}</div>
    <div class="xscroll"><table class="tbl qa-tbl qa-set-tbl"><thead><tr><th>Check</th><th>Survey types</th><th>Weight</th></tr></thead><tbody>
      ${areas.map(a => `<tr><td colspan="3" class="qa-areahead">${qaH(a)}</td></tr>` + checks.filter(c => c.area === a).map(c => `<tr>
        <td class="qa-check">${qaH(c.title)}${cur(c) !== c.def ? ' <span class="qa-tag">changed</span>' : ''}${c.when ? `<div class="qa-when">${qaH(c.when)}</div>` : ''}${c.zeroHard && cur(c) === c.def ? '<div class="qa-when">Required when there are none</div>' : ''}</td>
        <td style="color:var(--muted);white-space:nowrap;">${c.vendors.length > 1 ? 'Both' : c.vendors[0] === 'radicl' ? 'Radicl only' : 'SunPower only'}</td>
        <td><div class="toggle-group" role="group" aria-label="${qaH(c.title)}">${QA_CHECK_SET.map(([v, l]) => btn(c, v, l)).join('')}</div></td></tr>`).join('')).join('')}
    </tbody></table></div>
    <div class="set-row" style="margin-top:14px;"><div><div class="set-label">Claude photo check</div><div class="set-desc">Claude looks at each key photo in a review and says whether it can be read. It only advises: a photo it doubts moves to the front of its row, and you still mark it. Photos are sent to Claude and not stored. Needs ANTHROPIC_API_KEY on the server.</div></div>
      <div class="set-control"><input type="checkbox" ${S.qaVision ? 'checked' : ''} onchange="setSetting('qaVision',this.checked)"></div></div>`;
}
async function qaSettingsSignIn() { if (!qaGate()) return; qaMode = 'checking'; const ok = await qaSync(); if (ok === false) return; _qaSettings(); }
async function qaSetCheck(id, v) {
  if (!qaManager) return;
  const def = (OpsQA.allChecks().find(c => c.id === id) || {}).def, next = Object.assign({}, qaChecks);
  if (v === def) delete next[id]; else next[id] = v;
  await qaSaveChecks(next);
}
function qaResetChecks() { if (confirm('Put every check back to its default?')) qaSaveChecks({}); }
async function qaSaveChecks(next) {
  if (!(await qaReady())) return _qaSettings();
  const prev = qaChecks; qaChecks = next;
  if (qaMode === 'shared') {
    const r = await qaApi('PUT', '?settings=1', { checks: next });
    if (r.status === 401) { qaBounce('Wrong password'); return; }
    if (r.status !== 200 || !r.body || !r.body.settings) { qaChecks = prev; toast(r.status === 403 ? 'Only the manager can change these' : "Couldn't save. Try again"); return _qaSettings(); }
    qaChecks = r.body.settings.checks;
  } else { try { localStorage.setItem('ops_qa_checks', JSON.stringify(next)); } catch (e) {} }
  if (qaRun) { qaReeval(true); qaRefresh(); }
  _qaSettings();
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
  const spec = specs.find(s => s.id === id), ch = OpsQA.templateChanges(id), fix = {}; ch.forEach(c => { fix[c.id] = c; });
  const vbtn = v => `<button class="tgl-btn${vendor === v ? ' active' : ''}" onclick="qaSetTplVendor('${v}')">${v === 'radicl' ? 'Radicl' : 'SunPower'}</button>`;
  const note = !spec ? '' : vendor === 'radicl'
    ? (spec.inferredFrom >= 3 ? `Standard built from ${spec.inferredFrom} reference reports.` : `Standard built from ${qaPlural(spec.inferredFrom, 'reference report')}. Completeness checks start at three.`)
    : `${spec.fields.length} fields, ${spec.fields.filter(f => f.type === 'FOTO').length} of them photos.`;
  // Everything the review checks for this template, then whether the template can capture it.
  const own = OpsQA.checklist(id, qaChecks);
  const other = OpsQA.allChecks().filter(c => !c.vendors.includes(vendor) && ['off', 'alarm'].indexOf(qaChecks[c.id] || c.def) < 0)
    .map(c => ({ id: c.id, area: c.area, title: c.title, when: c.when, severity: qaChecks[c.id] === 'hard' || qaChecks[c.id] === 'warn' ? qaChecks[c.id] : c.severity, inTemplate: true, absent: true }));
  const list = own.concat(other), ids = new Set(list.map(c => c.id));
  const extras = ch.filter(c => !ids.has(c.id));            // template improvements that are not one of the checks
  const areas = OpsQA.AREA_ORDER.filter(a => list.some(c => c.area === a));
  const add = list.filter(c => !c.inTemplate && !c.absent).length + extras.length;
  const tid = 'qa-chg-' + id;
  const state = c => c.absent ? `<span class="qa-tag" title="This survey type's report has no field for it">not on this report</span>`
    : c.inTemplate ? '<span class="qa-ok">In the template</span>'
    : `<span class="qa-tag qa-tag-add">Add to template</span><div class="qa-detail">${qaH((fix[c.id] || {}).fix || (fix[c.id] || {}).gap || 'The template has no field for this.')}</div>`;
  host.innerHTML = `<div class="fbar qa-tplbar"><div class="toggle-group" role="group" aria-label="Template">${vbtn('sitecapture')}${vbtn('radicl')}</div></div>
    <div class="sec">
      <div class="shead"><div><div class="stitle">${qaH(QA_TEMPLATE_NAMES[id])}</div>
        <div class="ssub">${qaH(note)} ${qaPlural(own.length, 'check')} on every review${add ? `, ${add} to add to the template` : ', all in the template'}. Weights are set in Settings.</div></div>
        ${ch.length ? `<button class="fbtn" onclick="qaCopyChanges('${id}',this)">Copy change list</button>` : ''}</div>
      <div class="xscroll"><table class="tbl qa-tbl qa-tpl-tbl" id="${tid}"><thead><tr><th>What we review</th><th>Weight</th><th>In this template</th></tr></thead><tbody>
        ${areas.map(a => `<tr><td colspan="3" class="qa-areahead">${qaH(a)}</td></tr>` + list.filter(c => c.area === a).map(c => `<tr>
          <td class="qa-check">${qaH(c.title)}${c.when ? `<div class="qa-when">${qaH(c.when)}</div>` : ''}</td>
          <td style="color:var(--muted);white-space:nowrap;">${c.severity === 'hard' ? 'Required' : 'Flagged'}</td>
          <td>${state(c)}</td></tr>`).join('')).join('')}
        ${extras.length ? `<tr><td colspan="3" class="qa-areahead">Also add to the template</td></tr>` + extras.map(c => `<tr>
          <td class="qa-check">${qaH(c.title)}</td><td style="color:var(--muted);white-space:nowrap;">${c.severity === 'hard' ? 'Required' : 'Flagged'}</td>
          <td><span class="qa-tag qa-tag-add">Add to template</span><div class="qa-detail">${qaH(c.fix)}</div></td></tr>`).join('') : ''}
      </tbody></table></div><div class="tbl-foot"><button class="copy-btn" onclick="copyTableEl('${tid}',this,'checks')">Copy table</button></div>
    </div>`;
}
function qaCopyChanges(id, btn) {
  const ch = OpsQA.templateChanges(id);
  const text = `${QA_TEMPLATE_NAMES[id]}: changes needed\n\n` + ch.map((c, i) => `${i + 1}. ${c.title}${c.severity === 'hard' ? ' (required)' : ''}\n   ${c.fix}`).join('\n\n');
  navigator.clipboard.writeText(text).then(() => qaCopied(btn)).catch(_copyFail);
}
