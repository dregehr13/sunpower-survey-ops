// lib/qa.cjs — Site Survey QA: parse a vendor's survey report, then check it.
//
// Fourth shared library, and like the other three it answers exactly one
// question: "was this survey complete enough to hand to Design". metrics.cjs
// says how the survey work is going, coverage.cjs who should do it, billing.cjs
// what it cost. They never share a definition, and this one shares nothing with
// them either — it reads a report, not a Salesforce row.
//
// Two vendors, two templates, one normalized survey. A parser turns a report's
// positioned text blocks (qa/pdf-blocks.mjs makes those) into
//     { template, meta, entries[], photos[], groups, unmatched[] }
// and everything after that — completeness, design needs, template coverage,
// the Salesforce summary — reads that shape and never a PDF. That is why the
// engine is testable without a PDF and why a third vendor is a parser plus a
// spec, not a second engine.
//
// The template is the standard; the Site Survey Guide is the floor.
//   Layer A — template completeness: every field the template requires and the
//             survey's own answers make applicable must be answered.
//   Layer B — design needs (REQUIREMENTS): what Enphase and Design say they
//             cannot work without. Each names, per template, the field or photo
//             that satisfies it — or has none. "None" is a TEMPLATE GAP, not a
//             surveyor miss, and is counted separately so a vendor's miss rate
//             never carries a gap their form could not have captured.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpsQA = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // ── Text helpers ───────────────────────────────────
  const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const tok = s => { const n = norm(s); return n ? n.split(' ') : []; };
  const alnum = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const isYes = v => /^(yes|true|y)$/i.test(norm(v));
  const isNo = v => /^(no|false|n)$/i.test(norm(v));
  const num = v => { const m = String(v == null ? '' : v).match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };

  // Match a report block against a template label. A field renders as its
  // label with the answer printed on the same baseline, so the answer can land
  // before, inside or after the wrapped label ("What does the customer know
  // Roof Replaced about the roof?"). The report also cuts a long label off at
  // ~200 characters, so a block may be only a prefix of the label. Returns the
  // leftover tokens (the value) or null. Smallest value first, so an exact
  // label always beats a label-plus-answer reading of the same tokens.
  function alignLabel(B, L) {
    const nB = B.length, nL = L.length;
    for (let m = 0; m < nB; m++) {
      const lb = nB - m;
      if (lb > nL) continue;
      if (lb < nL && lb < 5) continue;       // a prefix needs enough tokens to mean something
      for (let k = 0; k <= lb; k++) {
        let ok = true;
        for (let i = 0; i < k && ok; i++) if (B[i] !== L[i]) ok = false;
        for (let i = k; i < lb && ok; i++) if (B[m + i] !== L[i]) ok = false;
        if (ok) return { value: B.slice(k, k + m).join(' '), truncated: lb < nL };
      }
    }
    return null;
  }

  // A photo caption has no answer in it, so: equal, or a prefix of a long label.
  // Compared with punctuation and spacing stripped — a template can write
  // "1.)Photo" where the report prints "1.) Photo".
  function captionMatches(B, L) {
    const b = alnum(B.join(' ')), l = alnum(L.join(' '));
    if (!b) return false;
    if (b === l) return true;
    return b.length >= 25 && l.startsWith(b);
  }
  const captionExact = (B, L) => alnum(B.join(' ')) === alnum(L.join(' '));

  // ── Template detection ─────────────────────────────
  // Which vendor wrote this report, and which template version. Vendor is
  // unmistakable from page one; version is a fingerprint of how many of the
  // known spec's fields the report accounts for, so a changed template shows up
  // as a falling match rather than as silent mis-parsing.
  function detectTemplate(pages, specs) {
    const first = (pages[0] && pages[0].blocks || []).map(b => b.text).join('\n');
    const all = pages.slice(0, 3).map(p => p.blocks.map(b => b.text).join('\n')).join('\n');
    if (/S\s*I\s*T\s*E\s+S\s*U\s*R\s*V\s*E\s*Y\s+R\s*E\s*P\s*O\s*R\s*T/i.test(first) && /radicl/i.test(first)) {
      const toc = pages.slice(0, 3).map(p => p.blocks.map(b => b.text).join('\n')).join('\n');
      const v = /Outside Electrical Information/.test(toc) ? 'radicl-v1' : /Exterior Electrical/.test(toc) ? 'radicl-v2' : 'radicl-unknown';
      return { vendor: 'radicl', specId: v, confidence: v === 'radicl-unknown' ? 0.5 : 1, reason: 'Radicl cover page; ' + v };
    }
    if (/Report Created:\s*\d\d\/\d\d\/\d{4}/.test(all) && /1 - Customer Information/.test(all)) {
      const sc = (specs || []).filter(s => s.vendor === 'sitecapture');
      return { vendor: 'sitecapture', specId: sc.length ? sc[0].id : null, confidence: 1, reason: 'Site Capture contents page' };
    }
    return { vendor: 'unknown', specId: null, confidence: 0, reason: 'No known vendor signature on the first pages' };
  }

  // ── Spec index ─────────────────────────────────────
  function indexSpec(spec) {
    const byKey = new Map(), bySection = new Map(), byGroup = new Map();
    for (const f of spec.fields) {
      byKey.set(f.key, f);
      const sec = bySection.get(f.section) || { plain: [], groups: new Map() };
      bySection.set(f.section, sec);
      if (f.group) {
        if (!sec.groups.has(f.group)) sec.groups.set(f.group, []);
        sec.groups.get(f.group).push(f);
        if (!byGroup.has(f.group)) byGroup.set(f.group, []);
        byGroup.get(f.group).push(f);
      } else sec.plain.push(f);
    }
    const sectionByTitle = new Map(spec.sections.map(s => [norm(s.title), s.key]));
    return { byKey, bySection, byGroup, sectionByTitle };
  }

  // ── Survey object ──────────────────────────────────
  // The accessor every rule reads, so no rule knows which vendor it is looking
  // at. `ref` is a spec key for Site Capture and a normalized label for Radicl.
  function makeSurvey(base) {
    const s = Object.assign({ entries: [], photos: [], groups: {}, unmatched: [], meta: {} }, base);
    const matchRef = (m, ref) => m instanceof RegExp ? m.test(ref || '') : m === ref;
    const refsOf = m => (Array.isArray(m) ? m : [m]);
    s.entriesFor = (m, inst) => s.entries.filter(e => refsOf(m).some(x => matchRef(x, e.ref)) && (inst == null || e.instance === inst));
    s.photosFor = (m, inst) => s.photos.filter(p => refsOf(m).some(x => matchRef(x, p.ref)) && (inst == null || p.instance === inst));
    s.photoCount = (m, inst) => s.photosFor(m, inst).length;
    s.value = (m, inst) => {
      const e = s.entriesFor(m, inst).find(x => norm(x.value) !== '');
      return e ? norm(e.value) : null;
    };
    s.has = (m, inst) => s.value(m, inst) !== null || s.photoCount(m, inst) > 0;
    s.instances = g => (s.groups[g] || []).map(i => i.id).filter(x => x != null);
    return s;
  }

  // Does the survey's own answer make this field appear? The report prints
  // every field, hidden or not, so "applies" has to come from the template's
  // dependsOn rules and the answers already given — the form never says it.
  // `valueOf(parentField)` returns that parent's answer (or null) for the
  // instance being asked about.
  function depOk(ix, f, valueOf, depth) {
    depth = depth || 0;
    if (!f.dependsOnKey || depth > 6) return true;
    const d = ix.byKey.get(f.dependsOnKey);
    if (!d || !depOk(ix, d, valueOf, depth + 1)) return false;
    const v = valueOf(d);
    if (v == null) return false;
    const want = String(f.dependsOnValue).toLowerCase(), have = String(v).toLowerCase();
    if (want === 'true') return have === 'yes';
    if (want === 'false') return have === 'no';
    return have === want || have.split(/[,;]/).map(x => x.trim()).includes(want);
  }

  const LOC_RE = /Loc:\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)(?:\s*Az:\s*(-?[\d.]+))?[,\s]*(?:Elv Ang:\s*(-?[\d.]+))?[,\s]*(?:Alt:\s*(-?[\d.]+)\s*ft)?/;
  const TS_RE = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/;

  // ── Site Capture parser ────────────────────────────
  function parseSiteCapture(pages, spec) {
    const ix = indexSpec(spec);
    const entries = [], photos = [], unmatched = [];
    const groupDefs = Object.values(spec.groups);
    const groups = {};                                  // groupKey → [{ idx, id }]
    const groupNames = [...new Set(groupDefs.map(g => g.name))];
    const headRe = new RegExp('^(' + groupNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ') (\\d+)$');
    let reportCreated = null;

    let section = null;
    const plainCur = new Map();                         // section → cursor into plain list
    let curGroup = null, curInst = null, groupCur = 0;
    let last = null;

    const isChrome = b => b.y0 < 40 && /^Page|Report Created|^\d+(?:\.\d)? - /.test(b.text);

    for (const page of pages) {
      const blocks = page.blocks;
      for (const b of blocks) {
        const m = b.text.match(/Report Created:\s*(\d\d\/\d\d\/\d{4})/);
        if (m && !reportCreated) reportCreated = m[1];
      }

      // Photo cards: caption, then a timestamp and a location block beneath it
      // in the same column. Captions are the only blocks that begin
      // "<section> - <title> / ", which is how they are told from fields.
      const caps = [];
      for (const b of blocks) {
        const t = norm(b.text);
        for (const [title, key] of ix.sectionByTitle) {
          if (t.startsWith(title + ' / ')) { caps.push({ b, key, rest: t.slice(title.length + 3) }); break; }
        }
      }
      const capSet = new Set(caps.map(c => c.b));
      const tsBlocks = blocks.filter(b => TS_RE.test(b.text));
      const locBlocks = blocks.filter(b => /^Loc:/.test(b.text.trim()));
      for (const c of caps) {
        const sameCol = x => Math.abs(x.x0 - c.b.x0) <= 12;
        const nextCapY = Math.max(-1e9, ...caps.filter(o => o !== c && sameCol(o.b) && o.b.y0 < c.b.y0).map(o => o.b.y0));
        const ts = tsBlocks.filter(x => sameCol(x) && x.y0 < c.b.y0 && x.y0 > nextCapY).sort((a, b) => b.y0 - a.y0)[0];
        const lc = locBlocks.filter(x => sameCol(x) && x.y0 < c.b.y0 && x.y0 > nextCapY).sort((a, b) => b.y0 - a.y0)[0];
        let loc = null;
        if (lc) {
          const lm = norm(lc.text).match(LOC_RE);
          if (lm) loc = { lat: +lm[1], lon: +lm[2], az: lm[3] != null ? +lm[3] : null, elv: lm[4] != null ? +lm[4] : null, alt: lm[5] != null ? +lm[5] : null };
        }
        // Group instances name themselves in the caption: "Mounting Plane MP1 / label".
        let rest = c.rest, groupKey = null, instId = null;
        for (const g of groupDefs) {
          if (g.section !== c.key) continue;
          if (rest.startsWith(g.name + ' ')) {
            const after = rest.slice(g.name.length + 1);
            const cut = after.indexOf(' / ');
            if (cut > 0) { groupKey = g.key; instId = after.slice(0, cut); rest = after.slice(cut + 3); break; }
          }
        }
        const L = tok(rest);
        const sec = ix.bySection.get(c.key);
        const pool = sec ? (groupKey ? (sec.groups.get(groupKey) || []) : sec.plain) : [];
        let cands = pool.filter(x => captionMatches(L, tok(x.label)));
        const exact = cands.filter(x => captionExact(L, tok(x.label)));
        cands = (exact.length ? exact : cands).map(x => x.key);
        photos.push({
          ref: cands[0] || null, cands, label: rest, section: c.key, group: groupKey, instance: instId,
          ts: ts ? norm(ts.text) : null, loc, page: page.n, cap: { x0: c.b.x0, y0: c.b.y0, y1: c.b.y1 },
        });
      }

      // Fields, top to bottom. Photo-grid blocks are skipped.
      const flow = blocks.filter(b => !capSet.has(b) && !TS_RE.test(b.text) && !/^Loc:/.test(b.text.trim()) && !isChrome(b))
        .sort((a, b) => b.y0 - a.y0 || a.x0 - b.x0);
      for (const b of flow) {
        const t = norm(b.text);
        if (ix.sectionByTitle.has(t)) { section = ix.sectionByTitle.get(t); curGroup = null; last = null; continue; }
        const hm = t.match(headRe);
        if (hm) {
          const g = groupDefs.find(x => x.name === hm[1] && x.section === section) || groupDefs.find(x => x.name === hm[1]);
          if (g) {
            curGroup = g.key; groupCur = 0; last = null;
            const list = groups[g.key] = groups[g.key] || [];
            curInst = { idx: Number(hm[2]), id: null };
            list.push(curInst);
            continue;
          }
        }
        if (!section) continue;
        const sec = ix.bySection.get(section);
        if (!sec) continue;
        const B = tok(t);
        const pool = curGroup ? (sec.groups.get(curGroup) || []) : sec.plain;
        let cur = curGroup ? groupCur : (plainCur.get(section) || 0);
        // Several template fields can print the identical label (one per answer
        // of a parent question). Take the one whose parent answer is on record.
        const idx = curInst ? curInst.idx : null;
        const valueOf = d => {
          const e = entries.find(x => x.ref === d.key && (!d.group || (x.instIdx === idx)) && norm(x.value));
          return e ? norm(e.value) : null;
        };
        // A block that is only the start of a longer label is a cut label; but a
        // short block that equals one field's label is that field, not a cut of
        // another — so an exact match outranks a prefix match.
        let hit = null, at = -1, loose = null, looseAt = -1, any = null, anyAt = -1;
        const tryRange = (from, to) => {
          for (let i = from; i < to && !hit; i++) {
            const r = alignLabel(B, tok(pool[i].label)); if (!r) continue;
            const ok = depOk(ix, pool[i], valueOf);
            if (ok && !r.truncated) { hit = r; at = i; }
            else if (ok && !loose) { loose = r; looseAt = i; }
            else if (!ok && !any) { any = r; anyAt = i; }
          }
        };
        tryRange(cur, pool.length);
        if (!hit) tryRange(0, cur);
        if (!hit && loose) { hit = loose; at = looseAt; }
        if (!hit && any) { hit = any; at = anyAt; }
        // A section heading can be missing from the flow (it sits in the footer
        // strip on a short last page). If the block is a long exact label of a
        // plain field in another section, trust the label over the bookkeeping.
        if (!hit && !curGroup && B.length >= 6) {
          for (const [sk, sc2] of ix.bySection) {
            if (sk === section) continue;
            const j = sc2.plain.findIndex(f => alignLabel(B, tok(f.label)));
            if (j >= 0) { section = sk; plainCur.set(sk, 0); hit = alignLabel(B, tok(sc2.plain[j].label)); at = j; break; }
          }
        }
        if (hit) {
          const f = (curGroup ? pool : ix.bySection.get(section).plain)[at];
          if (curGroup) groupCur = at + 1; else plainCur.set(section, at + 1);
          const e = { ref: f.key, label: f.label, section, group: curGroup, instance: curGroup ? (curInst && curInst.id) : null,
            instIdx: curGroup && curInst ? curInst.idx : null, value: hit.value, page: page.n, y0: b.y0, y1: b.y1 };
          entries.push(e);
          last = e;
          if (curGroup && curInst && spec.groups[curGroup].idKey === f.key && hit.value) {
            curInst.id = hit.value;
            // entries seen before the id was read belong to the same instance
            for (const x of entries) if (x.group === curGroup && x.instIdx === curInst.idx) x.instance = hit.value;
          }
        } else if (last && b.x0 >= 140 && b.y0 <= last.y0 + 6 && b.y0 >= last.y1 - 8) {
          last.value = norm(last.value + ' ' + t);
          if (curGroup && curInst && spec.groups[curGroup].idKey === last.ref) {
            curInst.id = last.value;
            for (const x of entries) if (x.group === curGroup && x.instIdx === curInst.idx) x.instance = last.value;
          }
        } else {
          unmatched.push({ text: t.slice(0, 140), page: page.n, section });
        }
      }
    }

    // Duplicate-label photo fields: the caption does not say which answer the
    // photo belongs to, the surveyor's own answer does.
    for (const ph of photos) {
      if (!ph.cands || ph.cands.length < 2) continue;
      const valueOf = d => {
        const e = entries.find(x => x.ref === d.key && (!d.group || x.instance === ph.instance) && norm(x.value));
        return e ? norm(e.value) : null;
      };
      const ok = ph.cands.find(k => depOk(ix, ix.byKey.get(k), valueOf));
      if (ok) ph.ref = ok;
    }
    const v = re => { const e = entries.find(x => re.test(x.label) && norm(x.value)); return e ? norm(e.value) : null; };
    // Earlier template versions label the project "Project ID" and print it
    // beside the label rather than as a field.
    let projectFallback = null;
    const p1 = pages[0] ? pages[0].blocks : [];
    const pid = p1.find(b => norm(b.text) === 'Project ID');
    if (pid) {
      const near = p1.filter(b => b !== pid && /^[0-9A-Za-z]{6,10}$/.test(norm(b.text)) && Math.abs(b.x0 - pid.x0) < 40 && Math.abs(b.y0 - pid.y0) < 60)
        .sort((a, b) => Math.abs(a.y0 - pid.y0) - Math.abs(b.y0 - pid.y0))[0];
      if (near) projectFallback = norm(near.text);
    }
    const meta = {
      project: v(/^Salesforce Project Name/i) || projectFallback,
      address: v(/^Customer Address/i),
      surveyor: v(/^Site Surveyor Name/i),
      assessmentDate: v(/^Assessment Date/i),
      reportCreated,
      pages: pages.length,
    };
    return makeSurvey({ template: { vendor: 'sitecapture', specId: spec.id }, meta, entries, photos, groups, unmatched });
  }

  // ── Radicl parser ──────────────────────────────────
  // Radicl lays a section out as label (left) and answer (right-aligned, same
  // row); photo pages are a grid of captions. A caption is cut at ~45
  // characters with an ellipsis, so refs are stored without it and matched by
  // regex. Panels number themselves "#1", "#2" in the label.
  // Radicl has already changed its template once (Aug 2026: "Inside Breaker
  // Box 1: Dead Front On"; Sep 2026: "Breaker Box / Electrical Panel #1 —
  // Dead Front…"), so a ref is canonical across versions: the family, then the
  // part, with the panel's position in `instance` ("in1" / "out1" for the older
  // inside/outside split, "1" for the newer single list).
  function radiclRef(label) {
    const l = norm(label).replace(/…$/, '').replace(/posi- tion/, 'position');
    let m = l.match(/^(Inside|Outside) Breaker Box (\d+):\s*(.*)$/);
    if (m) return { ref: `Breaker Box — ${m[3]}`.replace(/\s+$/, ''), instance: (m[1] === 'Inside' ? 'in' : 'out') + m[2] };
    m = l.match(/^Breaker Box \/ Electrical Panel #(\d+) — (.*)$/);
    if (m) return { ref: `Breaker Box — ${m[2]}`, instance: m[1] };
    // The September template also names an inside box "Interior Breaker Box:
    // Quantity #1 — ...", with or without a space after the colon.
    m = l.match(/^Interior Breaker Box:\s*Quantity #(\d+) — (.*)$/);
    if (m) return { ref: `Breaker Box — ${m[2]}`, instance: 'in' + m[1] };
    m = l.match(/^Possible Battery Location #(\d+): (.*)$/);
    if (m) return { ref: `Battery Location — ${m[2]}`, instance: m[1] };
    return { ref: l, instance: null };
  }
  const SPACED = s => String(s).replace(/\s+/g, '').toUpperCase();

  function parseRadicl(pages, opts) {
    const entries = [], photos = [];
    let section = null, photoSection = null;
    const meta = { vendor: 'radicl', pages: pages.length };
    const isChrome = b => (b.x0 >= 400 && b.y0 >= 800) || b.y0 < 40 || /^radicl$/i.test(b.text) || /^Site Survey Report$/i.test(b.text);

    // cover
    const p1 = pages[0] ? pages[0].blocks : [];
    for (const b of p1) {
      const lines = b.text.split('\n');
      const key = SPACED(lines[0]);
      if (key.startsWith('SURVEYDATE')) meta.surveyDate = norm(lines.slice(1).join(' '));
      if (key.startsWith('PHOTOSCAPTURED')) meta.photosCaptured = num(lines[1]);
      if (key.startsWith('SECTIONS')) meta.sections = num(lines[1]);
    }
    for (let i = 0; i < p1.length; i++) {
      if (p1[i].text === 'Site Address' && p1[i + 1]) meta.address = norm(p1[i + 1].text);
    }
    const addr = p1.find(b => b.y0 > 600 && b.y0 < 700 && /\d/.test(b.text));
    if (!meta.address && addr) meta.address = norm(addr.text.split('\n').slice(1).join(' '));

    for (const page of pages.slice(1)) {
      const flow = page.blocks.filter(b => !isChrome(b)).sort((a, b) => b.y0 - a.y0 || a.x0 - b.x0);
      let pendingLabels = [];
      const flush = () => {
        // pair each left-column label with the right-column blocks beside it
        pendingLabels.sort((a, b) => b.b.y0 - a.b.y0);
        const rights = flow.filter(b => b.x0 >= 150 && !pendingLabels.some(l => l.b === b) && b.y0 > 40);
        pendingLabels.forEach((l, i) => {
          const top = l.b.y0 + 3, bottom = i + 1 < pendingLabels.length ? pendingLabels[i + 1].b.y0 : -1e9;
          const val = rights.filter(r => r.y0 <= top && r.y0 > bottom).sort((a, b) => b.y0 - a.y0).map(r => norm(r.text)).join(' ');
          const { ref, instance } = radiclRef(norm(l.b.text));
          if (section) entries.push({ ref, label: norm(l.b.text), section, group: null, instance, value: val, page: page.n });
        });
        pendingLabels = [];
      };
      for (const b of flow) {
        const lines = b.text.split('\n');
        const key = SPACED(lines[0]);
        const sm = key.match(/^SECTION(\d+)$/);
        if (sm && lines[1]) { section = norm(lines.slice(1).join(' ')); photoSection = null; continue; }
        const ph = norm(b.text).match(/^(.+?) — Photos(?: \((\d+)\/(\d+)\))?$/);
        if (ph) { photoSection = ph[1]; continue; }
        if (photoSection) {
          if (b.x0 < 60 && /Page \d+/.test(b.text)) continue;
          const { ref, instance } = radiclRef(norm(b.text));
          photos.push({ ref, label: norm(b.text), section: photoSection, group: null, instance, ts: null, loc: null, page: page.n, cap: { x0: b.x0, y0: b.y0, y1: b.y1 } });
        } else if (b.x0 <= 60) {
          pendingLabels.push({ b });
        }
      }
      if (!photoSection) flush();
    }
    // Page 1 of the contents list is a list of section names with numbers.
    return makeSurvey({ template: { vendor: 'radicl', specId: opts && opts.specId || 'radicl' }, meta, entries, photos, groups: {}, unmatched: [] });
  }


  // ── Requirement resolution ─────────────────────────
  // A requirement names what satisfies it in each template. For Site Capture
  // that is a matcher over the spec (label regex, optional group and type), so
  // a re-numbered key or a new template version re-resolves instead of
  // breaking; for Radicl it is a regex over the normalized label.
  function scKeys(spec, matchers) {
    const out = [];
    for (const m of matchers || []) {
      for (const f of spec.fields) {
        if (m.group !== undefined && f.group !== m.group) continue;
        if (m.section && f.section !== m.section) continue;
        if (m.types && !m.types.includes(f.type)) continue;
        if (m.label.test(f.label) && !out.includes(f.key)) out.push(f.key);
      }
    }
    return out;
  }
  const specField = (spec, key) => spec.fields.find(f => f.key === key);

  // ── Layer B: design needs ──────────────────────────
  // severity: 'hard' stops a handoff, 'warn' asks for a look. Doug tunes these.
  // `sc` / `rd` null means that template has nothing that captures it — a
  // template gap. `applies(S)` true / false / null (null: the template cannot
  // say, which is itself reported as a gap when the item matters).
  const E = (lbl, n) => ({ enphase: lbl, enphaseN: n });
  const PANEL_SC = /^(MSP|SP\d+)$/;
  const REQUIREMENTS = [
    // ── Site / integrity
    { id: 'plane_count', area: 'Site', severity: 'hard', title: 'Mounting planes surveyed match the proposal',
      evidence: { rs: ['roofMeas', 'where'], note: 'Planes surveyed vs planes on the proposal' },
      fix: 'Radicl: ask how many planes the proposal shows, and record pitch and photos for each plane. Site Capture already asks.',
      custom(S, ctx) {
        if (S.template.vendor !== 'sitecapture') return { status: 'gap', standing: true, detail: 'Radicl does not record how many planes the proposal shows' };
        const asked = S.value('mounting_planes_how_many') || S.value('office_feedback_how_many_c1');
        const done = (S.groups.mounting_plane_roof || []).length;
        if (!asked) return { status: 'verify', detail: `${done} planes surveyed; the proposal count was not answered` };
        const n = Number(asked);
        if (done === n) return { status: 'pass', detail: `${done} planes` };
        return { status: 'miss', severity: done < n ? 'hard' : 'warn', detail: `${done} planes surveyed, proposal shows ${n}` };
      } },
    { id: 'site_map', area: 'Site', severity: 'hard', title: 'Site map with planes and equipment located',
      evidence: { rs: ['where'], enphase: 'Missing Top view image of new construction', enphaseN: 2 },
      sc: { match: [{ label: /^Site Map/ }], kind: 'photos', min: 1 }, rd: { match: [/^Layout Map$/], kind: 'photos', min: 1 } },
    { id: 'address_match', area: 'Site', severity: 'hard', title: 'Report address matches the Salesforce project',
      evidence: { enphase: 'Different address available', enphaseN: 1, rs: ['redo'] },
      custom(S, ctx) {
        if (!ctx || !ctx.sfAddress) return { status: 'na', detail: 'No Salesforce address supplied' };
        const a = (S.meta.address || '').toLowerCase(), b = String(ctx.sfAddress).toLowerCase();
        const n1 = (a.match(/\d{2,6}/) || [])[0], n2 = (b.match(/\d{2,6}/) || [])[0];
        if (n1 && n2 && n1 === n2) return { status: 'pass', detail: S.meta.address };
        return { status: 'miss', detail: `Report: ${S.meta.address || '(none)'} / Salesforce: ${ctx.sfAddress}` };
      } },
    { id: 'resource_match', area: 'Site', severity: 'warn', title: 'Report is from the resource Salesforce lists',
      evidence: {},
      custom(S, ctx) {
        if (!ctx || !ctx.sfResource) return { status: 'na', detail: 'No Salesforce resource supplied' };
        const want = S.template.vendor === 'radicl' ? 'Radicl Services' : 'SunPower Surveyor';
        if (ctx.sfResource === want) return { status: 'pass', detail: '' };
        return { status: 'miss', detail: `Salesforce lists ${ctx.sfResource}; this is a ${S.template.vendor === 'radicl' ? 'Radicl' : 'Site Capture (SPWR)'} report` };
      } },
    { id: 'photos_deleted', area: 'Site', severity: 'warn', title: 'No photos deleted before sync', vendors: ['sitecapture'],
      evidence: { rs: ['redo'] },
      custom(S) { const v = S.value('office_feedback_were_any'); if (v == null) return { status: 'verify', detail: 'Not answered' };
        return isYes(v) ? { status: 'miss', detail: 'Surveyor reports photos were deleted before sync' } : { status: 'pass', detail: '' }; } },
    { id: 'proposal_attached', area: 'Site', severity: 'warn', title: 'Proposal was attached to the appointment', vendors: ['sitecapture'],
      evidence: {},
      custom(S) { const v = S.value('office_feedback_was_the_p'); if (v == null) return { status: 'verify', detail: 'Not answered' };
        return isNo(v) ? { status: 'miss', detail: 'No proposal on the appointment, so plane count could not be checked on site' } : { status: 'pass', detail: '' }; } },
    { id: 'photo_provenance', area: 'Site', severity: 'warn', title: 'Photos taken on site, on the survey date', vendors: ['sitecapture'],
      evidence: { rs: ['redo'] },
      custom(S) {
        const ph = S.photos.filter(p => p.ts);
        if (!ph.length) return { status: 'verify', detail: 'No timestamps in the report' };
        const day = d => d.slice(0, 10);
        const days = {}; ph.forEach(p => { days[day(p.ts)] = (days[day(p.ts)] || 0) + 1; });
        const main = Object.entries(days).sort((a, b) => b[1] - a[1])[0];
        const off = ph.length - main[1];
        const locs = ph.filter(p => p.loc && (p.loc.lat || p.loc.lon));
        let far = 0;
        if (locs.length) {
          const med = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
          const ml = med(locs.map(p => p.loc.lat)), mo = med(locs.map(p => p.loc.lon));
          far = locs.filter(p => Math.hypot((p.loc.lat - ml) * 111000, (p.loc.lon - mo) * 111000 * Math.cos(ml * Math.PI / 180)) > 250).length;
        }
        const bits = [];
        if (off) bits.push(`${off} photo${off === 1 ? '' : 's'} taken on a different day than the main set (${main[0]})`);
        if (far) bits.push(`${far} photo${far === 1 ? '' : 's'} taken more than 250 m from the rest`);
        return bits.length ? { status: 'miss', detail: bits.join('; ') } : { status: 'pass', detail: '' };
      } },

    // ── Roof
    { id: 'roof_pitch', area: 'Roof', severity: 'hard', title: 'Roof pitch recorded for every plane',
      evidence: { ...E('Missing Roof Tilt & Attic Info', 20), rs: ['roofMeas'], guide: 'Rafter Depth / Vaulted Ceilings' },
      custom(S, ctx) {
        if (S.template.vendor === 'radicl') {
          const v = S.value(/^Roof Pitch \/ Slope Measurement$/);
          if (!v) return { status: 'miss', detail: 'No roof pitch recorded' };
          const rise = pitchRise(v);
          if (rise == null) {
            const ph = S.photoCount([/^Roof Pitch( \/ Slope)?$/]);
            const pe = S.entriesFor(/^Roof Pitch \/ Slope Measurement$/)[0];
            return { status: 'verify', page: pe && pe.page, detail: `Pitch "${v}" is not a number${ph ? `; ${ph} pitch photo${ph === 1 ? '' : 's'} in the report show it` : ''}` };
          }
          if (rise < 0 || rise > 18) return { status: 'miss', detail: `Pitch "${v}" is outside 0–18/12` };
          if (/panels|shop|garage|house/i.test(v)) return { status: 'verify', detail: `Pitch "${v}" mentions more than one structure` };
          return { status: 'pass', detail: `${v}` };
        }
        const keys = scKeys(ctx.spec, [{ label: /Tilt Reading/, group: 'mounting_plane_attic' }]);
        const bad = [], gaps = [];
        for (const id of S.instances('mounting_plane_attic')) {
          const vals = keys.map(k => S.value(k, id)).filter(Boolean);
          const photos = S.photoCount(scKeys(ctx.spec, [{ label: /10\+ Photos of ENTIRE attic/, group: 'mounting_plane_attic' }]), id);
          if (vals.some(x => { const n = num(x); return n != null && n >= 0 && n <= 90; })) continue;
          // No attic photos means no attic was entered; the form has no field for
          // pitch except through the attic, so that is the template, not the surveyor.
          (photos > 0 ? bad : gaps).push(id);
        }
        if (bad.length) return { status: 'miss', instances: bad, detail: `No tilt reading for ${bad.join(', ')}` };
        if (gaps.length) return { status: 'gap', standing: false, instances: gaps, detail: `No attic entered for ${gaps.join(', ')}; the form only collects tilt inside the attic group` };
        return { status: 'pass', detail: '' };
      } },
    { id: 'roof_overhang', area: 'Roof', severity: 'hard', title: 'Overhang / eave measurement',
      evidence: { ...E('Missing Overhang Measurement', 12), rs: ['roofMeas'] },
      sc: null, rd: { match: [/^Eave\/Soffit Measurement Photo$/], kind: 'photos', min: 1 },
      gap: 'Site Capture has no overhang or eave field',
      fix: 'Add a required overhang length (inches) and a photo with the tape visible, for every mounting plane.' },

    // ── Attic
    { id: 'attic_photos', area: 'Attic', severity: 'warn', title: 'Attic photographed for every plane',
      evidence: { ...E('Missing Roof Tilt & Attic Info', 20), rs: ['roofStruct'], guide: 'Overall Attic' },
      applies: (S) => S.template.vendor === 'radicl' ? (S.value(/^Is there attic access\?$/) ? isYes(S.value(/^Is there attic access\?$/)) : null) : true,
      sc: { per: 'mounting_plane_attic', match: [{ label: /10\+ Photos of ENTIRE attic/ }], kind: 'photos', min: 'label', zeroHard: true },
      rd: { match: [/^360 Degree photos in Attic$/], kind: 'photos', min: 8, zeroHard: true } },
    { id: 'attic_framing', area: 'Attic', severity: 'hard', title: 'Framing size and spacing recorded for every plane',
      evidence: { ...E('Missing Roof Tilt & Attic Info', 20), rs: ['roofStruct'], guide: 'Rafter Depth' },
      applies: (S) => S.template.vendor === 'radicl' ? (S.value(/^Is there attic access\?$/) ? isYes(S.value(/^Is there attic access\?$/)) : null) : true,
      sc: { per: 'mounting_plane_attic', match: [{ label: /Size and Spacing/, types: ['MULTI_SELECT'] }], kind: 'value' },
      rd: { match: [/^Rafter Spacing$/, /^Rafter Size$/], kind: 'value', all: true } },

    // ── Electrical
    { id: 'msp_location', area: 'Electrical', severity: 'hard', title: 'Panel location is clear (wall and room)', unit: 'panel',
      evidence: { ...E('MSP location not clear', 4), rs: ['where', 'panel'], guide: 'Main Service Panel / House around main panel' },
      sc: { equipment: [{ label: /^Location - 1\.\) 5\+ photos showing entire wall/, group: 'electrical_equipment' }], combo: [{ label: /^Exterior MSP - Location - 1\.\) 5\+/, group: 'electrical_meter' }], kind: 'photos', min: 1 },
      rd: { match: [/^Breaker Box — Location/], kind: 'photos', min: 1 } },
    { id: 'msp_dead_front_on', area: 'Electrical', severity: 'hard', title: 'Dead front on: breakers and main readable', unit: 'panel',
      evidence: { ...E('Missing MSP sticker and the main breaker rating is not visible', 5), rs: ['panel'], guide: 'Main Breaker / Main Breaker AMPS' },
      sc: { equipment: [{ label: /^Dead Front On/, group: 'electrical_equipment' }], combo: [{ label: /^Exterior MSP - Dead Front On/, group: 'electrical_meter' }], kind: 'photos', min: 1 },
      rd: { match: [/^Breaker Box — Dead Front( On)?$/], kind: 'photos', min: { 'radicl-v1': 1, 'radicl-v2': 2 }, noteV: { 'radicl-v2': 'The report cuts captions at "Dead Front…", so on and off cannot be told apart' } } },
    { id: 'msp_dead_front_off', area: 'Electrical', severity: 'hard', title: 'Dead front off: full panel, terminations', unit: 'panel',
      evidence: { ...E('MSP/Meter Photo', 6), rs: ['panel'], guide: 'Main Panel - Front Off' },
      sc: { equipment: [{ label: /^Dead Front Off - Full length/, group: 'electrical_equipment' }], combo: [{ label: /^Exterior MSP - Dead Front Off - Full length/, group: 'electrical_meter' }], kind: 'photos', min: 1 },
      rd: { match: [/^Breaker Box — Dead Front( Off)?$/], kind: 'photos', min: { 'radicl-v1': 1, 'radicl-v2': 2 }, noteV: { 'radicl-v2': 'The report cuts captions at "Dead Front…", so on and off cannot be told apart' } } },
    { id: 'msp_label', area: 'Electrical', severity: 'hard', title: 'Panel label readable and photographed', unit: 'panel',
      evidence: { ...E('Missing MSP sticker and the main breaker rating is not visible', 5), rs: ['panel'], guide: 'Main Service Panel Label' },
      sc: { equipment: [{ label: /^Labels - 1\.\) Take photos of ENTIRE panelboard label/, group: 'electrical_equipment' }], combo: [{ label: /^Exterior MSP - Labels - 1\./, group: 'electrical_meter' }], kind: 'photos', min: 1 },
      rd: { match: [/^Breaker Box — Panel La/], kind: 'photos', min: 1 } },
    { id: 'main_breaker_rating', area: 'Electrical', severity: 'hard', title: 'Main breaker rating recorded', unit: 'panel',
      evidence: { ...E('Missing MSP sticker and the main breaker rating is not visible', 5), rs: ['panel'], guide: 'Main Breaker AMPS' },
      sc: null, rd: { match: [/^Breaker Box — Main Breaker Rating/], kind: 'value' },
      gap: 'Site Capture has no numeric main breaker rating; ratings are photo only',
      fix: 'Add a required main breaker rating (amps) for every panel, beside the close-up photo.' },
    { id: 'bus_rating', area: 'Electrical', severity: 'warn', title: 'Bus rating recorded', unit: 'panel',
      evidence: { rs: ['panel'] },
      sc: { equipment: [{ label: /select bus rating/, group: 'electrical_equipment' }], combo: [{ label: /select bus rating/, group: 'electrical_meter' }], kind: 'value' },
      rd: { match: [/^Breaker Box — Max Bus Rating/], kind: 'value' } },
    { id: 'meter_closeup', area: 'Electrical', severity: 'hard', title: 'Meter close-up', 
      evidence: { ...E('MSP/Meter Photo', 6), rs: ['meter'], guide: 'Utility Meter' },
      sc: { match: [{ label: /close up of face of meter bulb/, group: 'electrical_meter' }], kind: 'photos', min: 1 },
      rd: { match: [/^Electric(al)? Meter: Close Up$/], kind: 'photos', min: 1 } },
    { id: 'meter_location', area: 'Electrical', severity: 'warn', title: 'Meter location context',
      evidence: { rs: ['meter', 'where'], guide: 'Utility Meter Location' },
      sc: { match: [{ label: /5\+ photo\(s\) of ENTIRE side of home the meter/, group: 'electrical_meter' }], kind: 'photos', min: 'label' },
      rd: { match: [/^Electric Meter: Location Photos$/], kind: 'photos', min: 1 } },
    { id: 'service_entrance', area: 'Electrical', severity: 'warn', title: 'Service entrance type',
      evidence: { rs: ['meter'] },
      sc: { match: [{ label: /Select Service Entrance Type/, group: 'electrical_meter' }], kind: 'value' },
      rd: { match: [/^(Electric Service Type|Overhead or Underground Service to Electric Meter\?)$/], kind: 'value' } },
    { id: 'service_voltage', area: 'Electrical', severity: 'warn', title: 'Service voltage and phase',
      evidence: E('Service voltage not clear', 2), sc: null, rd: null,
      gap: 'Neither template asks for service voltage or phase',
      fix: 'Add required service voltage (e.g. 120/240) and phase (single or three) beside the utility meter.' },
    { id: 'meter_main_open', area: 'Electrical', severity: 'warn', title: 'Meter/main combo: main enclosure open',
      evidence: E('Meter main open enclosure photo missing', 5), sc: null, rd: null,
      applies: (S) => S.template.vendor === 'sitecapture' ? S.entriesFor('utility_meter_is_the_msp_c1').some(e => isYes(e.value)) : null,
      gap: 'Neither template asks for the combo main enclosure photo',
      fix: 'When the meter is a meter/main combo, require a photo with the main enclosure open.' },
    { id: 'generator_details', area: 'Electrical', severity: 'warn', title: 'Generator make, model and output',
      evidence: E('Missing Generator Manufacturer, Generator Model Number, Generator Output (kW DC)', 1), sc: null,
      rd: [{ versions: ['radicl-v1'], match: [/^Backup Generator: Name Plate Label$/], kind: 'photos', min: 1 }],
      applies: (S) => S.template.vendor === 'sitecapture' ? ((v) => v == null ? null : isYes(v))(S.value(/^does_the_home_have_a_generator/)) : ((v) => v == null ? null : isYes(v))(S.value(/^(Generator|Is there a integrated backup generator on site\?)$/)),
      gap: 'Neither template asks for generator manufacturer, model or kW',
      fix: 'When a generator is present, require manufacturer, model and kW output, with a nameplate photo.' },

    // ── Existing system (the guide asks for wattage, inverter size and make)
    { id: 'existing_declared', area: 'Existing system', severity: 'warn', title: 'Existing solar declared',
      evidence: { ...E('Existing module and inverter Confirmation', 19), guide: 'Existing Panels' },
      sc: null, rd: { match: [/^(Existing Solar|Is there an existing solar system\?)$/], kind: 'value' },
      gap: 'Site Capture only asks about a retrofit, not whether solar already exists',
      fix: 'Ask whether solar already exists on the property, not only whether this survey is a retrofit.' },
    { id: 'existing_equipment', area: 'Existing system', severity: 'hard', title: 'Existing modules and inverter: make, model, count',
      evidence: { ...E('Existing module and inverter Confirmation', 19), rs: ['existing'], guide: 'Existing Panels' },
      sc: null, rd: null,
      applies: (S) => S.template.vendor === 'sitecapture' ? (S.entriesFor('is_this_survey_for_a_retr_c1').some(e => isYes(e.value)) ? true : false) : ((v) => v == null ? null : isYes(v))(S.value(/^(Existing Solar|Is there an existing solar system\?)$/)),
      gap: 'No field captures existing module or inverter make, model or count',
      fix: 'When solar exists, require module make, model and count and inverter make and model (nameplate photos), plus the interconnection method.' },
    { id: 'existing_interconnection', area: 'Existing system', severity: 'warn', title: 'Existing interconnection method photographed',
      evidence: E('Existing Interconnection Details missing', 2), rs: ['existing'],
      applies: (S) => S.template.vendor === 'sitecapture' ? S.entriesFor('is_this_survey_for_a_retr_c1').some(e => isYes(e.value)) : ((v) => v == null ? null : isYes(v))(S.value(/^(Existing Solar|Is there an existing solar system\?)$/)),
      sc: { match: [{ label: /interconnection method/ }], kind: 'photos', min: 1 }, rd: null,
      gap: 'Radicl has no interconnection photo for an existing system',
      fix: 'When solar exists, add a photo of the interconnection method (breaker or tap).' },

    // ── Battery
    { id: 'battery_location', area: 'Battery', severity: 'hard', title: 'Battery location documented',
      evidence: { rs: ['existing'], guide: 'Battery Requirements' },
      applies: (S) => S.template.vendor === 'sitecapture' ? ((v) => v == null ? null : isYes(v))(S.value('is_this_a_battery_survey')) : ((v) => v == null ? null : isYes(v))(S.value(/^Is battery location required\?$/)),
      sc: { match: [{ label: /^Floor plan of entire house/ }, { label: /^Sketch the wall that the battery/ }], kind: 'photos', min: 1 },
      rd: { match: [/Battery/i], kind: 'photos', min: 1 } },
  ];

  // "6/12", "4 in 12", "30.07 degree pitch", "26 degrees" → rise per 12
  function pitchRise(v) {
    const s = String(v).toLowerCase();
    let m = s.match(/(\d+(?:\.\d+)?)\s*(?:\/|in|:)\s*12/);
    if (m) return Number(m[1]);
    m = s.match(/(\d+(?:\.\d+)?)\s*(?:°|deg)/);
    if (m) return Math.tan(Number(m[1]) * Math.PI / 180) * 12;
    m = s.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
    return m ? Number(m[1]) : null;
  }

  // Evaluate one requirement for a survey.
  function evalRequirement(r, S, ctx) {
    const vendor = S.template.vendor;
    const base = { id: r.id, area: r.area, title: r.title, severity: r.severity, evidence: r.evidence || {}, vendor };
    if (r.vendors && !r.vendors.includes(vendor)) return null;
    if (r.applies) {
      const a = r.applies(S, ctx);
      if (a === false) return { ...base, status: 'na', detail: 'Does not apply to this survey' };
      if (a === null) {
        // The survey did not answer the question that decides whether this applies.
        // With nothing in the template to capture the item either, that is a gap;
        // otherwise there is nothing to hold the survey to.
        const has = vendor === 'sitecapture' ? r.sc : r.rd;
        if (!has) return { ...base, status: 'gap', standing: true, detail: r.gap || 'Template cannot say whether this applies' };
        return { ...base, status: 'na', detail: 'Not determined from the survey answers' };
      }
    }
    if (r.custom) return { ...base, ...r.custom(S, ctx) };
    let src = vendor === 'sitecapture' ? r.sc : r.rd;
    // A Radicl requirement may differ by template version (an older caption set).
    if (Array.isArray(src)) src = src.find(a => !a.versions || a.versions.includes(S.template.specId)) || null;
    // No field in this template captures it. "Standing" = true of every survey on
    // the template, whatever was answered; it is reported once as a template
    // problem and does not by itself change a survey's outcome. A gap that only
    // bites when the survey's own answers make the item apply is not standing.
    if (!src) return { ...base, status: 'gap', standing: !r.applies || r.applies(S, ctx) !== true, detail: r.gap || 'Not in this template' };

    // Which units (planes, panels) does this check run over?
    let units = [{ id: null, label: '' }];
    const photos = (u) => {
      if (vendor === 'sitecapture') {
        const keys = u && u.keys ? u.keys : scKeys(ctx.spec, src.match || []);
        return { photos: S.photosFor(keys, u && u.instance), keys };
      }
      return { photos: S.photosFor(src.match, u && u.instance), keys: src.match };
    };
    if (vendor === 'sitecapture' && src.per) units = S.instances(src.per).map(id => ({ id, label: id, instance: id }));
    if (r.unit === 'panel') {
      if (vendor === 'sitecapture') {
        units = [];
        for (const id of S.instances('electrical_equipment')) if (PANEL_SC.test(id)) units.push({ id, label: id, instance: id, keys: scKeys(ctx.spec, src.equipment), group: 'electrical_equipment' });
        for (const e of S.entriesFor('utility_meter_is_the_msp_c1')) if (isYes(e.value)) units.push({ id: e.instance, label: `${e.instance} (exterior MSP)`, instance: e.instance, keys: scKeys(ctx.spec, src.combo), group: 'electrical_meter' });
        if (!units.length) return { ...base, status: 'miss', detail: 'No panel documented', vendor };
      } else {
        const ids = new Set();
        for (const p of [...S.entries, ...S.photos]) if (/^Breaker Box — /.test(p.ref) && p.instance) ids.add(p.instance);
        // "Are there any breaker boxes outside? No" with only location photos under
        // an outside number is the location of the inside panel, not a second panel.
        const outside = S.value(/^Are there any breaker boxes outside\?$/);
        if (outside && isNo(outside)) for (const id of [...ids]) if (/^\d+$/.test(id) && !S.entries.some(e => /^Breaker Box — /.test(e.ref) && e.instance === id)) ids.delete(id);
        units = [...ids].sort().map(id => ({ id, label: /^(in|out)/.test(id) ? `${id[0] === 'i' ? 'Inside' : 'Outside'} panel ${id.replace(/\D/g, '')}` : `Panel #${id}`, instance: id }));
        if (!units.length) return { ...base, status: 'miss', detail: 'No panel documented' };
      }
    }
    const short = [];
    for (const u of units) {
      if (src.kind === 'photos') {
        const { photos: ph, keys } = photos(u);
        let min = (src.min && typeof src.min === 'object') ? (src.min[S.template.specId] != null ? src.min[S.template.specId] : 1) : src.min;
        if (min === 'label') min = Math.max(1, ...keys.map(k => (specField(ctx.spec, k) || {}).minPhotos || 1));
        if (ph.length < (min || 1)) short.push({ u, have: ph.length, need: min || 1 });
      } else {
        const refs = vendor === 'sitecapture' ? (u.keys || scKeys(ctx.spec, src.match || [])) : src.match;
        let ok;
        if (src.all) ok = src.match.every(m => S.value(m, u.instance) !== null);
        else ok = refs.length ? S.value(refs, u.instance) !== null : false;
        if (!ok) short.push({ u, have: 0, need: 1 });
      }
    }
    const note = src.note || (src.noteV && src.noteV[S.template.specId]) || null;
    if (!short.length) {
      const first = note && src.kind === 'photos' ? photos(units[0]).photos[0] : null;
      return { ...base, status: 'pass', detail: '', verify: !!note, note, page: first ? first.page : undefined };
    }
    const zero = short.some(x => x.have === 0);
    const sev = src.zeroHard ? (zero ? 'hard' : 'warn') : r.severity;
    const detail = short.map(x => src.kind === 'photos'
      ? `${x.u.label ? x.u.label + ': ' : ''}${x.have} of ${x.need}+ photos`
      : `${x.u.label ? x.u.label + ': ' : ''}not recorded`).join('; ');
    return { ...base, severity: sev, status: 'miss', detail, instances: short.map(x => x.u.id).filter(Boolean) };
  }

  // ── Layer A: template completeness (Site Capture) ──
  function completenessSC(S, spec, skipKeys) {
    const ix = indexSpec(spec);
    const out = [];
    const dep = (f, inst) => depOk(ix, f, d => S.value(d.key, d.group ? inst : null));
    for (const f of spec.fields) {
      if (skipKeys.has(f.key)) continue;
      if (!f.required && !f.photoRequired) continue;
      if (/^(7|8|9)_/.test(f.section) || /^Additional Structures/.test(f.label)) continue;   // outbuilding sections are conditional on 6
      const insts = f.group ? S.instances(f.group) : [null];
      for (const inst of insts) {
        if (f.group && inst == null) continue;
        if (!dep(f, inst)) continue;
        const v = S.value(f.key, inst), n = S.photoCount(f.key, inst);
        const isPhoto = f.type === 'FOTO' || f.photoRequired;
        if (isPhoto) {
          const need = f.minPhotos || 1;
          if (n === 0) out.push({ layer: 'A', id: 'tpl:' + f.key, area: sectionName(f.section), status: 'miss', severity: f.type === 'FOTO' ? 'hard' : 'warn', title: shortLabel(f.label), detail: `${inst ? inst + ': ' : ''}no photos`, vendor: 'sitecapture' });
          else if (n < need) out.push({ layer: 'A', id: 'tpl:' + f.key, area: sectionName(f.section), status: 'miss', severity: 'warn', title: shortLabel(f.label), detail: `${inst ? inst + ': ' : ''}${n} of ${need}+ photos`, vendor: 'sitecapture' });
        } else if (v == null) {
          out.push({ layer: 'A', id: 'tpl:' + f.key, area: sectionName(f.section), status: 'miss', severity: 'warn', title: shortLabel(f.label), detail: `${inst ? inst + ': ' : ''}not answered`, vendor: 'sitecapture' });
        }
      }
    }
    return out;
  }
  const sectionName = k => String(k).replace(/^\d+(?:\.\d)?_?/, '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) || 'Other';
  // A template label is often the whole instruction ("5+ overlapping photos
  // covering each section under the MP (left, middle-left, ...)"). A finding
  // needs the name of the thing, so cut at the first sentence or aside.
  const shortLabel = l => {
    let t = norm(l).replace(/\b\d\.?\)\s*/g, '').split(/\.\s|\s\(|\?\s|:\s/)[0].replace(/[.\s]+$/, '');
    if (t.length > 72) t = t.slice(0, Math.max(40, t.lastIndexOf(' ', 69))) + '…';
    return t;
  };

  // ── Layer A-lite (Radicl) ──────────────────────────
  // Radicl publishes no template file, so its standard is what good surveys
  // contain: spec.photos lists the captions every reference survey carried and
  // the fewest each one had. Provisional until Radicl's template is seen.
  function completenessRadicl(S, spec) {
    const out = [];
    // One reference survey says what that survey had, not what a survey needs.
    if (!spec.core || (spec.inferredFrom || 0) < 3) return out;
    const panelIds = new Set();
    for (const p of [...S.entries, ...S.photos]) if (/^Breaker Box — /.test(p.ref) && p.instance) panelIds.add(p.instance);
    for (const c of spec.core || []) {
      const ids = c.perInstance ? [...panelIds] : [null];
      for (const id of ids) {
        const n = S.photos.filter(p => p.ref === c.ref && (id == null || p.instance === id)).length;
        const where = id ? `Panel ${id}: ` : '';
        if (n === 0) out.push({ layer: 'A', id: 'tpl:' + c.ref, area: c.section, status: 'miss', severity: 'warn', title: c.ref, detail: `${where}no photos (every reference survey has this)`, vendor: 'radicl' });
        else if (n < c.min) out.push({ layer: 'A', id: 'tpl:' + c.ref, area: c.section, status: 'miss', severity: 'warn', title: c.ref, detail: `${where}${n} photos; the reference surveys had at least ${c.min}`, vendor: 'radicl' });
      }
    }
    return out;
  }

  // What this report carries that the spec has never seen. For Radicl that is
  // either a branch no reference survey took or a changed template; for Site
  // Capture it is blocks that matched no field. Either way it is the prompt to
  // look at the template.
  function newToSpec(S, spec) {
    if (!spec) return [];
    if (S.template.vendor === 'radicl') {
      const f = new Set((spec.fields || []).map(x => x.ref)), p = new Set((spec.photos || []).map(x => x.ref));
      return [...new Set([
        ...S.entries.filter(e => !f.has(e.ref)).map(e => 'field: ' + e.ref),
        ...S.photos.filter(x => !p.has(x.ref)).map(x => 'photo: ' + x.ref),
      ])];
    }
    return S.unmatched.filter(u => /[?:]$|\s-\s/.test(u.text) && u.text.length > 14).map(u => 'block: ' + u.text);
  }

  // The outcome a set of findings points to. Separate from evaluate() so the QA
  // page can add what a person saw in a photo and re-ask the same question.
  function outcomeOf(findings) {
    const miss = findings.filter(f => f.status === 'miss');
    const gap = findings.filter(f => f.status === 'gap');
    const verify = findings.filter(f => f.status === 'verify' || f.verify);
    const hard = miss.filter(f => f.severity === 'hard');
    let suggested = 'Passed';
    if (hard.length) suggested = 'Failed - Gaps Found';
    else if (miss.length) suggested = 'Needs review';
    else if (gap.some(f => f.severity === 'hard' && !f.standing)) suggested = 'Passed with Override';
    return {
      suggestedStatus: suggested,
      counts: { missHard: hard.length, missWarn: miss.length - hard.length, gap: gap.filter(f => !f.standing).length, standingGaps: gap.filter(f => f.standing).length, verify: verify.length,
        pass: findings.filter(f => f.status === 'pass').length, na: findings.filter(f => f.status === 'na').length },
    };
  }

  // ── Run everything ─────────────────────────────────
  // The page of the report where a requirement's answer or photos are printed, so a
  // finding can open the PDF at the right place. First match wins; none is fine.
  function pageOf(r, S, ctx) {
    try {
      const vendor = S.template.vendor;
      let src = vendor === 'sitecapture' ? r.sc : r.rd;
      if (Array.isArray(src)) src = src.find(a => !a.versions || a.versions.includes(S.template.specId)) || null;
      if (!src) return null;
      const refs = [];
      if (vendor === 'sitecapture') for (const k of [].concat(src.match || [], src.equipment || [], src.combo || [])) refs.push(...scKeys(ctx.spec, [k]));
      else refs.push(...[].concat(src.match || []));
      const hit = p => refs.some(x => x instanceof RegExp ? x.test(p.ref || '') : x === p.ref);
      const found = S.entries.find(hit) || S.photos.find(hit);
      return found && found.page ? found.page : null;
    } catch (e) { return null; }
  }
  function evaluate(S, specs, ctx) {
    ctx = ctx || {};
    const spec = (specs || []).find(s => s.id === S.template.specId) || null;
    ctx.spec = spec;
    const findings = [];
    for (const r of REQUIREMENTS) {
      // Settings can turn a check off, or make it Required ('hard') or Flagged ('warn').
      const set = ctx.checks && ctx.checks[r.id];
      if (set === 'off') continue;
      const res = evalRequirement(r, S, ctx);
      if (res && (set === 'hard' || set === 'warn')) res.severity = set;
      if (res && res.page == null) { const pg = pageOf(r, S, ctx); if (pg) res.page = pg; }
      if (res) findings.push({ layer: 'B', ...res });
    }
    // Layer A: whatever the template requires that no design need already speaks to.
    let referenced = new Set();
    if (spec && S.template.vendor === 'sitecapture') {
      for (const r of REQUIREMENTS) if (r.sc) {
        for (const k of [...scKeys(spec, r.sc.match), ...scKeys(spec, r.sc.equipment), ...scKeys(spec, r.sc.combo)]) referenced.add(k);
      }
      referenced.add('mp1_rafter_tilt_reading_t');
      referenced.add('did_you_call_design_to_cl');             // the closeout call is not something QA asks for
      for (const k of scKeys(spec, [{ label: /Tilt Reading/, group: 'mounting_plane_attic' }])) referenced.add(k);
      findings.push(...completenessSC(S, spec, referenced));
    } else if (spec && S.template.vendor === 'radicl') {
      findings.push(...completenessRadicl(S, spec));
    }

    const o = outcomeOf(findings);
    return {
      template: S.template, meta: S.meta, suggestedStatus: o.suggestedStatus, findings, counts: o.counts,
      templateReport: { unmatched: S.unmatched, unknownPhotos: S.photos.filter(p => !p.ref).length, newToSpec: newToSpec(S, spec) },
    };
  }

  // ── Photo pack ─────────────────────────────────────
  // Site Capture exports a survey's original photos as
  //   <N - Section>/<field label cut to 70 chars>[-k]/<label>-<i>.jpg
  // The photos carry no EXIF and the folder name is the only caption, but it is
  // enough: the section and the cut label name the field, and -k is the group
  // instance (none = the first, -2 = the second ...), inserted before the last
  // "." of the name or appended when it has none. Counts per folder should equal
  // the report's own, which is how a pack is checked against the PDF it came with.
  function indexPhotoPack(names, spec) {
    const ix = indexSpec(spec);
    const secKey = new Map(spec.sections.map(sec => [norm(sec.title), sec.key]));
    const labels = spec.fields.map(f => ({ key: f.key, a: alnum(f.label), section: f.section, group: f.group }));
    const out = [];
    for (const path of names) {
      const parts = path.split('/');
      if (parts.length < 3 || !/\.(jpe?g|png|heic)$/i.test(path)) continue;
      const section = secKey.get(norm(parts[0]));
      if (!section) { out.push({ path, section: null, cands: [], k: 1 }); continue; }
      const folder = parts[1];
      const fileNo = Number((parts[parts.length - 1].match(/-(\d+)\.[a-z]+$/i) || [])[1] || 0);
      const tries = [{ name: folder, k: 1 }];
      const m = folder.match(/^(.*?)-(\d+)(\.[^.]*)?$/);
      if (m && !/\s$/.test(m[1])) tries.unshift({ name: m[1] + (m[3] || ''), k: Number(m[2]) });
      let best = null;
      for (const t of tries) {
        const a = alnum(t.name);
        if (a.length < 12) continue;
        const cands = labels.filter(l => l.section === section && l.a.startsWith(a));
        if (cands.length) { best = { cands: cands.map(c => c.key), group: cands[0].group, k: t.k, base: a }; break; }
      }
      out.push({ path, folder, section, fileNo, cands: best ? best.cands : [], group: best ? best.group : null, k: best ? best.k : 1, base: best ? best.base : folder });
    }
    return out;
  }

  // Radicl's image folder is flat: "Section_Field name_N.jpg", N counting from 0 within
  // a field. Names drop the spaces and punctuation of the caption, so both sides are
  // compared as letters and digits only.
  function indexRadiclPack(names) {
    const out = [];
    for (const path of names) {
      if (!/\.(jpe?g|png|heic)$/i.test(path)) continue;
      const file = path.split('/').pop();
      const m = file.match(/^(.*)_(\d+)\.[a-z]+$/i);
      if (m) out.push({ path, stem: alnum(m[1].replace(/_/g, '')), fileNo: Number(m[2]) });
    }
    return out;
  }
  // A report caption cut short ("Dead Front…") matches every field that begins with it
  // ("Dead Front On", "Dead Front Off"). The report lists those photos in the template's
  // order, On before Off, so when the report's count equals the files in those fields
  // the k-th photo is the k-th file; any other count and the files are not used.
  function radiclPackFile(S, pack, ph) {
    const label = String(ph.label || ''), cut = /…|\.\.\./.test(label);
    const cap = alnum(String(ph.section || '') + label.replace(/…|\.\.\./g, ''));
    const stems = [...new Set(pack.map(e => e.stem))].filter(st => cut ? st.startsWith(cap) : st === cap);
    if (!stems.length) return null;
    const mine = S.photos.filter(q => q.section === ph.section && q.label === ph.label);
    if (!cut) {
      const n = S.photos.filter(q => q.ref === ph.ref && q.instance === ph.instance).indexOf(ph);
      const hit = pack.find(e => e.stem === stems[0] && e.fileNo === n);
      return hit ? hit.path : null;
    }
    const files = stems.sort((x, y) => x.length - y.length || (x < y ? -1 : 1)).flatMap(st => pack.filter(e => e.stem === st).sort((x, y) => x.fileNo - y.fileNo));
    return files.length === mine.length ? files[mine.indexOf(ph)].path : null;
  }
  function crossCheckRadiclPack(S, pack) {
    const stems = new Set(pack.map(e => e.stem));
    const used = new Set();
    for (const p of S.photos) { const f = radiclPackFile(S, pack, p); const e = f && pack.find(x => x.path === f); if (e) used.add(e.stem); }
    return { packPhotos: pack.length, folders: stems.size, matched: used.size, mismatches: [], unmapped: [] };
  }

  // Compare a pack's folders with the report's own photo counts.
  function crossCheckPack(S, pack) {
    const byFolder = new Map();
    for (const e of pack) {
      const key = e.section + '|' + (e.folder || '');
      if (!byFolder.has(key)) byFolder.set(key, { e, n: 0 });
      byFolder.get(key).n++;
    }
    const mismatches = [], unmapped = [];
    let matched = 0;
    // The export numbers a repeated folder name -2, -3 ... whether the repeat is
    // a second group instance or a different field whose label starts the same
    // way ("Dead Front Off - Photos of ALL labels inside the electrical panel
    // and" belongs to both the meter and the equipment group). When a numbered
    // folder disagrees with the report, the whole family of that name is
    // compared instead: same photos in total is the same survey.
    const family = new Map();
    for (const { e, n } of byFolder.values()) {
      const fk = e.section + '|' + e.base;
      family.set(fk, (family.get(fk) || 0) + n);
    }
    const famPdf = new Map();
    const pdfFor = e => {
      const insts = e.group ? (S.groups[e.group] || []).slice().sort((a, b) => a.idx - b.idx) : null;
      const id = insts ? (insts[e.k - 1] || {}).id : null;
      return { id, n: S.photos.filter(p => e.cands.includes(p.ref) && (!e.group || p.instance === id)).length };
    };
    for (const { e } of byFolder.values()) {
      if (!e.cands.length) continue;
      const fk = e.section + '|' + e.base;
      if (!famPdf.has(fk)) famPdf.set(fk, S.photos.filter(p => e.cands.includes(p.ref)).length);
    }
    for (const { e, n } of byFolder.values()) {
      if (!e.cands.length) { unmapped.push(e.folder || e.path); continue; }
      const { id, n: pdf } = pdfFor(e);
      const fk = e.section + '|' + e.base;
      if (pdf === n || family.get(fk) === famPdf.get(fk)) matched++;
      else mismatches.push({ folder: e.folder, instance: id, pack: n, report: pdf });
    }
    // Photos the report lists that no folder in the pack covers.
    const missing = [];
    const seen = new Set();
    for (const p of S.photos) {
      const k = p.ref + '|' + p.instance;
      if (seen.has(k) || !p.ref) continue;
      seen.add(k);
      const covered = [...byFolder.values()].some(({ e }) => {
        if (!e.cands.includes(p.ref)) return false;
        if (!e.group) return true;
        const insts = (S.groups[e.group] || []).slice().sort((a, b) => a.idx - b.idx);
        return (insts[e.k - 1] || {}).id === p.instance || family.has(e.section + '|' + e.base) && e.k > 1;
      });
      if (!covered) missing.push({ ref: p.ref, instance: p.instance });
    }
    for (const m of missing) mismatches.push({ folder: null, instance: m.instance, pack: 0, report: S.photos.filter(p => p.ref === m.ref && p.instance === m.instance).length });
    return { folders: byFolder.size, matched, mismatches, unmapped, packPhotos: pack.length, reportPhotos: S.photos.length };
  }

  // ── Template changes ───────────────────────────────
  // What each template needs so a surveyor can do what Design asks. Built from
  // the requirement gaps plus the few problems that are not a missing field.
  const TEMPLATE_EXTRAS = [
    { specs: ['sitecapture-v13'], id: 'pitch_without_attic', severity: 'hard', title: 'Roof pitch without the attic',
      evidence: { enphase: 'Missing Roof Tilt & Attic Info', enphaseN: 20 },
      fix: 'Add a required roof pitch (a number) with a level or inclinometer photo for every plane, independent of attic access. Today a tilt reading exists only inside the attic group.' },
    { specs: ['radicl-v2'], id: 'caption_cut', severity: 'warn', title: 'Photo captions cut in the report',
      evidence: {},
      fix: 'Shorten the panel caption prefix, or ship full captions, so "Dead Front On" and "Dead Front Off" survive the report\'s 45-character cut. The report currently prints both as "Dead Front…".' },
    { specs: ['radicl-v1', 'radicl-v2'], id: 'pitch_format', severity: 'warn', title: 'Roof pitch is free text',
      evidence: { enphase: 'Missing Roof Tilt & Attic Info', enphaseN: 20 },
      fix: 'Record pitch as a number with a unit (rise per 12, or degrees), per plane. Reports hold "6/12", "30.07 degree pitch" and "5 in 12 for house. Panels are going on the shop".' },
  ];
  function templateChanges(specId) {
    const vendor = /^radicl/.test(specId) ? 'radicl' : 'sitecapture';
    const out = [];
    for (const r of REQUIREMENTS) {
      if (r.custom && r.id !== 'plane_count') continue;
      const src = vendor === 'sitecapture' ? r.sc : r.rd;
      const gapped = r.custom ? vendor === 'radicl' : (Array.isArray(src) ? !src.some(a => !a.versions || a.versions.includes(specId)) : !src);
      if (!gapped || !r.fix) continue;
      if (r.vendors && !r.vendors.includes(vendor)) continue;
      out.push({ id: r.id, title: r.title, severity: r.severity, evidence: r.evidence || {}, fix: r.fix, gap: r.gap });
    }
    for (const x of TEMPLATE_EXTRAS) if (x.specs.includes(specId)) out.push({ id: x.id, title: x.title, severity: x.severity, evidence: x.evidence, fix: x.fix });
    const rank = { hard: 0, warn: 1 };
    return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.evidence.enphaseN || 0) - (a.evidence.enphaseN || 0));
  }

  // ── The checklist ──────────────────────────────────
  // What a survey on this template is checked for, in plain words, with the ones
  // the template cannot capture marked. Shown before a report is loaded so the
  // standard is never a surprise. Every field the template itself requires is
  // checked as well (Layer A) and is not listed here.
  const AREA_ORDER = ['Site', 'Roof', 'Attic', 'Electrical', 'Existing system', 'Battery'];
  // Every check once, with the default weight and which survey types can answer it.
  function allChecks() {
    return REQUIREMENTS.map(r => ({ id: r.id, area: r.area, title: r.title, severity: r.severity, vendors: r.vendors || ['sitecapture', 'radicl'] }))
      .sort((a, b) => AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area));
  }
  function checklist(specId, checks) {
    const vendor = /^radicl/.test(specId) ? 'radicl' : 'sitecapture';
    return REQUIREMENTS.filter(r => (!r.vendors || r.vendors.includes(vendor)) && !(checks && checks[r.id] === 'off')).map(r => {
      const src = vendor === 'sitecapture' ? r.sc : r.rd;
      const inTemplate = r.custom ? !(r.id === 'plane_count' && vendor === 'radicl')
        : Array.isArray(src) ? src.some(a => !a.versions || a.versions.includes(specId)) : !!src;
      const set = checks && checks[r.id];
      return { id: r.id, area: r.area, title: r.title, severity: set === 'hard' || set === 'warn' ? set : r.severity, inTemplate };
    }).sort((a, b) => AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area));
  }

  // ── Key photos ─────────────────────────────────────
  // The handful of photos a person (or, later, a model) has to LOOK at: a count
  // says a photo exists, not that the breaker rating can be read. One or two per
  // check, per plane or panel where the check is per plane or panel.
  const KEY_PHOTOS = [
    { id: 'breaker', label: 'Main breaker and ratings', per: 'panel', max: 2,
      sc: { equipment: [{ label: /^Dead Front On/, group: 'electrical_equipment' }], combo: [{ label: /^Exterior MSP - Dead Front On/, group: 'electrical_meter' }] },
      rd: [/^Breaker Box — Dead Front( On)?$/] },
    { id: 'label', label: 'Panel label', per: 'panel', max: 1,
      sc: { equipment: [{ label: /^Labels - 1\.\) Take photos of ENTIRE panelboard label/, group: 'electrical_equipment' }], combo: [{ label: /^Exterior MSP - Labels - 1\./, group: 'electrical_meter' }] },
      rd: [/^Breaker Box — Panel La/] },
    { id: 'meter', label: 'Meter', per: null, max: 1,
      sc: { match: [{ label: /close up of face of meter bulb/, group: 'electrical_meter' }] }, rd: [/^Electric(al)? Meter: Close Up$/] },
    { id: 'pitch', label: 'Pitch / tilt reading', per: 'plane', max: 1,
      sc: { match: [{ label: /Tilt Reading/, group: 'mounting_plane_attic' }] }, rd: [/^Roof Pitch( \/ Slope)?$/] },
    { id: 'framing', label: 'Rafter size', per: 'plane', max: 1,
      sc: { match: [{ label: /Size and Spacing/, group: 'mounting_plane_attic', types: ['MULTI_SELECT'] }] }, rd: [/^Rafter Measurement Photos$/] },
    { id: 'eave', label: 'Eave / overhang', per: null, max: 1, sc: null, rd: [/^Eave\/Soffit Measurement Photo$/] },
  ];

  function keyPhotos(S, spec, opts) {
    const every = !!(opts && opts.all);
    const out = [];
    const sc = S.template.vendor === 'sitecapture';
    for (const k of KEY_PHOTOS) {
      const src = sc ? k.sc : k.rd;
      if (!src) continue;
      const units = [];
      if (sc && k.per === 'plane') for (const id of S.instances('mounting_plane_attic')) units.push({ id, keys: scKeys(spec, src.match) });
      else if (sc && k.per === 'panel') {
        for (const id of S.instances('electrical_equipment')) if (PANEL_SC.test(id)) units.push({ id, keys: scKeys(spec, src.equipment) });
        for (const e of S.entriesFor('utility_meter_is_the_msp_c1')) if (isYes(e.value)) units.push({ id: e.instance, keys: scKeys(spec, src.combo), exterior: true });
      } else if (sc) units.push({ id: null, keys: scKeys(spec, src.match) });
      else if (k.per === 'panel') {
        const ids = new Set(S.photos.filter(p => /^Breaker Box — /.test(p.ref) && p.instance).map(p => p.instance));
        for (const id of [...ids].sort()) units.push({ id, keys: src });
      } else units.push({ id: null, keys: src });
      for (const u of units) {
        const all = S.photos.filter(p => u.keys.some(x => x instanceof RegExp ? x.test(p.ref || '') : x === p.ref) && (u.id == null || p.instance === u.id));
        all.slice(0, every ? all.length : k.max).forEach(p => {
          const n = S.photos.filter(q => q.ref === p.ref && q.instance === p.instance).indexOf(p) + 1;
          out.push({ id: k.id, label: k.label, unit: u.id, exterior: !!u.exterior, photo: p, n });
        });
      }
    }
    return out;
  }

  // Which file in a Site Capture pack is this report photo? Folder by field and
  // plane, file by the photo's place among its siblings.
  function packFile(S, pack, ph) {
    const insts = g => (S.groups[g] || []).slice().sort((a, b) => a.idx - b.idx);
    const n = S.photos.filter(q => q.ref === ph.ref && q.instance === ph.instance).indexOf(ph) + 1;
    const hit = pack.find(e => e.cands.includes(ph.ref) && e.fileNo === n && (!e.group || (insts(e.group)[e.k - 1] || {}).id === ph.instance));
    return hit ? hit.path : null;
  }

  // ── Template coverage ──────────────────────────────
  // Two directions, both about keeping the template honest.
  //   gaps    — a design need no template field captures
  //   unwatched — template fields no design need or completeness rule reads
  function templateCoverage(spec) {
    const refKeys = new Set();
    const gaps = [];
    for (const r of REQUIREMENTS) {
      if (r.custom) continue;
      if (spec.vendor === 'sitecapture') {
        if (!r.sc) { gaps.push({ id: r.id, title: r.title, severity: r.severity, gap: r.gap, evidence: r.evidence }); continue; }
        for (const k of [...scKeys(spec, r.sc.match), ...scKeys(spec, r.sc.equipment), ...scKeys(spec, r.sc.combo)]) refKeys.add(k);
      } else if (!r.rd) gaps.push({ id: r.id, title: r.title, severity: r.severity, gap: r.gap, evidence: r.evidence });
    }
    const unwatched = spec.fields ? spec.fields.filter(f => !refKeys.has(f.key) && !f.required && !f.photoRequired).map(f => ({ key: f.key, label: shortLabel(f.label) })) : [];
    return { gaps, unwatched: unwatched.length, unwatchedSample: unwatched.slice(0, 5) };
  }

  // ── Salesforce hand-off ────────────────────────────
  // Exact picklist labels and a summary short enough to paste. One line per
  // thing the coordinator or the surveyor has to act on; gaps are listed apart
  // so they are never read as a surveyor miss.
  const SF_STATUS = ['Passed', 'Failed - Gaps Found', 'Passed with Override'];
  function summarize(result, opts) {
    opts = opts || {};
    const f = result.findings;
    const miss = f.filter(x => x.status === 'miss');
    const gaps = f.filter(x => x.status === 'gap' && x.severity === 'hard' && !x.standing);
    const standing = f.filter(x => x.status === 'gap' && x.standing);
    const lines = [];
    const tpl = result.template.vendor === 'sitecapture' ? 'Site Capture' : result.template.vendor === 'radicl' ? 'Radicl' : 'Unknown template';
    lines.push(`QA review ${opts.reviewNumber || 1}${opts.reviewTotal ? ' of ' + opts.reviewTotal : ''} · ${tpl} · report ${result.meta.reportCreated || result.meta.surveyDate || 'date n/a'}`);
    const hardMiss = miss.filter(x => x.severity === 'hard'), warnMiss = miss.filter(x => x.severity !== 'hard');
    if (hardMiss.length) {
      lines.push('Needs go back / follow-up:');
      for (const m of hardMiss.slice(0, 12)) lines.push(`- ${m.title}: ${m.detail}`);
    }
    if (warnMiss.length) {
      lines.push(hardMiss.length ? 'Also noted:' : 'Noted:');
      for (const m of warnMiss.slice(0, 8)) lines.push(`- ${m.title}: ${m.detail}`);
      if (warnMiss.length > 8) lines.push(`- (+${warnMiss.length - 8} more)`);
    }
    if (!miss.length) lines.push('No missing items.');
    if (gaps.length) lines.push(`Template gap on this survey (not the surveyor): ${gaps.map(g => g.title).join('; ')}.`);
    if (standing.length) lines.push(`Standing template gaps: ${standing.map(g => g.title).join('; ')}.`);
    if (opts.override) lines.push(`Override: ${opts.override}`);
    const status = opts.status || result.suggestedStatus;
    return { status: SF_STATUS.includes(status) ? status : null, text: lines.join('\n') };
  }

  return {
    norm, tok, alnum, captionExact, isYes, isNo, num,
    alignLabel, captionMatches, detectTemplate, indexSpec, makeSurvey,
    parseSiteCapture, parseRadicl, radiclRef,
    REQUIREMENTS, evaluate, templateCoverage, summarize, scKeys, pitchRise, SF_STATUS,
    outcomeOf, checklist, AREA_ORDER, indexPhotoPack, crossCheckPack, indexRadiclPack, radiclPackFile, crossCheckRadiclPack, templateChanges, allChecks, keyPhotos, packFile, KEY_PHOTOS,
  };
});
