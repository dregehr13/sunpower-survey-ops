import Anthropic from '@anthropic-ai/sdk';
import { openerPrompt, OPENER_MODEL, OPENER_MAX_TOKENS } from './_opener-prompt.js';

const client = new Anthropic();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { stats } = req.body;

  try {
    const message = await client.messages.create({
      model: OPENER_MODEL,
      max_tokens: OPENER_MAX_TOKENS,
      messages: [{ role: 'user', content: openerPrompt(stats) }],
    });
    res.json({ opener: message.content[0].text.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
