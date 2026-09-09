#!/usr/bin/env node
// scripts/build-memo.cjs — a markdown memo → the SunPower memo .docx
//
// Usage: node scripts/build-memo.cjs <memo.md> [--out <file.docx>] [--number DRR-014] [--dry]
//
// The template is COPIED and only `word/document.xml` is rewritten, so the
// SunPower logo, the first-page and running headers, both footers, the page
// setup and every style survive byte for byte. Rebuilding a document from
// scratch and re-adding a logo is how a memo stops looking like the others.
//
// Formatting is matched to the template's own runs rather than to its styles,
// because the template formats directly: Arial everywhere, bold labels, tab
// stops at 1800/8640/12240, justified body at 276 line spacing. Read the
// template's XML before changing any of the constants below.
//
// The memo number comes from memos/register.json and is APPENDED there on a
// real build, so a number is never reused. --dry renders without claiming one.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'memos', 'template.docx');
const REGISTER = path.join(ROOT, 'memos', 'register.json');

// ── args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let src = null, out = null, forceNum = null, revise = null, dry = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') out = argv[++i];
  else if (argv[i] === '--number') forceNum = argv[++i];
  else if (argv[i] === '--revise') revise = argv[++i];
  else if (argv[i] === '--dry') dry = true;
  else src = argv[i];
}
if (!src) {
  console.error('Usage: node scripts/build-memo.cjs <memo.md> [--out <file.docx>]');
  console.error('       [--revise 4 | --revise DRR-4A] [--number DRR-4A] [--dry]');
  process.exit(1);
}

