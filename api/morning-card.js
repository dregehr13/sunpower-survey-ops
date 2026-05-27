import { readFileSync } from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();
const DATA_CUTOFF = '2025-12-29';

function toDateStr(d) {
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD
}

function computeStats(rows) {
  const now = new Date();
  const dow = now.getDay(); // 0=Sun, 1=Mon

  // Monday morning → look back to Friday; otherwise → yesterday
  let refDate;
  let refLabel;
  if (dow === 1) {
    const fri = new Date(now);
    fri.setDate(fri.getDate() - 3);
    refDate = toDateStr(fri);
    refLabel = 'Friday';
  } else {
    const yest = new Date(now);
    yest.setDate(yest.getDate() - 1);
    refDate = toDateStr(yest);
    refLabel = 'Yesterday';
  }

  const filtered = rows.filter(r =>
    (r.project_status === 'In Progress' || r.project_status === 'Change Order') &&
    r.start >= DATA_CUTOFF
  );

  const isComplete = r => !!(r.complete && r.list === 'Complete');
  const wip = filtered.filter(r => r.start && !isComplete(r));

  return {
    refLabel,
    refDate,
    completed: filtered.filter(r => isComplete(r) && r.complete === refDate).length,
    wip: wip.length,
    unscheduled: wip.filter(r => !r.scheduled).length,
  };
}

async function generateOpener(stats) {
  const now = new Date();
  const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });
  const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  const prompt = `Write a short morning greeting for a small remote ops team (3 people: schedulers and account managers at SunPower, a solar company). It goes into a Teams message from their manager Doug to kick off the day.

Rules:
- 2–3 sentences max
- Warm, light-hearted, human — this is about connection, not metrics
- Include something topical: a sports score, a day-of-week observation, something seasonal, a gentle joke, or a pop culture reference — whatever feels natural for ${dayName}
- Do NOT restate the stats — they appear separately in the card below the opener
- Do NOT sign off — Doug's name is already shown in the card header
- Sound like a real person, not a bot or a corporate newsletter
- Today is ${dayName}, ${dateStr}

Stats for tone context only (don't repeat them): ${stats.completed} surveys completed ${stats.refLabel.toLowerCase()}, ${stats.wip} open, ${stats.unscheduled} unscheduled.

Return only the greeting text, no quotes, no labels.`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 120,
    messages: [{ role: 'user', content: prompt }],
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
