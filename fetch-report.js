import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

const CHROME_DIR  = join(homedir(), '.survey-ops-chrome');
const DOWNLOADS_DIR = join(import.meta.dirname, '.downloads');
mkdirSync(DOWNLOADS_DIR, { recursive: true });
mkdirSync(CHROME_DIR, { recursive: true });
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
const CHROME_AGENT = 'com.surveyops.chrome';

// ── SETUP MODE ────────────────────────────────────────────────────────────────
// Stop the headless agent, open a headed Chrome for login/MFA, then restart.
if (SETUP) {
  console.log('Stopping headless Chrome agent...');
  execSync(`launchctl unload ~/Library/LaunchAgents/com.surveyops.chrome.plist 2>/dev/null || true`, { shell: true });
  execSync(`killall "Google Chrome" 2>/dev/null || true`, { shell: true });
  await new Promise(r => setTimeout(r, 2000));

  console.log('Opening Chrome for login — sign in to Salesforce, complete MFA,');
  console.log('check "Remember this device" if offered, then press Enter here...');

  const ctx = await chromium.launchPersistentContext(CHROME_DIR, {
    channel: 'chrome',
    headless: false,
    acceptDownloads: true,
    downloadsPath: DOWNLOADS_DIR,
    args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
  });
  const page = await ctx.newPage();
  await page.goto(sfInst);

  if (sfUser && sfPass) {
    const usernameField = page.locator('#username');
    if (await usernameField.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await usernameField.fill(sfUser);
      await page.locator('#password').fill(sfPass);
      await page.locator('#Login').click();
    }
  }

  process.stdin.resume();
  await new Promise(r => process.stdin.once('data', r));
  process.stdin.pause();

  await ctx.close();

  console.log('Restarting headless Chrome agent...');
  execSync(`launchctl load ~/Library/LaunchAgents/com.surveyops.chrome.plist`, { shell: true });
  await new Promise(r => setTimeout(r, 3000));
  console.log('Setup complete. Headless Chrome is running with your session.');
  process.exit(0);
}

// ── NORMAL RUN: connect via CDP ───────────────────────────────────────────────
const browser = await chromium.connectOverCDP('http://localhost:9222');
const context = browser.contexts()[0] || await browser.newContext({ acceptDownloads: true });

const page = await context.newPage();

try {
  await page.goto(REPORT_URL, { waitUntil: 'load', timeout: 60_000 });

  // If session expired, auto-login (rare once the headless Chrome is established)
  if (page.url().includes('/login') || await page.locator('#username').isVisible({ timeout: 3_000 }).catch(() => false)) {
    if (!sfUser || !sfPass) {
      console.error('Session expired and no credentials in .sfconfig.json — run --setup');
      process.exit(1);
    }
    await page.locator('#username').fill(sfUser);
    await page.locator('#password').fill(sfPass);
    await page.locator('#Login').click();
    await page.waitForLoadState('networkidle', { timeout: 45_000 });
    await page.goto(REPORT_URL, { waitUntil: 'load', timeout: 60_000 });
  }

  const frame = page.frameLocator('iframe[title="Report Viewer"]');
  const moreBtn = frame.locator('.more-actions-button');
  await moreBtn.waitFor({ state: 'visible', timeout: 30_000 });

  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await moreBtn.click();

  const exportItem = frame.getByRole('menuitem', { name: /export/i }).first();
  await exportItem.waitFor({ state: 'visible', timeout: 5_000 });
  await exportItem.click();

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
  await browser.close();
}
