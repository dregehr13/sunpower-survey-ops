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
  'sitecapture-v13': 'Site Capture · Site Survey Form V.13',
  'radicl-v2': 'Radicl · September 2026 template',
  'radicl-v1': 'Radicl · August 2026 template',
};

let qaView = 'review', qaLens = 'reviews', qaFlag = null, qaQ = '', qaStatusF = 'all', qaOpen = null;
let qaLog = null, qaRun = null, qaDeps = null, qaPack = null, qaProj = '', qaReviewer = null;
let qaMode = 'checking', qaNote = '', qaSyncing = null;      // 'checking' | 'shared' | 'local'
let qaBusy = { pdf: '', zip: '' }, qaErr = { pdf: '', zip: '' };
let qaPendingRecord = null;
const qaUrls = [];

// The hash that opened the page names a record (#qa?r=QA-...). Captured at load,
// before the main script's own routing rewrites the URL.
(function () { const m = location.hash.match(/[?&]r=([^&]+)/); if (m && /^#qa/.test(location.hash)) qaPendingRecord = decodeURIComponent(m[1]); })();

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
  qaLog = null; qaMode = 'checking';
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
  catch (e) { toast('Could not save: browser storage is full or blocked'); return false; }
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
    } else if (r.status === 401) { qaBounce('Wrong password'); return false; }
    else {
      qaMode = 'local';
      qaNote = r.status === 503 ? (r.body && r.body.detail) || 'The shared log is not set up on the server yet.'
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
  _qaConn(); _qaDup();
  if (qaView === 'log') _qaLog();
  else if (qaView === 'templates') _qaTemplates();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && currentPage === 'qa' && qaMode === 'shared') qaSync().then(ok => ok && qaAfterSync()); });