// ── input ────────────────────────────────────────────────────────────────
// Front matter is `Key: value` lines before the first blank line. Body is
// markdown: `## Heading`, paragraphs, `- ` bullets, `1. ` numbered.
const raw = fs.readFileSync(src, 'utf8').replace(/\r\n?/g, '\n');
const parts = raw.split(/\n\s*\n/);
const meta = {};
const fmLines = parts[0].split('\n').filter(Boolean);
const looksLikeFm = fmLines.length && fmLines.every(l => /^[A-Za-z][A-Za-z #]*:/.test(l));
if (looksLikeFm) {
  fmLines.forEach(l => {
    const i = l.indexOf(':');
    meta[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  });
  parts.shift();
}
const bodyBlocks = parts.join('\n\n').split('\n').filter(l => l.trim() !== '' || true);

// ── memo number ──────────────────────────────────────────────────────────
const reg = JSON.parse(fs.readFileSync(REGISTER, 'utf8'));
const initials = meta.initials || reg.initials || 'DRR';

// `DRR-4A`: the number is the memo, the letter is its revision. A revision
// letter moves only when a memo that was ALREADY PUBLISHED is reworked — a
// redraft before it goes out is still A, because nobody has read the other one.
const parse = n => {
  const m = /^([A-Za-z]+)-(\d+)([A-Za-z])$/.exec(String(n || '').trim());
  return m ? { initials: m[1], n: +m[2], rev: m[3].toUpperCase() } : null;
};
const issued = (reg.memos || []).map(m => parse(m.number)).filter(Boolean)
  .filter(m => m.initials === initials);

function nextNumber() {
  // `firstNumber` carries the memos issued before this tool existed, so the
  // count continues rather than restarting at 1 on an empty register.
  const floor = Number.isFinite(reg.firstNumber) ? reg.firstNumber : 1;
  const used = issued.map(m => m.n);
  return `${initials}-${Math.max(floor, used.length ? Math.max(...used) + 1 : floor)}A`;
}
function reviseNumber(arg) {
  const asked = parse(arg) || (/^\d+$/.test(String(arg).trim()) ? { n: +arg } : null);
  if (!asked) { console.error(`--revise wants a memo number, e.g. --revise 4 or --revise ${initials}-4A`); process.exit(1); }
  const revs = issued.filter(m => m.n === asked.n).map(m => m.rev);
  if (!revs.length) { console.error(`${initials}-${asked.n} is not in the register — a revision needs something to revise.`); process.exit(1); }
  const top = revs.sort().pop();
  if (top === 'Z') { console.error(`${initials}-${asked.n}Z exists; that memo has run out of revisions.`); process.exit(1); }
  return `${initials}-${asked.n}${String.fromCharCode(top.charCodeAt(0) + 1)}`;
}
const number = forceNum || meta['author file #']
  || (revise ? reviseNumber(revise) : nextNumber());

const today = new Date();
const dateStr = meta.date || `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

// ── XML helpers ──────────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
// Arial is set per-run in this template, not inherited from a style.
const FONT = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>';
const TABS = '<w:tabs><w:tab w:val="left" w:pos="1800"/><w:tab w:val="left" w:pos="8640"/><w:tab w:val="left" w:pos="12240"/></w:tabs>';
const run = (text, { b = false } = {}) =>
  `<w:r><w:rPr>${FONT}${b ? '<w:b/>' : '<w:bCs/>'}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const tabRun = () => `<w:r><w:rPr>${FONT}<w:b/></w:rPr><w:tab/></w:r>`;

// The header block: bold label, tab, value. `To:` carries the hanging indent
// the template gives it so a long recipient list wraps under itself.
// Subject, Attachments and the blank that closes the block carry a bottom
// rule in the template — three lines that separate the header from the memo.
// They are the reason the block reads as a form rather than as seven lines of
// text, so they are not decoration.
const RULE = '<w:pBdr><w:bottom w:val="single" w:sz="12" w:space="1" w:color="auto"/></w:pBdr>';
function metaRow(label, value, { hanging = false, boldValue = false, rule = false } = {}) {
  const ind = hanging ? '<w:ind w:left="720" w:hanging="720"/>' : '';
  return `<w:p><w:pPr>${rule ? RULE : ''}${TABS}${ind}<w:rPr>${FONT}<w:bCs/></w:rPr></w:pPr>`
    + run(label, { b: true }) + tabRun()
    + (value ? run(value, { b: boldValue }) : '') + '</w:p>';
}
const spacer = (rule = false) => `<w:p><w:pPr>${rule ? RULE : ''}<w:rPr>${FONT}</w:rPr></w:pPr></w:p>`;
// Body copy: justified, 276 line spacing — both taken off the template.
const para = text =>
  `<w:p><w:pPr><w:spacing w:line="276" w:lineRule="auto"/><w:jc w:val="both"/><w:rPr>${FONT}</w:rPr></w:pPr>`
  + inline(text) + '</w:p>';
const heading = text =>
  `<w:p><w:pPr><w:spacing w:line="276" w:lineRule="auto"/><w:jc w:val="both"/><w:rPr>${FONT}<w:b/><w:bCs/></w:rPr></w:pPr>`
  + `<w:r><w:rPr>${FONT}<w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
// numId 1 is the template's own bullet list, numId 6 its decimal list —
// read out of word/numbering.xml. Using them keeps Word's real list
// rendering rather than a typed-in bullet character.
const listItem = (text, ordered) =>
  `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/>`
  + `<w:numId w:val="${ordered ? 6 : 1}"/></w:numPr>`
  + `<w:spacing w:line="276" w:lineRule="auto"/><w:jc w:val="both"/><w:rPr>${FONT}</w:rPr></w:pPr>`
  + inline(text) + '</w:p>';

// A markdown table becomes a real Word table on the template's TableGrid
// style. The header row is bold, lightly shaded, and marked <w:tblHeader/> so
// it repeats if the table breaks across a page. Column alignment comes from
// the separator row, `---:` for right, which is what numbers want.
const TEXT_TWIPS = 9360;   // 12240 page - 1440 margins each side
function tableXml(rows, aligns) {
  const cols = rows[0].length;
  const w = Math.floor(TEXT_TWIPS / cols);
  const cell = (text, i, head) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>`
    + (head ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : '')
    + `<w:vAlign w:val="center"/></w:tcPr>`
    + `<w:p><w:pPr><w:spacing w:before="20" w:after="20"/>`
    + (aligns[i] === 'right' ? '<w:jc w:val="right"/>' : aligns[i] === 'center' ? '<w:jc w:val="center"/>' : '')
    + `<w:rPr>${FONT}${head ? '<w:b/>' : ''}</w:rPr></w:pPr>`
    + (head ? run(text, { b: true }) : inline(text)) + '</w:p></w:tc>';
  const tr = (cells, head) =>
    `<w:tr>${head ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}`
    + cells.map((c, i) => cell(c, i, head)).join('') + '</w:tr>';
  return '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>'
    // An explicit dxa width, not a percentage: pct is honoured
    // inconsistently outside Word and the table sized to its content.
    + `<w:tblW w:w="${TEXT_TWIPS}" w:type="dxa"/>`
    // Fixed layout, or Word autofits to the content and ignores the widths
    // declared above — which had a four-column table sitting at half the
    // measure with the page empty beside it.
    + '<w:tblLayout w:type="fixed"/>'
    + '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>'
    + '</w:tblPr><w:tblGrid>' + rows[0].map(() => `<w:gridCol w:w="${w}"/>`).join('') + '</w:tblGrid>'
    + tr(rows[0], true) + rows.slice(1).map(r => tr(r, false)).join('') + '</w:tbl>';
}

// `![caption](chart.png)` embeds a picture, which is how a chart gets into a
// memo — Word's own chart parts would mean shipping the data with it, and a
// memo is a fixed record rather than something anyone re-pivots. The image is
// scaled to the text column and never enlarged past its natural size.
const media = [];   // { file, rid, name }
function pngSize(buf) {
  // IHDR width/height are the two big-endian uint32s at byte 16.
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function imageXml(caption, file) {
  const abs = path.isAbsolute(file) ? file : path.resolve(path.dirname(src), file);
  if (!fs.existsSync(abs)) {
    console.error(`  ! image not found, skipped: ${file}`);
    return '';
  }
  const dim = pngSize(fs.readFileSync(abs));
  if (!dim) { console.error(`  ! not a PNG, skipped: ${file}`); return ''; }
  const EMU_PER_TWIP = 635, maxEmu = TEXT_TWIPS * EMU_PER_TWIP;
  const natural = Math.round(dim.w * 9525);          // px at 96dpi → EMU
  const cx = Math.min(natural, maxEmu);
  const cy = Math.round(cx * dim.h / dim.w);
  const n = media.length + 1;
  const rid = `rIdImg${n}`;
  media.push({ abs, rid, name: `memoimage${n}.png` });
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  return `<w:p><w:pPr><w:spacing w:before="120" w:after="60"/><w:jc w:val="center"/></w:pPr>`
    + `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
    + `<wp:docPr id="${100 + n}" name="Picture ${n}" descr="${esc(caption)}"/>`
    + `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A}" noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic xmlns:a="${A}"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:nvPicPr><pic:cNvPr id="0" name="${esc(path.basename(abs))}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    + (caption
      ? `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="120"/><w:rPr>${FONT}<w:i/><w:sz w:val="18"/></w:rPr></w:pPr>`
        + `<w:r><w:rPr>${FONT}<w:i/><w:sz w:val="18"/><w:color w:val="595959"/></w:rPr>`
        + `<w:t xml:space="preserve">${esc(caption)}</w:t></w:r></w:p>`
      : '');
}

// **bold** is the only inline markup a memo needs; it is how a figure is
// carried in a sentence. Anything else is left as literal text.
function inline(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(run(text.slice(last, m.index)));
    out.push(run(m[1], { b: true }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(run(text.slice(last)));
  return out.join('') || run('');
}

// ── body ─────────────────────────────────────────────────────────────────
const lines = bodyBlocks;
const body = [];
const isItem = s => /^([-*]|\d+[.)])\s+/.test(s);
let prevWasList = false;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i].trim();
  if (!l) {
    // A blank between two list items is the markdown, not a paragraph break —
    // but a blank AFTER a list is the gap before the next section, and
    // swallowing it ran the numbered list straight into the heading below it.
    const next = lines.slice(i + 1).find(x => x.trim());
    if (!(prevWasList && next && isItem(next.trim()))) body.push(spacer());
    prevWasList = false;
    continue;
  }
  let m;
  // A table is its header row, a separator row, then its body. It is consumed
  // whole here rather than line by line, because a row is not a paragraph.
  if (/^\|.*\|$/.test(l) && /^\|[\s:|-]+\|$/.test((lines[i + 1] || '').trim())) {
    const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const head = cells(l);
    const aligns = cells(lines[i + 1]).map(sp =>
      /^:.*:$/.test(sp) ? 'center' : /:$/.test(sp) ? 'right' : 'left');
    const rows = [head];
    let j = i + 2;
    for (; j < lines.length && /^\|.*\|$/.test(lines[j].trim()); j++) rows.push(cells(lines[j]));
    body.push(tableXml(rows, aligns));
    i = j - 1;
    prevWasList = false;
    continue;
  }
  if ((m = l.match(/^!\[([^\]]*)\]\(([^)]+)\)$/))) { body.push(imageXml(m[1], m[2])); prevWasList = false; continue; }
  if ((m = l.match(/^#{1,6}\s+(.*)$/))) { body.push(heading(m[1])); prevWasList = false; }
  else if ((m = l.match(/^[-*]\s+(.*)$/)))  { body.push(listItem(m[1], false)); prevWasList = true; }
  else if ((m = l.match(/^\d+[.)]\s+(.*)$/))) { body.push(listItem(m[1], true)); prevWasList = true; }
  else { body.push(para(l)); prevWasList = false; }
}

const header = [
  spacer(),
  metaRow('Date:', dateStr),
  metaRow('To:', meta.to || '', { hanging: true }),
  metaRow('Author:', meta.author || reg.author || '', { boldValue: true }),
  metaRow('Author File #:', number),
  metaRow('CC:', meta.cc || ''),
  metaRow('Subject:', meta.subject || '', { rule: true }),
  metaRow('Attachments:', meta.attachments || '', { rule: true }),
  spacer(true),
  spacer(),
].join('');

// ── write ────────────────────────────────────────────────────────────────
const tplXml = require('child_process')
  .execFileSync('unzip', ['-p', TEMPLATE, 'word/document.xml'], { maxBuffer: 1 << 24 })
  .toString('utf8');
// Keep the template's own <w:body> attributes and its sectPr — the sectPr
// holds the header/footer relationship ids and the title-page flag, so a
// rebuilt one would silently drop the logo.
const bodyOpen = tplXml.indexOf('<w:body>') + '<w:body>'.length;
const sectPr = tplXml.slice(tplXml.lastIndexOf('<w:sectPr'), tplXml.lastIndexOf('</w:body>'));
const docXml = tplXml.slice(0, bodyOpen) + header + body.join('') + sectPr + '</w:body></w:document>';

// `DRR-4A_Radicl_Billing_Review.docx` — the memo system's own convention, as
// used on its published PDFs: the number leads, the title follows, and there
// is no date prefix, because the number already identifies the memo and the
// system shows the date beside it. This deliberately does NOT follow the
// YYYY-MM_ convention used for other documents.
//
// Words are capitalised and joined with underscores, and anything already
// upper-case is left alone so an acronym survives (RCCA243, SS, FDC). Set
// `File:` in the front matter to name it exactly; the subject is only a
// fallback, and a long subject makes a long filename.
function titleCase(text) {
  return String(text)
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .split(/\s+/).filter(Boolean)
    .map(w => (w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1)))
    .join('_');
}
const fileTitle = (meta.file ? titleCase(meta.file)
  : titleCase(meta.subject || path.basename(src, path.extname(src)))).slice(0, 70);
