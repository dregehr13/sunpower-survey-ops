import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { stats } = req.body;
  const today = new Date();
  const dayName = today.toLocaleDateString('en-US', { weekday: 'long' });
  const dateStr = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  const prompt = `Write a short morning greeting for a small remote ops team (3 people: schedulers and account managers at SunPower, a solar company). It goes into a Teams message from their manager Doug to kick off the day.

Rules:
- 2–3 sentences max
- Warm, light-hearted, human — this is about connection, not metrics
- Include something topical: a sports score, a day-of-week observation, something seasonal, a gentle joke, or a pop culture reference — whatever feels natural for ${dayName}
- Do NOT restate the stats — they appear separately in the card below the opener
- Do NOT sign off — Doug's name is already shown in the card header
- Sound like a real person, not a bot or a corporate newsletter
- Today is ${dayName}, ${dateStr}

Stats for tone context only (don't repeat them): ${stats?.completed ?? 0} surveys completed ${stats?.refLabel?.toLowerCase() ?? 'yesterday'}, ${stats?.wip ?? 0} open, ${stats?.unscheduled ?? 0} unscheduled.

Return only the greeting text, no quotes, no labels.`;

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ opener: message.content[0].text.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
