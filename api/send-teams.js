export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl) return res.status(500).json({ error: 'TEAMS_WEBHOOK_URL not configured' });

  const { card } = req.body;

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'message',
        attachments: [{
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: card,
        }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({ error: `Teams ${response.status}: ${text}` });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