const dest = out || path.join(ROOT, 'memos', `${number}_${fileTitle}.docx`);

// The document is titled in both senses: the filename above, and Word's own
// Title property here, which is what a document system lists it under. The
// template ships an empty <dc:title> and Michael Chiaravalle as creator.
const core = execFileSync('unzip', ['-p', TEMPLATE, 'docProps/core.xml'], { maxBuffer: 1 << 22 })
  .toString('utf8')
  .replace(/<dc:title>.*?<\/dc:title>/, `<dc:title>${esc(meta.subject || fileTitle)}</dc:title>`)
  .replace(/<dc:creator>.*?<\/dc:creator>/, `<dc:creator>${esc(meta.author || reg.author || '')}</dc:creator>`)
  .replace(/<cp:lastModifiedBy>.*?<\/cp:lastModifiedBy>/, `<cp:lastModifiedBy>${esc(meta.author || reg.author || '')}</cp:lastModifiedBy>`);

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(TEMPLATE, dest);
const stage = fs.mkdtempSync(path.join(require('os').tmpdir(), 'memo-'));
fs.mkdirSync(path.join(stage, 'word'), { recursive: true });
fs.mkdirSync(path.join(stage, 'docProps'), { recursive: true });
fs.writeFileSync(path.join(stage, 'word', 'document.xml'), docXml);
fs.writeFileSync(path.join(stage, 'docProps', 'core.xml'), core);
const entries = ['word/document.xml', 'docProps/core.xml'];

