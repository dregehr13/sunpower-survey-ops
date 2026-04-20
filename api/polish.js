import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const SYSTEM_PROMPT = `You rewrite raw operational field notes into clean, direct sentences for inclusion in a business email.

Rules:
- Keep every fact. Don't add, interpret, or remove anything.
- 1–2 sentences maximum.
- Plain and direct. No corporate speak, no filler, no transition phrases.
- Write as a statement, not a label — no opener like "Note:" or "Context:".`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { note } = req.body;
  if (!note || !note.trim()) return res.status(400).json({ error: 'No note provided' });

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: note.trim() }],
    });

    const polished = message.content[0].text.trim();
    res.status(200).json({ polished });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
