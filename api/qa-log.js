// api/qa-log.js — the shared Site Survey QA review history.
//
//   GET    /api/qa-log                →  { reviews }          every live review, newest first
//   POST   /api/qa-log  { review }    →  { review }           saved; the server assigns id and number
//   POST   /api/qa-log  { import }    →  { inserted, skipped, renumbered }   a browser's old local log
//   DELETE /api/qa-log?id=&by=        →  { ok }               soft delete
//
// Every call carries the password in x-qa-password. It is checked HERE, against
// the QA_PASSWORD env var — the page's own prompt only decides whether to show
// the page, and a static file cannot keep a secret. Without QA_PASSWORD or a
// database the endpoint answers 503 not_configured and the page falls back to
// this browser's own log, so nothing breaks before this is set up.
//
// The Postgres is Neon, provisioned through the Vercel Marketplace, which injects
// DATABASE_URL. All of the logic is in lib/qa-store.cjs and is tested against a
// real Postgres in test/qa-store.test.js; this file only reads the request.
import { neon } from '@neondatabase/serverless';
import QAStore from '../lib/qa-store.cjs';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

// Created on first use, not at import: the build evaluates this module before
// any environment is attached.
let _db = null;
function getDb() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return null;
  if (!_db) {
    const sql = neon(url);
    _db = { query: async (text, params) => ({ rows: await sql.query(text, params) }) };
  }
  return _db;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const out = await QAStore.handle(
      { method: req.method, query: req.query, headers: req.headers, body: req.body },
      process.env, getDb());
    res.status(out.status).json(out.body);
  } catch (err) {
    console.error('qa-log', err);
    res.status(500).json({ error: 'server_error' });
  }
}
