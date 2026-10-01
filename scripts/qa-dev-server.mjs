#!/usr/bin/env node
// scripts/qa-dev-server.mjs — run the dashboard with the shared QA log, locally.
//
//   node scripts/qa-dev-server.mjs            → http://localhost:8732/#qa  (password: sunpower)
//   QA_PASSWORD=x PORT=9000 node scripts/qa-dev-server.mjs
//
// Serves this folder and mounts /api/qa-log on an in-process Postgres (PGlite)
// kept in .qa-dev-db/, through the same lib/qa-store.cjs the deployed function
// uses. It is for trying the shared log before Neon is provisioned; nothing here
// is deployed.
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const require = createRequire(import.meta.url);
const Store = require('../lib/qa-store.cjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 8732);
const env = { QA_PASSWORD: process.env.QA_PASSWORD || 'sunpower' };
const pg = new PGlite(path.join(root, '.qa-dev-db'));
const db = { query: (t, p) => pg.query(t, p) };

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/qa-log') {
    let body = null;
    if (req.method === 'POST') { const chunks = []; for await (const c of req) chunks.push(c); try { body = JSON.parse(Buffer.concat(chunks).toString() || 'null'); } catch (e) {} }
    const out = await Store.handle({ method: req.method, query: Object.fromEntries(url.searchParams), headers: req.headers, body }, env, db);
    res.writeHead(out.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(out.body));
  }
  let file = path.join(root, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(await readFile(file));
}).listen(port, () => console.log(`Dashboard with the shared QA log: http://localhost:${port}/#qa  (password: ${env.QA_PASSWORD})`));
