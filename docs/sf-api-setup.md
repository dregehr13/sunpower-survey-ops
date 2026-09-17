# Salesforce API refresh — setup

Replaces the manual "export → push.sh" morning routine with a script/cron that
pulls the Site Survey report directly from Salesforce. Uses the OAuth 2.0 JWT
Bearer flow — no browser, no MFA prompt, safe to run unattended.

Code is built and tested (`node --test` passes, JWT signing verified against
the generated cert). It has **not** been run against the live org yet — that
needs the pieces below.

## What to ask the Salesforce admin for

1. **A Connected App** (Setup → App Manager → New Connected App)
   - Enable OAuth Settings
   - **Use digital signatures** — upload `sf-keys/sf-jwt.crt` (the public
     cert; already generated, lives in this repo's gitignored `sf-keys/`)
   - OAuth scope: `api` (Manage user data via APIs)
   - Permitted Users: **Admin approved users are pre-authorized**
   - Save, then under **Manage** → assign a permission set to the app
2. **One pre-authorized integration user** — either a dedicated service
   account or Doug's own user, admin's call — with:
   - API Enabled permission
   - Read access to whatever object the Site Survey report is built on
   - Assigned the permission set from step 1
3. **Three values back from the admin:**
   - Consumer Key (Client ID) from the Connected App
   - The org's login URL (`https://login.salesforce.com`, or the My Domain
     URL if My Domain is enabled — e.g. `https://ambia.my.salesforce.com`)
   - The integration user's username

## What to do with those values

Fill in `.env` at the repo root (already gitignored):

```
SF_LOGIN_URL=<my domain or login.salesforce.com>
SF_CLIENT_ID=<consumer key>
SF_USERNAME=<integration user username>
SF_REPORT_ID=00OUS00000AOYnZ2AX   # same report push.sh already uses
```

`SF_PRIVATE_KEY_FILE` is already set to `sf-keys/sf-jwt.key` — the private key
generated alongside the cert. Leave it; it's read from disk for local runs.

## First test

```bash
node scripts/refresh-sf.cjs
```

Fetches the report, parses it through the same code path as `parse-sf.js`,
and writes `data.js`/`data.json` locally without committing — diff it against
the current files before trusting it. Add `--commit` once it looks right to
have it commit and push (same as `push.sh`'s tail).

**Known gap:** the report is ~4,700 rows; the Analytics REST API's
synchronous endpoint caps at 2,000 and this will throw past that limit (see
the note in `lib/sf-report.cjs`). The fix is switching to Salesforce's
asynchronous Report Instance API (queue a run, poll for completion, read the
result) — same auth, same parsing, just a different fetch. Flag this back to
Claude to wire in once the row-count error shows up in a real test.

## Going fully automated (optional, later)

Once `scripts/refresh-sf.cjs` works locally, `api/refresh-sf.js` is the
serverless equivalent — same fetch/parse, but commits via the GitHub API the
way `api/update.js` already does, so it can run on a Vercel Cron with no local
machine involved. Needs these added as **Vercel** env vars (Project Settings →
Environment Variables) — `SF_PRIVATE_KEY` there is the actual PEM contents
pasted in, not a file path:

```
SF_LOGIN_URL, SF_CLIENT_ID, SF_USERNAME, SF_PRIVATE_KEY, SF_REPORT_ID
GITHUB_TOKEN      (already set — same one api/update.js uses)
CRON_SECRET       (any random string; Vercel Cron sends it automatically)
```

Then add to `vercel.json`:

```json
"crons": [{ "path": "/api/refresh-sf", "schedule": "0 13 * * 1-5" }]
```

(13:00 UTC ≈ 7am Mountain — adjust for DST if it matters.) Left out for now
so nothing calls this endpoint until it's been proven against real data.
