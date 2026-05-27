import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PROFILE_DIR = join(homedir(), '.survey-ops-browser');
const DOWNLOADS_DIR = join(import.meta.dirname, '.downloads');
mkdirSync(DOWNLOADS_DIR, { recursive: true });
const CONFIG_PATH = join(import.meta.dirname, '.sfconfig.json');
const SETUP = process.argv.includes('--setup');

if (!existsSync(CONFIG_PATH)) {
  console.error('Run setup first: node fetch-report.js --setup');
  process.exit(1);
}

const { sfInst, sfRid } = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
if (!sfInst || !sfRid) {
  console.error('.sfconfig.json missing sfInst or sfRid');
  process.exit(1);
}

const REPORT_URL = `${sfInst}/lightning/r/Report/${sfRid}/view`;

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: !SETUP,
  acceptDownloads: true,
  downloadsPath: DOWNLOADS_DIR,
  args: ['--disable-blink-features=AutomationControlled'],
});

const page = await context.newPage();

try {
  if (SETUP) {
    await page.goto(sfInst);
    console.log('Log into Salesforce, then press Enter...');
    process.stdin.resume();
    await new Promise(r => process.stdin.once('data', r));
    process.stdin.pause();
  }

  if (SETUP) console.log('Navigating to report...');
  await page.goto(REPORT_URL, { waitUntil: 'load', timeout: 60_000 });

  // The report renders inside an iframe
  const frame = page.frameLocator('iframe[title="Report Viewer"]');

  if (SETUP) console.log('Waiting for more-actions button...');
  const moreBtn = frame.locator('.more-actions-button');
  await moreBtn.waitFor({ state: 'visible', timeout: 30_000 });

  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });

  if (SETUP) console.log('Clicking more-actions...');
  await moreBtn.click();

  if (SETUP) console.log('Looking for Export menu item...');
  const exportItem = frame.getByRole('menuitem', { name: /export/i }).first();
  await exportItem.waitFor({ state: 'visible', timeout: 5_000 });
  if (SETUP) console.log('Clicking Export...');
  await exportItem.click();

  // Export modal renders in the main page (not the iframe)
  // "Details Only" is a clickable card, not a radio button
  const detailsCard = page.getByText('Details Only', { exact: true }).first();
  if (await detailsCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
    if (SETUP) console.log('Selecting Details Only...');
    await detailsCard.click();
  }
  if (SETUP) console.log('Clicking Export in modal...');
  await page.getByRole('button', { name: /^export$/i }).click();

  const download = await downloadPromise;
  // Save as report_<timestamp>.xls so push.sh can find it reliably
  const filename = `report_${Date.now()}.xls`;
  await download.saveAs(join(DOWNLOADS_DIR, filename));
  console.log(`Downloaded: ${filename}`);
} catch (e) {
  if (SETUP) {
    console.error('Error:', e.message);
    await page.screenshot({ path: join(import.meta.dirname, 'sf-debug.png') });
    console.error('Screenshot saved to sf-debug.png in project dir');
  }
  process.exit(1);
} finally {
  await context.close();
}