// ── Dependencies, loaded on first use so no other page pays for them ──
function qaDepsLoad() {
  if (qaDeps) return qaDeps;
  qaDeps = (async () => {
    const specs = await Promise.all(QA_SPECS.map(n => fetch('qa/specs/' + n + '.json').then(r => { if (!r.ok) throw new Error('Could not load the ' + n + ' spec'); return r.json(); })));
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
    s.onload = () => res(window.JSZip); s.onerror = () => rej(new Error('Could not load the zip reader'));
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
  const hits = allRows.filter(r => (r.project || '').toUpperCase() === id);
  return hits.find(r => r.task_id) || hits[0] || null;
}
function qaMatchHtml() {
  const id = qaProj.trim();
  if (!id) return `<div class="qa-match">Site Capture prints it on the report. Radicl reports carry only the address, so type it.</div>`;
  const r = qaProjectRow(id);
  if (!r) return `<div class="qa-match warn">No Salesforce project with that ID.</div>`;
  const link = sfUrl(r) ? ` <a href="${qaH(sfUrl(r))}" target="_blank" rel="noopener">Open ↗</a>` : '';
  return `<div class="qa-match ok"><b>${qaH(r.project)}</b> · ${qaH(r.address || 'no address')}<br>${qaH(r.project_status || '')}${r.resource ? ' · ' + qaH(r.resource) : ''}${link}</div>`;
}
function qaSetProject(v) {
  qaProj = v;
  const el = document.getElementById('qa-match'); if (el) el.innerHTML = qaMatchHtml();
  if (qaRun && !qaRun.saved) qaReeval(false);
}
function qaSetReviewer(v) {
  qaReviewer = v;
  try { localStorage.setItem(QA_USER_KEY, v); } catch (e) {}
  if (qaRun) _qaHandoff();
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
  const title = kind === 'pdf' ? 'Drop the survey report (PDF)' : 'Drop the photo export (zip)';
  const sub = busy || err || (have ? (have.name + ' · ' + (kind === 'pdf' ? qaRun.S.meta.pages + ' pages' : have.note)) : (kind === 'pdf' ? 'Site Capture or Radicl · stays in this browser' : 'Optional · lets you look at the originals'));
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

async function qaOpenReport(file) {
  qaSetBusy('pdf', 'Reading the report…');
  try {
    const deps = await qaDepsLoad();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await qaHash(bytes);
    const { pages } = await deps.mod.pdfToBlocks(bytes, { pdfjs: deps.pdfjs, onPage: (n, t) => qaSetBusy('pdf', `Reading page ${n} of ${t}…`) });
    const det = OpsQA.detectTemplate(pages, deps.specs);
    if (det.vendor === 'unknown') throw new Error('Not a Site Capture or Radicl survey report');
    const spec = deps.specs.find(s => s.id === det.specId) || null;
    const S = det.vendor === 'sitecapture' ? OpsQA.parseSiteCapture(pages, spec) : OpsQA.parseRadicl(pages, { specId: det.specId });
    if (!qaProj.trim() && S.meta.project) qaProj = S.meta.project;
    qaRun = { file: { name: file.name, size: file.size, hash }, bytes, det, S, spec, specs: deps.specs, R: null, items: null, verdicts: {}, status: null, override: '', summary: '', edited: false, saved: null };
    qaReeval(true);
    qaSetBusy('pdf', '');
    if (qaPack) qaCrossCheckPack();
    qaRender();
    requestAnimationFrame(() => animateSections('page-qa'));
    qaLoadPhotos();
  } catch (e) {
    console.error(e);
    qaSetBusy('pdf', '', e.message || 'Could not read that file');
  }
}

// Run the checks again with the project the coordinator typed.
function qaReeval(full) {
  const run = qaRun; if (!run) return;
  const row = qaProjectRow(qaProj);
  const ctx = { sfAddress: row ? row.address : null, sfResource: row ? (row.resource || null) : null };
  run.ctx = ctx;
  run.R = OpsQA.evaluate(run.S, run.specs, ctx);
  if (!full) { qaRefresh(); return; }
}

// Findings including what a person saw in the photos.
function qaFindings() {
  const run = qaRun; if (!run) return [];
  const out = run.R.findings.slice();
  for (const it of run.items || []) {
    if (run.verdicts[qaPhotoKey(it)] === 'bad') {
      out.push({ layer: 'P', id: 'photo:' + qaPhotoKey(it), area: 'Photos', status: 'miss', severity: 'hard',
        title: it.label + ' photo not usable', detail: (it.unit ? it.unit + ', ' : '') + 'photo ' + it.n + ' was marked unreadable or wrong', evidence: {} });
    }
  }
  return out;
}
function qaOutcome() { return OpsQA.outcomeOf(qaFindings()); }
const qaPhotoKey = it => [it.id, it.unit || '', it.n].join('|');

function qaReviewNumber() {
  const id = qaProj.trim().toUpperCase();
  return qaLoad().filter(r => r.project === id).length + 1;
}
function qaSummaryText() {
  const run = qaRun, o = qaOutcome();
  const res = Object.assign({}, run.R, { findings: qaFindings(), counts: o.counts, suggestedStatus: o.suggestedStatus });
  return OpsQA.summarize(res, { reviewNumber: qaReviewNumber(), status: run.status, override: run.status === 'Passed with Override' ? run.override.trim() : '' }).text;
}
function qaRefresh() {
  const run = qaRun; if (!run) return;
  if (!run.edited) run.summary = qaSummaryText();
  _qaRail(); _qaFindingsSec(); _qaHandoff();
}

// Fill one card as its image arrives instead of rebuilding the grid.
function qaPhotoSub() {
  const its = qaRun.items, loaded = its.filter(x => x.url).length, done = its.filter(x => qaRun.verdicts[qaPhotoKey(x)]).length;
  return loaded < its.length && !qaRun.photosSettled ? `Loading photos ${loaded} of ${its.length}…` : `${done} of ${its.length} looked at · a count says a photo exists, not that it can be read`;
}
function qaPhotoReady(it) {
  const i = qaRun.items.indexOf(it), card = document.querySelector(`.qa-ph[data-i="${i}"]`);
  if (!card) return;
  const box = card.querySelector('.qa-ph-img');
  box.classList.remove('empty'); box.setAttribute('role', 'button'); box.tabIndex = 0; box.setAttribute('onclick', `qaZoom(${i})`);
  box.innerHTML = `<img src="${it.url}" alt="${qaH(it.label)}">`;
  card.querySelector('.qa-ph-meta').textContent = `Photo ${it.n} · ${it.from}`;
  const sub = document.getElementById('qa-ph-sub'); if (sub) sub.textContent = qaPhotoSub();
}

// ── Photo pack (the export from Site Capture) ──────
async function qaOpenPack(file) {
  qaSetBusy('zip', 'Reading the photo export…');
  try {
    const JSZip = await qaJSZip();
    const zip = await JSZip.loadAsync(file);
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
    const deps = await qaDepsLoad();
    const spec = deps.specs.find(s => s.id === 'sitecapture-v13');
    const pack = OpsQA.indexPhotoPack(names, spec);
    qaPack = { name: file.name, zip, pack, note: names.length + ' photos', check: null };
    qaSetBusy('zip', '');
    if (qaRun) { qaCrossCheckPack(); qaRender(); qaLoadPhotos(); }
    else { const el = document.getElementById('qa-dz-zip'); if (el) el.innerHTML = qaDropHtml('zip'); }
  } catch (e) {
    console.error(e);
    qaSetBusy('zip', '', e.message || 'Could not read that file');
  }
}
function qaCrossCheckPack() {
  if (!qaPack || !qaRun) return;
  if (qaRun.S.template.vendor !== 'sitecapture') { qaPack.check = { skipped: true }; qaPack.note = 'Radicl photos are read from its report'; return; }
  qaPack.check = OpsQA.crossCheckPack(qaRun.S, qaPack.pack);
  const c = qaPack.check;
  qaPack.note = `${c.packPhotos} photos · ${c.matched} of ${c.folders} folders match the report`;
}

// Key photos: from the pack when there is one (original resolution), otherwise
// cut out of the report PDF.
async function qaLoadPhotos() {
  const run = qaRun; if (!run) return;
  qaUrls.splice(0).forEach(u => URL.revokeObjectURL(u));
  run.photosSettled = false;
  run.items = OpsQA.keyPhotos(run.S, run.spec).map(i => Object.assign({}, i, { url: null, from: null }));
  _qaPhotosSec();
  const usePack = qaPack && run.S.template.vendor === 'sitecapture';
  if (usePack) {
    for (const it of run.items) {
      const path = OpsQA.packFile(run.S, qaPack.pack, it.photo);
      const f = path && qaPack.zip.file(path);
      if (f) { it.url = URL.createObjectURL(await f.async('blob')); qaUrls.push(it.url); it.from = 'Original'; qaPhotoReady(it); }
    }
  }
  const need = run.items.filter(i => !i.url);
  if (!need.length) { run.photosSettled = true; const sub = document.getElementById('qa-ph-sub'); if (sub) sub.textContent = qaPhotoSub(); return; }
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
      it.url = URL.createObjectURL(await near.get()); qaUrls.push(it.url); it.from = 'From the report';
      qaPhotoReady(it);
    }
  } catch (e) { console.error(e); }
  run.photosSettled = true;
  for (const it of run.items) if (!it.url) { const c = document.querySelector(`.qa-ph[data-i="${run.items.indexOf(it)}"] .qa-ph-img`); if (c) c.textContent = 'Not found in the report'; }
  const sub = document.getElementById('qa-ph-sub'); if (sub) sub.textContent = qaPhotoSub();
}

// ── Page entry ─────────────────────────────────────
function renderQA() {
  const el = document.getElementById('qa-content'); if (!el) return;
  qaLoad();
  qaRender();
  qaSync().then(ok => {
    if (!ok) return;
    if (qaPendingRecord) { const id = qaPendingRecord; qaPendingRecord = null; if (qaLog.some(r => r.id === id)) { qaView = 'log'; qaOpen = id; qaRender(); return; } }
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
  host.innerHTML = `<div class="fbar">
    <div class="fbtn-group" role="group" aria-label="QA view">${btn('review', 'Review')}${btn('log', 'Log')}${btn('templates', 'Templates')}</div>
    <div class="fgroup" style="margin-left:auto;">
      <span id="qa-conn"></span>
      <span class="fsel-label" style="font-size:11px;color:var(--muted);">Reviewer</span>
      <input class="drill-search" id="qa-reviewer" type="text" placeholder="Your name" value="${qaH(qaReviewer || '')}"
        oninput="qaSetReviewer(this.value)" style="flex:0 0 150px;min-width:110px;" aria-label="Reviewer name">
      ${qaView === 'review' && qaRun ? `<button class="fbtn" onclick="qaNew()">New review</button>` : ''}
    </div>
  </div>`;
  _qaConn();
}
function _qaConn() {
  const el = document.getElementById('qa-conn'); if (!el) return;
  const n = qaLog ? qaLog.length : 0;
  el.innerHTML = qaMode === 'shared' ? `<span class="qa-conn" title="Everyone with the password sees the same history"><span class="qa-sw pass"></span>Shared log · ${qaPlural(n, 'review')}</span>`
    : qaMode === 'local' ? `<span class="qa-conn" title="${qaH(qaNote)}"><span class="qa-sw warn"></span>This browser only</span>`
    : `<span class="qa-conn"><span class="qa-sw look"></span>Connecting…</span>`;
}

// ── Review view ────────────────────────────────────
function _qaReview() {
  const host = document.getElementById('qa-body'); if (!host) return;
  host.innerHTML = `
    <div id="qa-dup"></div>
    <div class="sec">
      <div class="shead"><div><div class="stitle">Review a survey</div>
        <div class="ssub">Checks the report against its template and what Design needs. The report and photos stay in this browser.</div></div></div>
      <div class="qa-form">
        <div class="qa-field"><span class="klabel">Project ID</span>
          <input class="qa-in" id="qa-project" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. 2321LOPE"
            value="${qaH(qaProj)}" oninput="qaSetProject(this.value)" aria-label="Project ID">
          <div id="qa-match">${qaMatchHtml()}</div></div>
        <div class="qa-field"><span class="klabel">Report</span><div id="qa-dz-pdf">${qaDropHtml('pdf')}</div></div>
        <div class="qa-field"><span class="klabel">Photos</span><div id="qa-dz-zip">${qaDropHtml('zip')}</div></div>
      </div>
    </div>
    <div id="qa-run"></div>`;
  _qaDup();
  if (qaRun) _qaRunBody();
}
// A report someone has already reviewed — a colleague included — is flagged
// before it is reviewed twice.
function _qaDup() {
  const host = document.getElementById('qa-dup'); if (!host) return;
  const dup = qaRun && !qaRun.saved && qaLoad().find(r => r.file && r.file.hash === qaRun.file.hash);
  const local = qaMode === 'local' ? `<div class="qa-banner qa-banner-info"><span>${qaH(qaNote)} Reviews you save appear only on this computer.</span></div>` : '';
  host.innerHTML = local + (dup ? `<div class="qa-banner"><span>This exact report was already reviewed: review ${dup.n} of ${qaH(dup.project)} on ${qaH(qaDate(dup))} by ${qaH(dup.reviewer)}, ${qaH(dup.status)}.</span>
      <button onclick="qaOpenRecord('${qaH(dup.id)}')">Open it</button></div>` : '');
}
function _qaRunBody() {
  const host = document.getElementById('qa-run'); if (!host) return;
  host.innerHTML = `<div id="qa-rail"></div><div id="qa-findings"></div><div id="qa-photos"></div><div id="qa-handoff"></div>`;
  qaRun.summary = qaRun.edited ? qaRun.summary : qaSummaryText();
  _qaRail(); _qaFindingsSec(); _qaPhotosSec(); _qaHandoff();
}

function qaStatusPill(s) {
  const cls = s === 'Passed' ? 'pg' : s === 'Failed - Gaps Found' ? 'pr' : s === 'Passed with Override' ? 'pam' : 'qa-pill-mute';
  return `<span class="pill ${cls}">${qaH(s || 'Not started')}</span>`;
}

function _qaRail() {
  const host = document.getElementById('qa-rail'); if (!host || !qaRun) return;
  const o = qaOutcome(), c = o.counts, S = qaRun.S;
  const cell = (label, val, sub, tip) => `<div class="srail-cell"><div class="klabel">${label}${tip ? kinfo(tip) : ''}</div>
    <div class="srail-val">${val}${sub ? `<span class="srail-sub">${sub}</span>` : ''}</div></div>`;
  const packTxt = !qaPack ? 'no export' : qaPack.check && qaPack.check.skipped ? 'report' : qaPack.check ? qaPack.check.matched + '/' + qaPack.check.folders + ' folders' : '';
  host.innerHTML = `<div class="srail">
    ${cell('Outcome', `<span class="qa-outcome">${qaStatusPill(o.suggestedStatus)}</span>`, '', 'What the checks point to. You choose the final status below.')}
    ${cell('Hard misses', c.missHard, c.missWarn ? '+' + c.missWarn + ' to review' : '', 'Items Design cannot work without that the survey does not have.')}
    ${cell('Template gaps', c.gap, c.standingGaps + ' standing', 'Things Design needs that the vendor’s template never asks for. Not the surveyor’s miss.')}
    ${cell('Photos', S.photos.length, packTxt, 'Photos listed in the report; the export is checked against it folder by folder.')}
  </div>`;
}

// A short reason a check matters: Enphase's own hold count, and how often we
// have had to resurvey for it.
function qaWhy(f) {
  const ev = f.evidence || {}, bits = [];
  if (ev.enphase) bits.push(`Enphase held ${ev.enphaseN || 'some'} job${ev.enphaseN === 1 ? '' : 's'}: ${ev.enphase}`);
  if (ev.rs && ev.rs.length && typeof OpsMetrics.rsCatLabel === 'function') {
    const share = qaResurveyShare();
    bits.push('Resurveys: ' + ev.rs.slice(0, 2).map(k => OpsMetrics.rsCatLabel(k) + (share[k] != null ? ' ' + share[k] + '%' : '')).join(', '));
  }
  if (ev.guide) bits.push('Survey guide: ' + ev.guide);
  return bits.map(qaH).join('<br>') || '<span style="color:var(--faint);">Template completeness</span>';
}
let _qaShare = null;
function qaResurveyShare() {
  if (_qaShare) return _qaShare;
  const d = allRows.filter(OpsMetrics.isResurveyDefect), cnt = {}; let n = 0;
  for (const r of d) { const cats = OpsMetrics.rsCategories(r); if (!cats.length) continue; n++; cats.forEach(k => { cnt[k] = (cnt[k] || 0) + 1; }); }
  _qaShare = {}; for (const k in cnt) _qaShare[k] = Math.round(cnt[k] / n * 100);
  return _qaShare;
}

const QA_GROUPS = [
  { k: 'miss', l: 'Missing', sw: 'hard', f: x => x.status === 'miss', why: 'Things this survey should have and does not. A hard miss stops the handoff; the rest are for you to judge.' },
  { k: 'gap', l: 'Template gaps', sw: 'gap', f: x => x.status === 'gap', why: 'Design needs these and the vendor’s template has no field for them, so no survey on it can have them. Pass with an override if the rest is sound; the Templates view lists what to change.' },
  { k: 'verify', l: 'Look at', sw: 'look', f: x => x.status === 'verify' || (x.status === 'pass' && x.verify), why: 'Present, but a number or photo needs a person to confirm it.' },
  { k: 'pass', l: 'Passed', sw: 'pass', f: x => x.status === 'pass' && !x.verify, why: '' },
  { k: 'all', l: 'All', sw: '', f: x => x.status !== 'na', why: '' },
];
function qaSortFindings(a, b) {
  const rank = f => f.status === 'miss' ? (f.severity === 'hard' ? 0 : 1) : f.status === 'gap' ? (f.standing ? 3 : 2) : f.status === 'verify' ? 4 : 5;
  return rank(a) - rank(b) || String(a.area).localeCompare(String(b.area));
}
function qaSetFlag(k) { qaFlag = k; _qaFindingsSec(); }

function _qaFindingsSec() {
  const host = document.getElementById('qa-findings'); if (!host || !qaRun) return;
  const all = qaFindings();
  const counts = {}; QA_GROUPS.forEach(g => { counts[g.k] = all.filter(g.f).length; });
  if (!qaFlag || !counts[qaFlag]) qaFlag = counts.miss ? 'miss' : counts.gap ? 'gap' : counts.verify ? 'verify' : 'all';
  const g = QA_GROUPS.find(x => x.k === qaFlag);
  const rows = all.filter(g.f).sort(qaSortFindings);
  const S = qaRun.S, det = qaRun.det;
  const tname = QA_TEMPLATE_NAMES[det.specId] || det.reason;
  const sub = [tname, S.meta.surveyor, S.meta.assessmentDate || S.meta.surveyDate].filter(Boolean).join(' · ');
  const reqFix = id => { const r = OpsQA.REQUIREMENTS.find(x => x.id === id); return r && r.fix; };
  host.innerHTML = `<div class="sec">
    <div class="shead"><div><div class="stitle">Findings</div><div class="ssub">${qaH(sub)}</div></div></div>
    <div class="qa-chips">
      ${QA_GROUPS.filter(x => counts[x.k] || x.k === 'all').map(x => `<button class="qa-chip${qaFlag === x.k ? ' on' : ''}" aria-pressed="${qaFlag === x.k}" onclick="qaSetFlag('${x.k}')">
        ${x.sw ? `<span class="qa-sw ${x.sw}"></span>` : ''}${x.l}<span class="qa-chip-n">${counts[x.k]}</span></button>`).join('')}
    </div>
    ${g.why ? `<div class="note" style="margin:6px 0 10px;">${qaH(g.why)}</div>` : '<div style="height:8px;"></div>'}
    ${rows.length ? `<div class="xscroll"><table class="tbl qa-tbl" id="qa-find-tbl"><thead><tr><th></th><th>Check</th><th>What we found</th><th>Why it matters</th></tr></thead><tbody>
      ${rows.map(f => {
        const sw = f.status === 'miss' ? (f.severity === 'hard' ? 'hard' : 'warn') : f.status === 'gap' ? 'gap' : f.status === 'verify' || f.verify ? 'look' : 'pass';
        const fix = f.status === 'gap' ? reqFix(f.id) : null;
        return `<tr><td class="qa-dot"><span class="qa-sw ${sw}" title="${qaH(f.status === 'miss' ? f.severity : f.status)}"></span></td>
          <td class="qa-check">${qaH(f.title)}<div class="qa-area">${qaH(f.area)}${f.standing ? ' · standing gap' : ''}</div></td>
          <td class="qa-detail">${qaH(f.detail || (f.status === 'pass' ? 'OK' : ''))}${f.note ? `<div class="cmeta">${qaH(f.note)}</div>` : ''}${fix ? `<div class="qa-fix"><b>Template fix:</b> ${qaH(fix)}</div>` : ''}</td>
          <td class="qa-why">${qaWhy(f)}</td></tr>`;
      }).join('')}
    </tbody></table></div>
    <div class="tbl-foot"><button class="copy-btn" onclick="copyTableEl('qa-find-tbl',this,'findings')">Copy table</button></div>`
      : `<div class="note" style="padding:10px 0;">Nothing in this group.</div>`}
    ${S.unmatched.length || (qaRun.R.templateReport.newToSpec || []).length ? `<div class="note">${(qaRun.R.templateReport.newToSpec || []).length ? qaPlural(qaRun.R.templateReport.newToSpec.length, 'item') + ' in this report that the template spec has not seen — the template may have changed.' : ''}</div>` : ''}
  </div>`;
}

// ── Photo check ────────────────────────────────────
function _qaPhotosSec() {
  const host = document.getElementById('qa-photos'); if (!host || !qaRun) return;
  const items = qaRun.items;
  if (!items) { host.innerHTML = ''; return; }
  if (!items.length) { host.innerHTML = `<div class="sec"><div class="shead"><div><div class="stitle">Photo check</div><div class="ssub">No key photos were found in this report</div></div></div></div>`; return; }
  const groups = [];
  items.forEach((it, i) => {
    let g = groups.find(x => x.id === it.id);
    if (!g) groups.push(g = { id: it.id, label: it.label, items: [] });
    g.items.push({ it, i });
  });
  const done = items.filter(it => qaRun.verdicts[qaPhotoKey(it)]).length;
  host.innerHTML = `<div class="sec">
    <div class="shead"><div><div class="stitle">Photo check</div>
      <div class="ssub" id="qa-ph-sub">${qaPhotoSub()}</div></div></div>
    ${groups.map(g => `<div class="qa-photos-h">${qaH(g.label)}</div><div class="qa-photos">
      ${g.items.map(({ it, i }) => {
        const v = qaRun.verdicts[qaPhotoKey(it)];
        return `<div class="qa-ph${v ? ' ' + v : ''}" data-i="${i}">
          <div class="qa-ph-img${it.url ? '' : ' empty'}"${it.url ? ` onclick="qaZoom(${i})" role="button" tabindex="0"` : ''}>${it.url ? `<img src="${it.url}" alt="${qaH(it.label)}">` : 'Loading…'}</div>
          <div class="qa-ph-cap">${qaH(it.unit || it.label)}${it.exterior ? ' · exterior' : ''}</div>
          <div class="qa-ph-meta">Photo ${it.n} · ${qaH(it.from || '')}</div>
          <div class="qa-ph-btns"><button class="ok${v === 'ok' ? ' on' : ''}" onclick="qaVerdict(${i},'ok')">Readable</button><button class="bad${v === 'bad' ? ' on' : ''}" onclick="qaVerdict(${i},'bad')">Not usable</button></div>
        </div>`;
      }).join('')}</div>`).join('')}
  </div>`;
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
  const sub = document.getElementById('qa-ph-sub');
  if (sub) sub.textContent = qaPhotoSub();
  qaRefresh();
}
function qaZoom(i) {
  const it = qaRun.items[i]; if (!it || !it.url) return;
  let lb = document.getElementById('qa-lb');
  if (!lb) { lb = document.createElement('div'); lb.id = 'qa-lb'; lb.className = 'qa-lb hidden'; lb.onclick = qaZoomClose; document.body.appendChild(lb); }
  lb.innerHTML = `<img src="${it.url}" alt=""><div class="qa-lb-cap">${qaH(it.label)}${it.unit ? ' · ' + qaH(it.unit) : ''} · photo ${it.n}</div>`;
  lb.classList.remove('hidden');
}
function qaZoomClose() { const lb = document.getElementById('qa-lb'); if (lb) lb.classList.add('hidden'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') qaZoomClose(); });

// ── Salesforce hand-off ────────────────────────────
function qaToday() { const d = new Date(); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; }
function qaRecordId() { if (qaRun && qaRun.saved) return qaRun.saved; const p = qaProj.trim().toUpperCase() || 'REPORT'; return `QA-${p}-${qaReviewNumber()}`; }
function qaRecordLink(id) { return location.origin + location.pathname + '#qa?r=' + encodeURIComponent(id); }
function qaSetStatus(s) {
  qaRun.status = qaRun.status === s ? null : s;
  qaRefresh();
}
function qaSetOverride(v) { qaRun.override = v; if (!qaRun.edited) { qaRun.summary = qaSummaryText(); const t = document.getElementById('qa-summary'); if (t) t.value = qaRun.summary; } _qaSaveBtn(); }
function qaSetSummary(v) { qaRun.summary = v; qaRun.edited = true; _qaSaveBtn(); }
function qaResetSummary() { qaRun.edited = false; qaRun.summary = qaSummaryText(); const t = document.getElementById('qa-summary'); if (t) t.value = qaRun.summary; }

function qaSaveBlock() {
  const run = qaRun; if (!run) return '';
  if (!run.status) return 'Choose a review status';
  if (!(qaReviewer || '').trim()) return 'Add your name under Reviewer';
  if (!qaProj.trim()) return 'Add the project ID';
  if (run.status === 'Passed with Override' && run.override.trim().length < 5) return 'Say why you are passing it with an override';
  return '';
}
function _qaSaveBtn() {
  const b = document.getElementById('qa-save'); if (!b || !qaRun) return;
  const why = qaSaveBlock();
  b.disabled = !!why || !!qaRun.saved; b.title = why;
  const h = document.getElementById('qa-save-why'); if (h) h.textContent = qaRun.saved ? '' : why;
}

function _qaHandoff() {
  const host = document.getElementById('qa-handoff'); if (!host || !qaRun) return;
  const run = qaRun, o = qaOutcome(), id = qaRecordId();
  const hardMiss = o.counts.missHard > 0;
  const stBtn = s => `<button class="tgl-btn${run.status === s ? ' active' : ''}"${s === 'Passed' && hardMiss ? ' disabled style="opacity:.4;cursor:default;" title="Hard misses are present: use Passed with Override"' : ''} onclick="qaSetStatus('${s}')">${s}</button>`;
  const need = run.status === 'Passed with Override';
  const hint = o.suggestedStatus === 'Needs review' ? 'Warnings only: choose the status you would sign.'
    : `Checks point to ${o.suggestedStatus}.`;
  const row = (label, val, copyKey, wide) => `<div class="qa-sfrow${wide ? ' wide' : ''}"><div class="klabel">${label}</div><div class="qa-sfval">${val}</div>${copyKey ? `<button class="copy-btn" onclick="qaCopy('${copyKey}',this)">Copy</button>` : ''}</div>`;
  host.innerHTML = `<div class="sec">
    <div class="shead"><div><div class="stitle">Salesforce hand-off</div>
      <div class="ssub">The six fields on the Site Survey QA and Completion panel</div></div>
      <button class="fbtn" onclick="qaCopyAll(this)">Copy all</button></div>
    <div class="qa-sf">
      ${row('Site Survey QA Review Status', `<div class="toggle-group">${QA_SF_STATUSES.map(stBtn).join('')}</div><div class="qa-sfhint">${qaH(hint)}</div>`, run.status ? 'status' : '', true)}
      ${row('Site Survey QA Review Date', qaToday(), 'date')}
      ${row('Site Survey QA Review Source', 'Coordinator', 'source')}
      ${row('Site Survey QA Reviewed By', (qaReviewer || '').trim() ? qaH(qaReviewer) : '<span style="color:var(--faint);">Add your name in the bar above</span>', (qaReviewer || '').trim() ? 'by' : '')}
      ${row('Site Survey QA Report Link', `<span style="font-size:11px;">${qaH(qaRecordLink(id))}</span><div class="qa-sfhint">${qaH(id)} · kept in this browser's log</div>`, 'link')}
      ${need ? `<div class="qa-sfrow wide"><div class="klabel">Override reason</div><div class="qa-sfval" style="grid-column:1/-1;">
        <textarea class="qa-in short" id="qa-override" placeholder="Why this passes despite the gap or miss" oninput="qaSetOverride(this.value)">${qaH(run.override)}</textarea></div></div>` : ''}
      <div class="qa-sfrow wide"><div class="klabel">Site Survey QA Summary<span style="text-transform:none;letter-spacing:0;font-weight:400;color:var(--faint);margin-left:8px;">${run.edited ? 'edited · <button class="qa-link" onclick="qaResetSummary()">reset</button>' : 'written from the findings'}</span></div>
        <div class="qa-sfval" style="grid-column:1/-1;"><textarea class="qa-in" id="qa-summary" oninput="qaSetSummary(this.value)">${qaH(run.summary)}</textarea></div>
        <div style="grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;">
          <span class="qa-sfhint" id="qa-sum-n">${run.summary.length} characters</span>
          <button class="copy-btn" onclick="qaCopy('summary',this)">Copy</button></div></div>
    </div>
    <div class="qa-actions">
      ${run.saved ? `<span class="qa-saved">Saved as ${qaH(run.saved)}</span><button class="qa-link" onclick="qaOpenRecord('${qaH(run.saved)}')">Open in the log</button>`
        : `<button class="qa-primary" id="qa-save" onclick="qaSave()">Save review</button><span class="qa-sfhint warn" id="qa-save-why"></span>`}
    </div>
  </div>`;
  const t = document.getElementById('qa-summary'); if (t) t.addEventListener('input', () => { const n = document.getElementById('qa-sum-n'); if (n) n.textContent = t.value.length + ' characters'; });
  _qaSaveBtn();
}

function qaFieldValue(k) {
  const run = qaRun, id = qaRecordId();
  return ({ status: run.status || '', date: qaToday(), by: (qaReviewer || '').trim(), source: 'Coordinator', summary: run.summary, link: qaRecordLink(id) })[k];
}
function qaCopy(k, btn) {
  const text = qaFieldValue(k);
  navigator.clipboard.writeText(text).then(() => qaCopied(btn)).catch(_copyFail);
}
function qaCopyAll(btn) {
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
    photos: { total: (run.items || []).length, ok: Object.values(run.verdicts).filter(v => v === 'ok').length, bad: Object.values(run.verdicts).filter(v => v === 'bad').length },
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
    if (r.status !== 201 || !r.body || !r.body.review) { run.saving = false; _qaSaveBtn(); toast((r.body && r.body.error) || 'Could not save. Check your connection and try again'); return; }
    saved = r.body.review;
    qaLoad().unshift(saved);
  } else {
    qaLoad().unshift(rec);
    if (!qaPersist()) { qaLoad().shift(); run.saving = false; return; }
  }
  run.saving = false; run.saved = saved.id; run.savedRec = saved;
  if (saved.summary !== run.summary) run.summary = saved.summary;
  toast('Saved ' + saved.id);
  _qaHandoff(); _qaConn();
}
function qaNew() {
  qaRun = null; qaPack = null; qaProj = ''; qaFlag = null; qaErr = { pdf: '', zip: '' };
  qaUrls.splice(0).forEach(u => URL.revokeObjectURL(u));
  qaRender();
}
function qaOpenRecord(id) { qaView = 'log'; qaLens = 'reviews'; qaOpen = id; qaQ = ''; qaStatusF = 'all'; qaRender(); requestAnimationFrame(() => { const el = document.getElementById('qa-row-' + id); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }); }

// ── Log ────────────────────────────────────────────
function qaWeekStart() { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
function _qaLog() {
  const host = document.getElementById('qa-body'); if (!host) return;
  const log = qaLoad();
  const where = qaMode === 'shared' ? 'Shared with everyone who has the password.' : 'Saved in this browser. Export to keep a copy.';
  const mine = qaMode === 'shared' ? qaLocalLog().length : 0;
  const migrate = mine ? `<div class="qa-banner qa-banner-info"><span>This browser holds ${qaPlural(mine, 'review')} saved before the shared log existed. Move them so the team can see them.</span>
    <button onclick="qaMoveLocal()">Move to the shared log</button></div>` : '';
  if (!log.length) {
    host.innerHTML = migrate + `<div class="sec"><div class="shead"><div><div class="stitle">No reviews yet</div>
      <div class="ssub">Reviews you save appear here, with how many times each account has been reviewed</div></div>
      <button class="fbtn" onclick="qaImportPick()">Import a log</button></div>
      <div class="note" style="padding:6px 0 4px;">${where}</div></div>`;
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
        <div class="fgroup" style="margin-left:auto;">${qaMode === 'shared' ? `<button class="fbtn" onclick="qaRefresh(this)">Refresh</button>` : ''}<button class="fbtn" onclick="qaExport('json')">Export</button><button class="fbtn" onclick="qaExport('csv')">CSV</button><button class="fbtn" onclick="qaImportPick()">Import</button></div>
      </div>
      <div id="qa-log-table"></div>
      <div class="note">${where}</div>
    </div>`;
  _qaLogTable();
}
async function qaRefresh(btn) {
  const was = btn.textContent; btn.textContent = 'Refreshing…';
  const ok = await qaSync();
  if (ok) { _qaConn(); _qaLog(); }
}
function qaSetLens(l) { qaLens = l; qaOpen = null; _qaLog(); }
function qaSetQ(v) { qaQ = v; _qaLogTable(); }
function qaSetStatusF(v) { qaStatusF = v; _qaLogTable(); }
function qaToggleOpen(id) { qaOpen = qaOpen === id ? null : id; _qaLogTable(); }
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
  return `<div class="qa-expand-grid" onclick="event.stopPropagation()">
    <div><div class="klabel">Summary sent to Salesforce</div><pre class="qa-pre">${qaH(r.summary)}</pre>
      ${r.override ? `<div class="klabel" style="margin-top:12px;">Override</div><div class="qa-mini">${qaH(r.override)}</div>` : ''}
      <div class="qa-actions"><button class="copy-btn" onclick="qaCopyRecord('${qaH(r.id)}','summary',this)">Copy summary</button>
        <button class="copy-btn" onclick="qaCopyRecord('${qaH(r.id)}','link',this)">Copy link</button>
        <button class="qa-link" style="margin-left:auto;color:var(--red);" onclick="qaDelete('${qaH(r.id)}')">Delete</button></div></div>
    <div><div class="klabel">Record</div><div class="qa-mini">
        <b>${qaH(r.id)}</b> · ${qaH(r.source)}<br>
        Report: ${qaH(r.file.name)}<br>
        <span style="font-size:10px;">SHA-256 ${qaH(r.file.hash.slice(0, 16))}…</span><br>
        Checks pointed to ${qaH(r.suggested)}${r.photos && r.photos.total ? ` · photos ${r.photos.ok} readable, ${r.photos.bad} not usable of ${r.photos.total}` : ''}${r.pack ? `<br>Photo export: ${r.pack.matched} of ${r.pack.folders} folders matched` : ''}</div>
      <div class="klabel" style="margin-top:12px;">${qaPlural(misses.length, 'miss')} · ${qaPlural(gaps.filter(g => !g.standing).length, 'applied gap')}</div>
      <div class="qa-mini">${misses.slice(0, 10).map(line).join('') || 'No misses.'}${misses.length > 10 ? `<div>+${misses.length - 10} more</div>` : ''}</div></div>
  </div>`;
}
function qaCopyRecord(id, what, btn) {
  const r = qaLoad().find(x => x.id === id); if (!r) return;
  navigator.clipboard.writeText(what === 'link' ? qaRecordLink(id) : r.summary).then(() => qaCopied(btn)).catch(_copyFail);
}
async function qaDelete(id) {
  if (!confirm('Delete review ' + id + '? It leaves the log for everyone.')) return;
  if (qaMode === 'shared') {
    const r = await qaApi('DELETE', '?id=' + encodeURIComponent(id) + '&by=' + encodeURIComponent(qaReviewer || ''));
    if (r.status === 401) return qaBounce('Wrong password');
    if (r.status !== 200 && r.status !== 404) return toast('Could not delete. Try again');
  }
  qaLog = qaLoad().filter(r => r.id !== id); qaPersist(); qaOpen = null; _qaConn(); _qaLog();
}
function qaExport(kind) {
  const log = qaLoad(); if (!log.length) return;
  let body, type, name;
  if (kind === 'csv') {
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const head = ['Review', 'Project', 'Review #', 'Date', 'Reviewed by', 'Source', 'Status', 'Template', 'Surveyor', 'Hard misses', 'Warnings', 'Applied gaps', 'Override', 'Summary', 'Report file', 'SHA-256'];
    body = [head.map(q).join(',')].concat(log.map(r => [r.id, r.project, r.n, qaDate(r), r.reviewer, r.source, r.status, r.template, r.surveyor, r.counts.missHard, r.counts.missWarn, r.counts.gap, r.override, r.summary, r.file.name, r.file.hash].map(q).join(','))).join('\n');
    type = 'text/csv'; name = 'qa-reviews.csv';
  } else { body = JSON.stringify(log, null, 1); type = 'application/json'; name = 'qa-reviews.json'; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
// Bring reviews in from a file — an export, or the log a browser kept before the
// shared log existed. Reviews the shared log already has are skipped; one whose
// number was taken in the meantime is renumbered rather than lost.
async function qaImportRows(rows) {
  if (qaMode === 'shared') {
    const r = await qaApi('POST', '', { import: rows });
    if (r.status === 401) { qaBounce('Wrong password'); return null; }
    if (r.status !== 200) { toast('Could not import. Try again'); return null; }
    await qaSync(); return r.body;
  }
  const have = new Set(qaLoad().map(r => r.id));
  const add = rows.filter(r => !have.has(r.id));
  qaLog = qaLoad().concat(add).sort((a, b) => b.created.localeCompare(a.created));
  qaPersist();
  return { inserted: add.length, skipped: rows.length - add.length, renumbered: 0 };
}
function qaImportPick() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => {
    let rows;
    try {
      rows = JSON.parse(await inp.files[0].text());
      if (!Array.isArray(rows) || rows.some(r => !r.id || !r.project || !r.status)) throw new Error('Not a QA log');
    } catch (e) { return toast('That file is not a QA log'); }
    const out = await qaImportRows(rows); if (!out) return;
    toast(out.inserted ? 'Imported ' + qaPlural(out.inserted, 'review') + (out.renumbered ? ` (${out.renumbered} renumbered)` : '') : 'Nothing new in that file');
    _qaConn(); _qaLog();
  };
  inp.click();
}
// This browser's own log, from before there was a shared one.
async function qaMoveLocal() {
  const rows = qaLocalLog(); if (!rows.length) return;
  const out = await qaImportRows(rows); if (!out) return;
  try { localStorage.removeItem(QA_LOG_KEY); } catch (e) {}
  toast(`Moved ${qaPlural(out.inserted, 'review')} to the shared log` + (out.skipped ? `, ${out.skipped} already there` : ''));
  _qaConn(); _qaLog();
}

// ── Templates ──────────────────────────────────────
function _qaTemplates() {
  const host = document.getElementById('qa-body'); if (!host) return;
  qaDepsLoad().then(d => _qaTemplatesBody(d.specs), () => { host.innerHTML = `<div class="sec"><div class="note" style="padding:12px 0;">Could not load the template specs.</div></div>`; });
  host.innerHTML = `<div class="sec"><div class="note" style="padding:14px 0;">Loading the templates…</div></div>`;
}
function _qaTemplatesBody(specs) {
  const host = document.getElementById('qa-body'); if (!host || qaView !== 'templates') return;
  const log = qaLoad();
  const ORDER = ['sitecapture-v13', 'radicl-v2', 'radicl-v1'];
  const total = ORDER.reduce((a, id) => a + OpsQA.templateChanges(id).length, 0);
  const hardN = ORDER.reduce((a, id) => a + OpsQA.templateChanges(id).filter(c => c.severity === 'hard').length, 0);
  const hits = {}; log.forEach(r => r.findings.forEach(f => { if (f.status === 'gap') hits[f.id] = (hits[f.id] || 0) + 1; }));
  const newSeen = new Set(); log.forEach(r => (r.newToSpec || []).forEach(x => newSeen.add(x)));
  const cell = (label, val, sub, tip) => `<div class="srail-cell"><div class="klabel">${label}${tip ? kinfo(tip) : ''}</div><div class="srail-val">${val}${sub ? `<span class="srail-sub">${sub}</span>` : ''}</div></div>`;
  host.innerHTML = `
    <div class="srail">
      ${cell('Changes needed', total, 'across 3 templates', 'Fields or photos Design needs that a template does not ask for, plus problems in how a template reports.')}
      ${cell('Hard', hardN, 'stop a handoff', 'Changes whose absence leaves Design without something it cannot work around.')}
      ${cell('New in reports', newSeen.size, 'not in the spec', 'Items seen in saved reviews that the template spec has never recorded. The template may have changed.')}
    </div>
    ${ORDER.map(id => {
      const spec = specs.find(s => s.id === id); if (!spec) return '';
      const ch = OpsQA.templateChanges(id);
      const vendor = /^radicl/.test(id) ? 'radicl' : 'sitecapture';
      const note = vendor === 'radicl'
        ? (spec.inferredFrom >= 3 ? `Standard inferred from ${spec.inferredFrom} reference reports.` : `Standard inferred from ${spec.inferredFrom} reference report; completeness checks wait for three.`)
        : `${spec.fields.length} fields, ${spec.fields.filter(f => f.type === 'FOTO').length} photo fields.`;
      const tid = 'qa-chg-' + id;
      return `<div class="sec">
        <div class="shead"><div><div class="stitle">${qaH(QA_TEMPLATE_NAMES[id])}${id === 'radicl-v1' ? ' <span class="pill qa-pill-mute" style="margin-left:6px;">previous</span>' : id === 'radicl-v2' ? ' <span class="pill pg" style="margin-left:6px;">current</span>' : ''}</div>
          <div class="ssub">${qaH(note)} ${qaPlural(ch.length, 'change')} needed.</div></div>
          <button class="fbtn" onclick="qaCopyChanges('${id}',this)">Copy change list</button></div>
        ${ch.length ? `<div class="xscroll"><table class="tbl qa-tbl" id="${tid}"><thead><tr><th>Change</th><th>What to add or fix</th><th>Evidence</th><th class="r">In reviews</th></tr></thead><tbody>
          ${ch.map(c => `<tr><td class="qa-check"><span class="qa-sev"><span class="qa-sw ${c.severity === 'hard' ? 'hard' : 'warn'}"></span></span> ${qaH(c.title)}</td>
            <td class="qa-detail">${qaH(c.fix)}</td><td class="qa-why">${qaWhy(c)}</td><td class="r">${hits[c.id] || 0}</td></tr>`).join('')}
        </tbody></table></div><div class="tbl-foot"><button class="copy-btn" onclick="copyTableEl('${tid}',this,'changes')">Copy table</button></div>`
          : `<div class="note" style="padding:10px 0;">Nothing to change.</div>`}
      </div>`;
    }).join('')}`;
}
function qaCopyChanges(id, btn) {
  const ch = OpsQA.templateChanges(id);
  const text = `${QA_TEMPLATE_NAMES[id]}: changes needed\n\n` + ch.map((c, i) => `${i + 1}. ${c.title}${c.severity === 'hard' ? ' (required)' : ''}\n   ${c.fix}`).join('\n\n');
  navigator.clipboard.writeText(text).then(() => qaCopied(btn)).catch(_copyFail);
}
