// api/qa-geocode.js — where is a Salesforce project's address?
//
//   POST /api/qa-geocode  { address }  →  { lat, lon }   |   404 { error: 'no_match' }
//
// The QA review compares where a survey's photos were taken with where the project is,
// to catch a surveyor at the wrong house. The US Census geocoder is free and needs no
// key; the address is the project's, not the customer's name. The QA password is
// checked as on /api/qa-log. Answers are kept in memory for the life of the function.
import QAStore from '../lib/qa-store.cjs';

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };
const cache = new Map();

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!QAStore.users(process.env).length) return res.status(503).json({ error: 'not_configured' });
  if (!QAStore.identify(req.headers['x-qa-password'], process.env)) return res.status(401).json({ error: 'wrong_password' });
  const address = String((req.body || {}).address || '').trim().slice(0, 200);
  if (address.length < 6) return res.status(400).json({ error: 'bad_address' });
  if (cache.has(address)) { const hit = cache.get(address); return hit ? res.status(200).json(hit) : res.status(404).json({ error: 'no_match' }); }
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=' + encodeURIComponent(address), { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    const m = j && j.result && j.result.addressMatches && j.result.addressMatches[0];
    const out = m && m.coordinates ? { lat: m.coordinates.y, lon: m.coordinates.x } : null;
    cache.set(address, out);
    return out ? res.status(200).json(out) : res.status(404).json({ error: 'no_match' });
  } catch (e) {
    return res.status(502).json({ error: 'lookup_failed' });
  }
}
