// lib/qa-store.cjs — the Site Survey QA review history, in Postgres.
//
// One history for every viewer: a coordinator's review is on the Log for the
// whole team the moment it is saved, and an account's review count is the same
// number for everyone. It replaced a per-browser localStorage log.
//
// It talks to the database through a single seam, db.query(text, params) →
// { rows }, so the same code runs against Neon in production (api/qa-log.js)
// and an in-process Postgres in the tests (test/qa-store.test.js) — real SQL on
// both sides, no mocked queries. Nothing here knows which Postgres it is.
//
// What is stored, and what is deliberately not:
//   stored   — the review (status, summary, findings, counts), the project ID,
//              the surveyor and reviewer names, and the report's name, size and
//              SHA-256 (so the same file is recognised again)
//   not      — the report PDF, its photos, the customer's name, the customer's
//              address. Reports hold names and photos of the inside of homes;
//              the project ID is enough to find the account in Salesforce.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpsQAStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const STATUSES = ['Passed', 'Failed - Gaps Found', 'Passed with Override'];
  const SOURCES = ['Coordinator', 'Agent (AI)'];
  const VENDORS = ['sitecapture', 'radicl'];

  // Statements, not one script: Neon's HTTP driver runs a single statement per
  // call. Every one is idempotent, so the schema is created on first use and a
  // re-run is harmless — there is no migration step to remember.
  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS qa_reviews (
       id            text PRIMARY KEY,
       project       text NOT NULL,
       n             integer NOT NULL,
       created       timestamptz NOT NULL DEFAULT now(),
       review_date   text,
       reviewer      text NOT NULL,
       source        text NOT NULL,
       status        text NOT NULL,
       override      text,
       summary       text,
       template      text NOT NULL,
       vendor        text NOT NULL,
       surveyor      text,
       survey_date   text,
       report_created text,
       file_name     text,
       file_size     bigint,
       file_hash     text,
       suggested     text,
       counts        jsonb,
       sf            jsonb,
       pack          jsonb,
       photos        jsonb,
       findings      jsonb,
       new_to_spec   jsonb,
       deleted_at    timestamptz,
       deleted_by    text
     )`,
    // Added after the first release; idempotent like everything here.
    `ALTER TABLE qa_reviews ADD COLUMN IF NOT EXISTS photo_link text`,
    `ALTER TABLE qa_reviews ADD COLUMN IF NOT EXISTS report_link text`,
    `CREATE INDEX IF NOT EXISTS qa_reviews_project ON qa_reviews (project)`,
    `CREATE INDEX IF NOT EXISTS qa_reviews_hash ON qa_reviews (file_hash)`,
    `CREATE INDEX IF NOT EXISTS qa_reviews_created ON qa_reviews (created DESC)`,
  ];

  async function ensureSchema(db) { for (const s of SCHEMA) await db.query(s); }

  // ── Validation ─────────────────────────────────────
  // The page is the only writer, but the endpoint is reachable by anyone who
  // holds the password, so it takes nothing on trust: every string is trimmed to
  // a length, every enum is checked, every array is capped.
  const str = (v, max) => (v == null ? '' : String(v)).trim().slice(0, max);
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const intOr = (v, d) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);

  function validate(input) {
    const r = obj(input);
    if (!r) return { error: 'review must be an object' };
    const project = str(r.project, 40).toUpperCase();
    // Salesforce names run like 2321LOPE, 2639REES-1 and 350VPITT - Battery Only.
    if (!/^[A-Z0-9][A-Z0-9 .\-]{2,39}$/.test(project)) return { error: 'project must be 3–40 letters, digits, dots, spaces or dashes' };
    if (!STATUSES.includes(r.status)) return { error: 'status must be one of ' + STATUSES.join(', ') };
    const source = r.source == null ? 'Coordinator' : r.source;
    if (!SOURCES.includes(source)) return { error: 'source must be one of ' + SOURCES.join(', ') };
    const vendor = str(r.vendor, 20);
    if (!VENDORS.includes(vendor)) return { error: 'vendor must be one of ' + VENDORS.join(', ') };
    const template = str(r.template, 40);
    if (!/^[a-z0-9-]{3,40}$/.test(template)) return { error: 'template is not a template id' };
    const reviewer = str(r.reviewer, 60);
    if (!reviewer) return { error: 'reviewer is required' };
    const status = r.status;
    const override = str(r.override, 2000);
    if (status === 'Passed with Override' && override.length < 5) return { error: 'an override needs a reason' };
    const f = obj(r.file) || {};
    const hash = str(f.hash, 64).toLowerCase();
    if (hash && !/^[0-9a-f]{64}$/.test(hash)) return { error: 'file.hash must be a SHA-256 hex digest' };
    const findings = (Array.isArray(r.findings) ? r.findings : []).slice(0, 400).map(x => ({
      id: str(x && x.id, 120), layer: str(x && x.layer, 2), area: str(x && x.area, 60),
      status: str(x && x.status, 12), severity: str(x && x.severity, 8), standing: !!(x && x.standing),
      title: str(x && x.title, 200), detail: str(x && x.detail, 600),
    }));
    const c = obj(r.counts) || {};
    const counts = {};
    for (const k of ['missHard', 'missWarn', 'gap', 'standingGaps', 'verify', 'pass', 'na']) counts[k] = Math.max(0, Math.min(10000, intOr(c[k], 0)));
    // Radicl delivers its photos as a Drive folder. The link is kept with the review
    // so the originals can be opened later; only a Google Drive address is accepted.
    const photoLink = str(r.photoLink, 400);
    if (photoLink && !/^https:\/\/(drive|docs)\.google\.com\//.test(photoLink)) return { error: 'photoLink must be a Google Drive link' };
    const reportLink = str(r.reportLink, 400);
    if (reportLink && !/^https:\/\/(drive|docs)\.google\.com\//.test(reportLink)) return { error: 'reportLink must be a Google Drive link' };
    const sf = obj(r.sf);
    const pk = obj(r.pack), ph = obj(r.photos);
    return { rec: {
      id: str(r.id, 80), project, n: Math.max(1, intOr(r.n, 1)),
      created: r.created && !isNaN(Date.parse(r.created)) ? new Date(r.created).toISOString() : null,
      date: str(r.date, 20), reviewer, source, status, override,
      summary: str(r.summary, 20000), template, vendor,
      surveyor: str(r.surveyor, 80), surveyDate: str(r.surveyDate, 20), reportCreated: str(r.reportCreated, 20),
      file: { name: str(f.name, 200), size: Math.max(0, intOr(f.size, 0)), hash }, photoLink, reportLink,
      suggested: str(r.suggested, 30), counts,
      // The Salesforce address is dropped on purpose: the task id finds the account.
      sf: sf ? { task_id: str(sf.task_id, 30), resource: str(sf.resource, 40), status: str(sf.status, 30) } : null,
      pack: pk ? { name: str(pk.name, 200), matched: intOr(pk.matched, 0), folders: intOr(pk.folders, 0) } : null,
      photos: ph ? { total: intOr(ph.total, 0), ok: intOr(ph.ok, 0), bad: intOr(ph.bad, 0) } : null,
      findings,
      newToSpec: (Array.isArray(r.newToSpec) ? r.newToSpec : []).slice(0, 25).map(x => str(x, 200)),
    } };
  }

  // ── Row ↔ record ───────────────────────────────────
  // The page's record shape (camelCase, nested file) is the contract; the table
  // is flat. These two functions are the only place the difference lives.
  function toRecord(row) {
    return {
      id: row.id, project: row.project, n: row.n, created: new Date(row.created).toISOString(), date: row.review_date || '',
      reviewer: row.reviewer, source: row.source, status: row.status, override: row.override || '', summary: row.summary || '',
      template: row.template, vendor: row.vendor, surveyor: row.surveyor || '', surveyDate: row.survey_date || '', reportCreated: row.report_created || '',
      file: { name: row.file_name || '', size: Number(row.file_size || 0), hash: row.file_hash || '' }, photoLink: row.photo_link || '', reportLink: row.report_link || '',
      suggested: row.suggested || '', counts: row.counts || {}, sf: row.sf || null, pack: row.pack || null, photos: row.photos || null,
      findings: row.findings || [], newToSpec: row.new_to_spec || [],
    };
  }

  const COLS = ['id', 'project', 'n', 'created', 'review_date', 'reviewer', 'source', 'status', 'override', 'summary', 'template', 'vendor',
    'surveyor', 'survey_date', 'report_created', 'file_name', 'file_size', 'file_hash', 'suggested', 'counts', 'sf', 'pack', 'photos', 'findings', 'new_to_spec', 'photo_link', 'report_link'];
  const JSONCOLS = new Set(['counts', 'sf', 'pack', 'photos', 'findings', 'new_to_spec']);
  // Everything after id / project / n / created, in column order.
  const REST = COLS.slice(4);
  const restValues = rec => [rec.date, rec.reviewer, rec.source, rec.status, rec.override, rec.summary, rec.template, rec.vendor,
    rec.surveyor, rec.surveyDate, rec.reportCreated, rec.file.name, rec.file.size, rec.file.hash || null, rec.suggested,
    JSON.stringify(rec.counts), JSON.stringify(rec.sf), JSON.stringify(rec.pack), JSON.stringify(rec.photos), JSON.stringify(rec.findings), JSON.stringify(rec.newToSpec), rec.photoLink || null, rec.reportLink || null];
  // $1 id, $2 project, $3 n, $4 created, then REST from $5.
  const ph = (i, col) => JSONCOLS.has(col) ? `$${i}::jsonb` : `$${i}`;
  const RESTPH = REST.map((c, i) => ph(i + 5, c)).join(', ');

  // ── Reads ──────────────────────────────────────────
  async function list(db, limit) {
    const { rows } = await db.query(`SELECT * FROM qa_reviews WHERE deleted_at IS NULL ORDER BY created DESC LIMIT $1`, [Math.min(Math.max(intOr(limit, 2000), 1), 5000)]);
    return rows.map(toRecord);
  }

  // ── Writes ─────────────────────────────────────────
  // The summary Salesforce receives opens "QA review N". The browser can only guess
  // N (it cannot see a review a colleague just deleted, or saved), so the number
  // the server assigns is written into that opening line.
  //
  // The review number is the count of the account's reviews so far, deleted ones
  // included (an id is never reused), computed inside the INSERT. Two coordinators
  // saving the same account in the same instant both compute the same number; the
  // primary key lets one through and the other retries with the next. No lock, no
  // transaction — which is also what lets this run over Neon's HTTP driver.
  async function insert(db, rec) {
    const sql = `WITH nxt AS (SELECT count(*)::int + 1 AS n FROM qa_reviews WHERE project = $1)
      INSERT INTO qa_reviews (${COLS.join(', ')})
      SELECT 'QA-' || $1 || '-' || nxt.n, $1, nxt.n, COALESCE($2::timestamptz, now()), ${REST.map((c, i) => c === 'summary' ? `regexp_replace(${ph(i + 3, c)}, '^QA review [0-9]+', 'QA review ' || nxt.n)` : ph(i + 3, c)).join(', ')}
      FROM nxt RETURNING *`;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const { rows } = await db.query(sql, [rec.project, rec.created, ...restValues(rec)]);
        return toRecord(rows[0]);
      } catch (e) {
        if (e && e.code === '23505' && attempt < 5) continue;
        throw e;
      }
    }
  }

  // Bring reviews across from a browser's old local log. Same file and same id →
  // already here, skip. Same id but a different report → that number was taken
  // by someone else's review of the account in the meantime, so it is renumbered
  // rather than lost.
  async function importMany(db, recs) {
    let inserted = 0, skipped = 0, renumbered = 0;
    for (const input of recs.slice(0, 1000)) {
      const v = validate(input);
      if (v.error) { skipped++; continue; }
      const rec = v.rec;
      if (rec.id) {
        const { rows } = await db.query(`SELECT file_hash FROM qa_reviews WHERE id = $1`, [rec.id]);
        if (rows.length) {
          if ((rows[0].file_hash || '') === rec.file.hash) { skipped++; continue; }
          await insert(db, rec); inserted++; renumbered++; continue;
        }
        await db.query(`INSERT INTO qa_reviews (${COLS.join(', ')}) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), ${RESTPH})`, [rec.id, rec.project, rec.n, rec.created, ...restValues(rec)]);
        inserted++;
      } else { await insert(db, rec); inserted++; }
    }
    return { inserted, skipped, renumbered };
  }

  async function remove(db, id, by) {
    const { rows } = await db.query(`UPDATE qa_reviews SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id, str(by, 60)]);
    return rows.length > 0;
  }

  // ── The endpoint, as a pure function ───────────────
  // handle({ method, query, headers, body }, env, db) → { status, body }.
  // api/qa-log.js is a thin wrapper that reads the request and writes this out.
  function passwordOk(given, expected) {
    if (!expected || typeof given !== 'string') return false;
    const a = Buffer.from(given), b = Buffer.from(expected);
    return a.length === b.length && require('node:crypto').timingSafeEqual(a, b);
  }

  // Who is this? Each person has their own password, so the Reviewer on a review
  // is the person whose password was typed and cannot be typed over by anyone
  // else. QA_USERS is a JSON object of { "<password>": "<name>" } kept in the
  // environment (never in the repo); QA_PASSWORD is the manager's own, named by
  // QA_PASSWORD_NAME. Both are compared in constant time, every entry, so the
  // answer does not leak which password came closest.
  function users(env) {
    let map = {};
    if (env.QA_USERS) { try { const j = JSON.parse(env.QA_USERS); if (j && typeof j === 'object' && !Array.isArray(j)) map = j; } catch (e) { /* an unreadable list grants nobody */ } }
    const out = Object.entries(map).filter(([pw, name]) => pw && typeof name === 'string' && name.trim()).map(([pw, name]) => ({ pw, name: name.trim() }));
    if (env.QA_PASSWORD) out.push({ pw: env.QA_PASSWORD, name: (env.QA_PASSWORD_NAME || 'Douglas Regehr').trim() });
    return out;
  }
  function identify(given, env) {
    let who = null;
    for (const u of users(env)) if (passwordOk(given, u.pw)) who = who || u;
    return who ? { name: who.name } : null;
  }

  async function handle(req, env, db) {
    if (!users(env).length) return { status: 503, body: { error: 'not_configured', detail: 'No QA passwords are set on the server (QA_USERS or QA_PASSWORD)' } };
    const who = identify(req.headers && req.headers['x-qa-password'], env);
    if (!who) return { status: 401, body: { error: 'wrong_password' } };
    if (!db) return { status: 503, body: { error: 'not_configured', detail: 'No database is connected (DATABASE_URL)' } };
    await ensureSchema(db);
    const q = req.query || {};
    if (req.method === 'GET') return { status: 200, body: { user: who.name, reviews: await list(db, q.limit) } };
    if (req.method === 'POST') {
      const b = obj(req.body) || {};
      if (Array.isArray(b.import)) return { status: 200, body: await importMany(db, b.import) };
      const v = validate(b.review);
      if (v.error) return { status: 400, body: { error: v.error } };
      v.rec.created = null;                       // the server's clock, not the browser's
      v.rec.reviewer = who.name;                  // and the password's owner, not whatever the page said
      return { status: 201, body: { review: await insert(db, v.rec) } };
    }
    if (req.method === 'DELETE') {
      const id = str(q.id, 80);
      if (!id) return { status: 400, body: { error: 'id is required' } };
      const ok = await remove(db, id, who.name);
      return ok ? { status: 200, body: { ok: true } } : { status: 404, body: { error: 'no such review' } };
    }
    return { status: 405, body: { error: 'method not allowed' } };
  }

  return { STATUSES, SOURCES, SCHEMA, ensureSchema, validate, toRecord, list, insert, importMany, remove, handle, passwordOk, identify, users };
});
