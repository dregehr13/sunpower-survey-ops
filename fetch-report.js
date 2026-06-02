import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PROFILE_DIR = join(homedir(), '.survey-ops-browser');
const DOWNLOADS_DIR = join(import.meta.dirname, '.downloads');
mkdirSync(DOWNLOADS_DIR, { recursive: true });
const CONFIG_PATH = join(import.meta.dirname, '.sfconfig.json');
const SETUP = process.argv.includes('--setup');

if (!existsSync(CONFIG_PATH)) {
  console.error('Missing .sfconfig.json');
  process.exit(1);
}

const { sfInst, sfRid, sfUser, sfPass } = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
if (!sfInst || !sfRid) {
  console.error('.sfconfig.json missing sfInst or sfRid');
  process.exit(1);
}

const REPORT_URL = `${sfInst}/lightning/r/Report/${sfRid}/view`;

// Remove stale singleton lock if present
for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { rmSync(join(PROFILE_DIR, f)); } catch {}
}

// Try to connect to the user's always-open Chrome via CDP (no login/MFA needed).
// Falls back to launching a headless persistent context if Chrome isn't available.
let browser = null;
let context = null;
let usingCDP = false;

if (!SETUP) {
  try {
    browser = await chromium.connectOverCDP('http://localhost:9222', { timeout: 3000 });
    context = browser.contexts()[0];
    usingCDP = true;
    console.log('Connected to Chrome via CDP');
  } catch {
    // Chrome not running with debug port — use persistent headless context
  }
}

if (!context) {
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: !SETUP,
    acceptDownloads: true,
    downloadsPath: DOWNLOADS_DIR,
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

// For CDP context, downloads go to Chrome's default download folder.
// Override via page.on('download') below.

const page = await context.newPage();

// Route downloads to our .downloads folder when using CDP
if (usingCDP) {
  await context.setDefaultTimeout(60000);
}

try {
  await page.goto(REPORT_URL, { waitUntil: 'load', timeout: 60_000 });

  // Auto-login if redirected to the login page (persistent context only — CDP is already logged in)
  if (!usingCDP && (page.url().includes('/login') || await page.locator('#username').isVisible({ timeout: 3_000 }).catch(() => false))) {
    console.log('Session expired — logging in automatically...');
    if (!sfUser || !sfPass) {
      console.error('Add sfUser and sfPass to .sfconfig.json to enable auto-login');
      process.exit(1);
    }
    await page.locator('#username').fill(sfUser);
    await page.locator('#password').fill(sfPass);
    await page.locator('#Login').click();

    if (SETUP) {
      console.log('If an MFA prompt appeared, complete it in the browser window.');
      console.log('Check "Remember this device" if given the option, then press Enter here...');
      process.stdin.resume();
      await new Promise(r => process.stdin.once('data', r));
      process.stdin.pause();
    } else {
      await page.waitForLoadState('networkidle', { timeout: 45_000 });
    }

    console.log('Logged in, navigating to report...');
    await page.goto(REPORT_URL, { waitUntil: 'load', timeout: 60_000 });
  }

  // The report renders inside an iframe
  const frame = page.frameLocator('iframe[title="Report Viewer"]');
  const moreBtn = frame.locator('.more-actions-button');
  await moreBtn.waitFor({ state: 'visible', timeout: 30_000 });

  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await moreBtn.click();

  const exportItem = frame.getByRole('menuitem', { name: /export/i }).first();
  await exportItem.waitFor({ state: 'visible', timeout: 5_000 });
  await exportItem.click();

  // "Details Only" is a clickable card — must click it explicitly
  const detailsCard = page.getByText('Details Only', { exact: true }).first();
  await detailsCard.waitFor({ state: 'visible', timeout: 10_000 });
  await detailsCard.click();
  await page.getByRole('button', { name: /^export$/i }).click();

  const download = await downloadPromise;
  const filename = `report_${Date.now()}.xls`;
  await download.saveAs(join(DOWNLOADS_DIR, filename));
  console.log(`Downloaded: ${filename}`);
} catch (e) {
  console.error('Error:', e.message);
  await page.screenshot({ path: join(import.meta.dirname, 'sf-debug.png') });
  console.error('Screenshot saved to sf-debug.png');
  process.exit(1);
} finally {
  await page.close();
  if (!usingCDP) await context.close();
  else await browser.disconnect();
}
