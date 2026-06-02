import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PROFILE_DIR = join(homedir(), '.survey-ops-browser');
const DOWNLOADS_DIR = join(import.meta.dirname, '.downloads');
mkdirSync(DOWNLOADS_DIR, { recursive: true });
const CONFIG_PATH = join(import.meta.dirname, '.sfconfig.json');

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
const SETUP = process.argv.includes('--setup');

// Remove stale singleton lock if present
import { rmSync } from 'fs';
for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { rmSync(join(PROFILE_DIR, f)); } catch {}
}

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: !SETUP,
  acceptDownloads: true,
  downloadsPath: DOWNLOADS_DIR,
  args: ['--disable-blink-features=AutomationControlled'],
});

const page = await context.newPage();

try {
  await page.goto(REPORT_URL, { waitUntil: 'load', timeout: 60_000 });

  // Auto-login if redirected to the login page
  if (page.url().includes('/login') || await page.locator('#username').isVisible({ timeout: 3_000 }).catch(() => false)) {
    console.log('Session expired — logging in automatically...');
    if (!sfUser || !sfPass) {
      console.error('Add sfUser and sfPass to .sfconfig.json to enable auto-login');
      process.exit(1);
    }
    await page.locator('#username').fill(sfUser);
    await page.locator('#password').fill(sfPass);
    await page.locator('#Login').click();

    if (SETUP) {
      // In setup mode: pause so the user can complete MFA manually
      console.log('If an MFA prompt appeared, complete it in the browser window.');
      console.log('Check "Remember this device" if given the option, then press Enter here...');
      process.stdin.resume();
      await new Promise(r => process.stdin.once('data', r));
      process.stdin.pause();
    } else {
      // Headless: wait for post-login load (trusted device — no MFA expected)
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
  await context.close();
}
