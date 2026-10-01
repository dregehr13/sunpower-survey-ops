// api/qa-vision.js — the Claude photo check for the QA review.
//
//   POST /api/qa-vision  { category, image }  →  { readable, note }
//
// `image` is a base64 JPEG the page has already shrunk. The QA password is checked
// here, as on /api/qa-log, so only the team can spend the key. Nothing is stored.
// Without ANTHROPIC_API_KEY it answers 503 not_configured and the page says so.
import Anthropic from '@anthropic-ai/sdk';
import QAStore from '../lib/qa-store.cjs';
import QAVision from '../lib/qa-vision.cjs';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

let _client = null;
const getClient = () => (_client = _client || new Anthropic());

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!QAStore.users(process.env).length) return res.status(503).json({ error: 'not_configured', detail: 'No QA passwords are set on the server' });
  if (!QAStore.identify(req.headers['x-qa-password'], process.env)) return res.status(401).json({ error: 'wrong_password' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'not_configured', detail: 'ANTHROPIC_API_KEY is not set' });
  const b = req.body || {};
  if (!QAVision.CRITERIA[b.category]) return res.status(400).json({ error: 'unknown_category' });
  if (typeof b.image !== 'string' || b.image.length < 100 || b.image.length > 3e6) return res.status(400).json({ error: 'bad_image' });
  try {
    const out = await QAVision.check(getClient(), b.category, b.image, 'image/jpeg');
    if (out.error) return res.status(502).json(out);
    res.status(200).json(out);
  } catch (err) {
    console.error('qa-vision', err);
    res.status(502).json({ error: 'model_error' });
  }
}
