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

const slug = (meta.subject || path.basename(src, path.extname(src)))
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const iso = dateStr.split('/').length === 3
  ? `${dateStr.split('/')[2]}-${String(dateStr.split('/')[0]).padStart(2, '0')}`
  : today.toISOString().slice(0, 7);
const dest = out || path.join(ROOT, 'memos', `${iso}_${number}_${slug}.docx`);

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(TEMPLATE, dest);
const stage = fs.mkdtempSync(path.join(require('os').tmpdir(), 'memo-'));
fs.mkdirSync(path.join(stage, 'word'), { recursive: true });
fs.writeFileSync(path.join(stage, 'word', 'document.xml'), docXml);
// `zip` replaces the one entry in place and leaves the other 32 untouched.
execFileSync('zip', ['-q', path.resolve(dest), 'word/document.xml'], { cwd: stage });
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