if (media.length) {
  // Each picture needs its bytes under word/media and a relationship the
  // drawing's r:embed points at. Ids are prefixed rather than numbered from
  // the template's own rId16, so adding one can never collide with a part the
  // template already relates to (the logo among them).
  fs.mkdirSync(path.join(stage, 'word', 'media'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'word', '_rels'), { recursive: true });
  media.forEach(mm => {
    fs.copyFileSync(mm.abs, path.join(stage, 'word', 'media', mm.name));
    entries.push(`word/media/${mm.name}`);
  });
  const rels = execFileSync('unzip', ['-p', TEMPLATE, 'word/_rels/document.xml.rels'], { maxBuffer: 1 << 22 })
    .toString('utf8')
    .replace('</Relationships>', media.map(mm =>
      `<Relationship Id="${mm.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"`
      + ` Target="media/${mm.name}"/>`).join('') + '</Relationships>');
  fs.writeFileSync(path.join(stage, 'word', '_rels', 'document.xml.rels'), rels);
  entries.push('word/_rels/document.xml.rels');
}

// `zip` replaces these entries in place and leaves every other part untouched.
execFileSync('zip', ['-q', path.resolve(dest), ...entries], { cwd: stage });
fs.rmSync(stage, { recursive: true, force: true });

if (!dry) {
  reg.memos = reg.memos || [];
  const p = parse(number);
  reg.memos.push({ number, n: p ? p.n : null, revision: p ? p.rev : null,
    date: dateStr, subject: meta.subject || '', to: meta.to || '',
    file: path.relative(path.join(ROOT, 'memos'), dest) });
  fs.writeFileSync(REGISTER, JSON.stringify(reg, null, 2) + '\n');
}

console.error(`${number}  ${dest}`);
console.error(`  ${body.length} paragraphs · ${dry ? 'DRY RUN, number not claimed' : 'registered'}`);
