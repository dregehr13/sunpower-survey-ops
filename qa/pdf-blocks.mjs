// qa/pdf-blocks.mjs — PDF → pages of positioned text blocks.
//
// The only module in the QA pipeline that touches a PDF library. Everything
// downstream (lib/qa.cjs) reads plain {x0,y0,x1,y1,text} blocks, so the rules
// engine is testable without a PDF and the extractor can be swapped (or run in
// the browser, which pdf.js also supports) without touching a rule.
//
// Block assembly: pdf.js yields one item per text run. Runs on the same
// baseline are joined into lines (split where a wide gap means a second
// column), and lines that start at the same x and sit close together are one
// block — which is how Site Capture lays out a field, value over label.
//
// Runs in Node (the CLI and the tests) and in the browser (the QA page). The
// browser hands in a pdf.js it loaded from a CDN; Node loads its own.
let _pdfjs;
async function pdfjs(opts) {
  if (opts && opts.pdfjs) return opts.pdfjs;
  if (!_pdfjs) _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return _pdfjs;
}
async function openDoc(src, opts) {
  const lib = await pdfjs(opts);
  let data = src;
  if (!(src instanceof Uint8Array)) {
    const { readFile } = await import('node:fs/promises');
    data = new Uint8Array(await readFile(src));
  } else data = src.slice();            // pdf.js takes ownership of the buffer it is given
  return { lib, doc: await lib.getDocument({ data, useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise };
}

const COL_GAP = 28;      // horizontal gap that separates two columns on one line
const X_TOL = 4;         // lines whose left edges agree within this are one block
const Y_TOL = 2.5;       // runs whose baselines agree within this are one line

// Radicl's photo pages are a four-column grid whose captions run edge to edge,
// so no gap threshold can tell where one ends. Items are tagged with the column
// their left edge falls in, and a run never joins across columns.
const GRID_BREAKS = [103, 236, 369];
const colOf = x => GRID_BREAKS.filter(b => x >= b).length;

function linesOf(items, grid) {
  const rows = [];
  // the page heading sits in the grid's first row of x but is one run of text
  const headY = grid ? (items.find(i => /— Photos/.test(i.str)) || {}).y : null;
  for (const it of items.sort((a, b) => b.y - a.y || a.x - b.x)) {
    if (grid) it.col = headY != null && Math.abs(it.y - headY) <= 6 ? 0 : colOf(it.x);
    const row = rows.find(r => Math.abs(r.y - it.y) <= Y_TOL);
    if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
  }
  const lines = [];
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    let cur = null;
    for (const it of r.items) {
      if (cur && it.x - cur.x1 <= COL_GAP && (!grid || cur.col === it.col)) {
        cur.text += (it.x - cur.x1 > 1.5 ? ' ' : '') + it.str;
        cur.x1 = it.x + it.w;
      } else {
        if (cur) lines.push(cur);
        cur = { x0: it.x, x1: it.x + it.w, y: r.y, h: it.h || 8, text: it.str, col: it.col };
      }
    }
    if (cur) lines.push(cur);
  }
  return lines.sort((a, b) => b.y - a.y || a.x0 - b.x0);
}

function blocksOf(lines) {
  const blocks = [];
  for (const ln of lines) {
    const open = blocks.find(b =>
      Math.abs(b.x0 - ln.x0) <= X_TOL && b.yLast - ln.y > 0 && b.yLast - ln.y <= Math.max(ln.h, b.h) * 1.9);
    if (open) {
      open.lines.push(ln.text); open.yLast = ln.y; open.y1 = Math.min(open.y1, ln.y);
      open.x1 = Math.max(open.x1, ln.x1);
    } else {
      blocks.push({ x0: ln.x0, x1: ln.x1, y0: ln.y + ln.h, y1: ln.y, yLast: ln.y, h: ln.h, lines: [ln.text] });
    }
  }
  return blocks.map(b => ({
    x0: Math.round(b.x0), x1: Math.round(b.x1), y0: Math.round(b.y0), y1: Math.round(b.y1),
    text: b.lines.join('\n').trim(),
  })).filter(b => b.text);
}

// Returns { pages: [{ n, width, height, blocks }], numPages }.
// opts.onPage(n, total) reports progress; opts.pdfjs supplies the library;
// opts.maxPages stops early (finding a report only needs its first page).
export async function pdfToBlocks(src, opts) {
  const { doc } = await openDoc(src, opts);
  const pages = [], last = opts && opts.maxPages ? Math.min(opts.maxPages, doc.numPages) : doc.numPages;
  for (let n = 1; n <= last; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items.filter(i => i.str && i.str.trim() !== '').map(i => ({
      str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: i.height,
    }));
    const grid = items.some(i => /— Photos(?: \(\d+\/\d+\))?$/.test(i.str.trim()));
    pages.push({ n, width: vp.width, height: vp.height, blocks: blocksOf(linesOf(items, grid)) });
    page.cleanup();
    if (opts && opts.onPage) opts.onPage(n, doc.numPages);
  }
  await doc.destroy();
  return { pages, numPages: pages.length };
}

// ── Images ──────────────────────────────────────────
// Where each photo sits on the given pages, so a caption can be tied to the
// picture under it. Only the pages asked for are read: an operator list is the
// slow part of a 112-page report, and a review wants about twenty photos.
// Returns { [pageNo]: [{ x, y, w, h, name, width, height, get() }] } where
// get() resolves to a JPEG Blob (browser only — it needs a canvas).
export async function pdfImages(src, pageNums, opts) {
  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  // A fresh document per page, three at a time. pdf.js resolves a page's photos
  // lazily and, in the browser, a SECOND page asked of the same document can
  // leave them unresolved for good — the call hangs rather than failing. A new
  // document costs about 60ms (more for a 15MB report, where the decode of a
  // page's twelve photos dominates) and always settles.
  const one = async n => {
    const { lib, doc } = await openDoc(src, opts);
    const { OPS } = lib;
    const page = await doc.getPage(n);
    const ops = await page.getOperatorList();
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [], imgs = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], a = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm.slice());
      else if (fn === OPS.restore) ctm = stack.pop() || ctm;
      else if (fn === OPS.transform) ctm = mul(a, ctm);
      else if (fn === OPS.paintImageXObject) {
        let obj = null;
        try { obj = page.objs.get(a[0]); } catch (e) { obj = await new Promise(res => page.objs.get(a[0], res)); }
        if (!obj) continue;
        imgs.push({
          x: ctm[4], y: ctm[5], w: Math.hypot(ctm[0], ctm[1]), h: Math.hypot(ctm[2], ctm[3]),
          name: a[0], width: obj.width, height: obj.height,
          get: () => imageBlob(obj),
        });
      }
    }
    return imgs;
  };
  const todo = [...pageNums], out = {};
  await Promise.all(Array.from({ length: Math.min(3, todo.length) }, async () => {
    while (todo.length) { const n = todo.shift(); out[n] = await one(n); }
  }));
  return out;
}

async function imageBlob(obj) {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(obj.width, obj.height) : Object.assign(document.createElement('canvas'), { width: obj.width, height: obj.height });
  const ctx = canvas.getContext('2d');
  if (obj.bitmap) ctx.drawImage(obj.bitmap, 0, 0);
  else {
    const px = obj.width * obj.height, rgba = new Uint8ClampedArray(px * 4), d = obj.data;
    const step = d.length / px;                       // 3 for RGB, 4 for RGBA, 1 for gray
    for (let i = 0; i < px; i++) {
      const j = i * step;
      rgba[i * 4] = d[j]; rgba[i * 4 + 1] = step >= 3 ? d[j + 1] : d[j]; rgba[i * 4 + 2] = step >= 3 ? d[j + 2] : d[j];
      rgba[i * 4 + 3] = step === 4 ? d[j + 3] : 255;
    }
    ctx.putImageData(new ImageData(rgba, obj.width, obj.height), 0, 0);
  }
  return canvas.convertToBlob ? canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 })
    : new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.88));
}
