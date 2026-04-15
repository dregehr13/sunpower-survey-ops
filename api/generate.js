// Vercel serverless function — Survey Ops email commentary generator
// ANTHROPIC_API_KEY must be set in Vercel environment variables (never commit it)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { data, mode, manualNote } = req.body;

  // TODO: build prompt from data + mode + voice spec
  // TODO: call claude-sonnet-4-6 via Anthropic SDK
  // TODO: return 3 commentary options in Doug's voice

  res.status(200).json({ options: ['(scaffold — not yet implemented)'] });
}
