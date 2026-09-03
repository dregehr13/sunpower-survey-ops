import { readFileSync } from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import OpsMetrics from '../lib/metrics.cjs';
import { openerPrompt, OPENER_MODEL, OPENER_MAX_TOKENS } from './_opener-prompt.js';

const client = new Anthropic();

// YYYY-MM-DD in Mountain Time. Every date in the data is Mountain; this runs
// on Vercel in UTC, so a bare toLocaleDateString rolls over seven hours early
// and "yesterday" becomes today for anything after 17:00 MT.
function toDateStr(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

// Shift a YYYY-MM-DD by n days without going through a timezone again.
function addDaysISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function computeStats(rows) {
  // Anchor the whole calculation on the Mountain date, not the server's.
  const today = toDateStr(new Date());
  const dow = new Date(today + 'T12:00:00Z').getUTCDay(); // 0=Sun, 1=Mon

  // Monday morning → look back to Friday; otherwise → yesterday
  const refDate = addDaysISO(today, dow === 1 ? -3 : -1);
  const refLabel = dow === 1 ? 'Friday' : 'Yesterday';

  const filtered = OpsMetrics.filterRows(rows);
  const isComplete = OpsMetrics.isComplete;
  const wip = filtered.filter(OpsMetrics.isWIP);

  // Weekly projection — same model as the dashboard hero. Needs the full set
  // (cancelled rows carry the drag) with the Open-date anchor applied, which
  // is the dashboard default.
  const anchored = rows
    .filter(r => r.start >= OpsMetrics.DATA_CUTOFF)
    .map(r => {
      const c = { ...r };
      if (c.opened) { c.start = c.opened; if (c.ct_open !== undefined) c.ct_total = c.ct_open; }
      return c;
    });
  const weekMon = addDaysISO(today, -((new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7));
  let projected = null, projectedTypical = null;
  try {
    const proj = OpsMetrics.projectWeek(anchored, weekMon, today, { asOfHour: 8 });
    projected = proj.point; projectedTypical = proj.recentMed;
  } catch (_) { /* projection is best-effort here */ }

  return {
    refLabel,
    refDate,
    completed: filtered.filter(r => isComplete(r) && r.complete === refDate).length,
    wip: wip.length,
    unscheduled: wip.filter(r => !r.scheduled).length,
    projected, projectedTypical,
  };
}

async function generateOpener(stats) {
  const message = await client.messages.create({
    model: OPENER_MODEL,
    max_tokens: OPENER_MAX_TOKENS,
    messages: [{ role: 'user', content: openerPrompt(stats) }],
  });
  return message.content[0].text.trim();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const dataPath = join(process.cwd(), 'data.json');
    const rows = JSON.parse(readFileSync(dataPath, 'utf8'));
    const stats = computeStats(rows);
    const opener = await generateOpener(stats);
    res.json({ stats, opener });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
