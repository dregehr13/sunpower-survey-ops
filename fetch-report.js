// Exports the SF report by automating the user's real Chrome via AppleScript.
// No separate profile = no MFA, since Chrome is already trusted by Salesforce.
import { spawnSync } from 'child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';

const DOWNLOADS_DIR = join(import.meta.dirname, '.downloads');
mkdirSync(DOWNLOADS_DIR, { recursive: true });
const CONFIG_PATH = join(import.meta.dirname, '.sfconfig.json');

if (!existsSync(CONFIG_PATH)) { console.error('Missing .sfconfig.json'); process.exit(1); }
const { sfInst, sfRid } = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const REPORT_URL = `${sfInst}/lightning/r/Report/${sfRid}/view`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Run AppleScript from a temp file (avoids escaping hell)
function osa(script, timeoutMs = 15000) {
  const f = join(tmpdir(), `sop-${Date.now()}.applescript`);
  writeFileSync(f, script);
  try {
    const r = spawnSync('osascript', [f], { encoding: 'utf8', timeout: timeoutMs });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'osascript error').trim());
    return r.stdout.trim();
  } finally { try { unlinkSync(f); } catch {} }
}

// Execute JS in a specific Chrome tab (returns string result)
function chromeJS(winIdx, tabIdx, js) {
  return osa(`tell application "Google Chrome"\n  execute javascript ${JSON.stringify(js)} in tab ${tabIdx} of window ${winIdx}\nend tell`);
}

// ── 1. Open report in a new Chrome tab ──────────────────────────────────────
const tabInfo = osa(`
tell application "Google Chrome"
  set w to first window
  set t to make new tab at end of tabs of w
  set URL of t to "${REPORT_URL}"
  return (index of w) & "," & (count of tabs of w)
end tell`);

const [winIdx, tabIdx] = tabInfo.split(',').map(Number);

// ── 2. Wait for the report iframe to render ──────────────────────────────────
let ready = false;
for (let i = 0; i < 60; i++) {
  await sleep(1500);
  try {
    const r = chromeJS(winIdx, tabIdx, `
      (function(){
        var f = document.querySelector('iframe[title="Report Viewer"]');
        return String(!!(f && f.contentDocument && f.contentDocument.querySelector('.more-actions-button')));
      })()`);
    if (r === 'true') { ready = true; break; }
  } catch {}
}
if (!ready) {
  // Close the tab we opened before exiting
  osa(`tell application "Google Chrome" to close tab ${tabIdx} of window ${winIdx}`);
  console.error('Error: Report iframe did not load');
  process.exit(1);
}

// ── 3. Snapshot Downloads so we can detect the new file ─────────────────────
const beforeFiles = new Set(
  osa(`tell application "Finder" to return name of every file of (path to downloads folder) whose name ends with ".xls" or name ends with ".xlsx"`)
    .split(', ').map(s => s.trim()).filter(Boolean)
);

// ── 4. Click through the export flow ────────────────────────────────────────
// Click more-actions button inside the iframe
chromeJS(winIdx, tabIdx, `
  document.querySelector('iframe[title="Report Viewer"]')
    .contentDocument.querySelector('.more-actions-button').click();`);
await sleep(1000);

// Click Export menu item
chromeJS(winIdx, tabIdx, `
  (function(){
    var f = document.querySelector('iframe[title="Report Viewer"]').contentDocument;
    var items = Array.from(f.querySelectorAll('[role="menuitem"]'));
    var exp = items.find(i => /export/i.test(i.textContent));
    if (exp) exp.click();
  })()`);
await sleep(2000);

// Click Details Only card (renders in main page, not iframe)
chromeJS(winIdx, tabIdx, `
  (function(){
    var all = Array.from(document.querySelectorAll('*'));
    var card = all.find(el => el.childElementCount === 0 && el.textContent.trim() === 'Details Only');
    if (card) card.click();
  })()`);
await sleep(500);

// Click the Export button in the modal
chromeJS(winIdx, tabIdx, `
  (function(){
    var btns = Array.from(document.querySelectorAll('button'));
    var btn = btns.find(b => /^export$/i.test(b.textContent.trim()));
    if (btn) btn.click();
  })()`);

// ── 5. Wait for file to appear in Downloads ──────────────────────────────────
let newFile = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  try {
    const allFiles = osa(`tell application "Finder" to return name of every file of (path to downloads folder) whose name ends with ".xls" or name ends with ".xlsx"`)
      .split(', ').map(s => s.trim()).filter(Boolean);
    const added = allFiles.filter(f => !beforeFiles.has(f));
    if (added.length > 0) {
      // Pick newest if multiple appeared
      newFile = added[added.length - 1];
      break;
    }
  } catch {}
}

// ── 6. Close the tab we opened ───────────────────────────────────────────────
try { osa(`tell application "Google Chrome" to close tab ${tabIdx} of window ${winIdx}`); } catch {}

if (!newFile) { console.error('Error: Download timed out'); process.exit(1); }

// ── 7. Move file to .downloads/ via Finder ───────────────────────────────────
const destName = `report_${Date.now()}.xls`;
osa(`
tell application "Finder"
  set src to file "${newFile}" of (path to downloads folder)
  set dst to POSIX file "${DOWNLOADS_DIR}" as alias
  move src to dst
end tell`);

// Rename to our standard timestamped name
renameSync(join(DOWNLOADS_DIR, newFile), join(DOWNLOADS_DIR, destName));
console.log(`Downloaded: ${destName}`);
