// A separate pull from api/generate.js and api/morning-card.js's opener: this
// one goes out to the web, and its output never appears on the Teams card —
// it's raw material for Doug to fold into his own message by hand. Doug's
// team spans three markets, so "relevant" covers both what might actually
// affect a site visit (weather) and general newsy/seasonal material.
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();
const MODEL = 'claude-haiku-4-5-20251001';

const LOCATIONS = 'Southern California (Doug, the manager), the San Francisco Bay Area (2 team members), and Orem, Utah (1 team member)';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
      messages: [{
        role: 'user',
        content: `Search for anything genuinely notable happening today that Doug, a Site Survey manager at a solar company, could casually reference in a message to his small remote team. His team is spread across ${LOCATIONS}.

Look for two kinds of things:
1. Significant weather in those specific areas today or the next day or two — heat, storms, wildfire smoke, poor air quality — anything that could plausibly affect a home site visit or someone's commute.
2. One or two broader newsy or seasonal things worth a casual mention today — sports, a holiday, a notable national story. Nothing political, nothing grim.

Return 2-4 short bullet lines, each starting with "- ". State each fact plainly with no "hope this finds you well" filler. If there's nothing weather-related worth flagging in those markets, skip that bullet rather than forcing one. Do not write a greeting, opener, or any framing text — just the raw facts, one per line.`,
      }],
    });
    const context = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    res.json({ context });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
