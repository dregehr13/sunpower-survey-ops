// lib/sf-auth.cjs — Salesforce OAuth 2.0 JWT Bearer flow.
//
// No browser, no MFA prompt: a Connected App holds our public cert, we sign a
// short-lived JWT with the matching private key, and Salesforce exchanges it
// for an access token for one pre-authorized integration user. This is what
// makes the API refresh path runnable unattended (a cron function), unlike
// the interactive OAuth or username+password flows.
//
// Needs, from the Connected App + the pre-authorized user (see
// docs/sf-api-setup.md for the request to send SF admin):
//   SF_LOGIN_URL   — https://login.salesforce.com or the org's My Domain URL
//   SF_CLIENT_ID   — Connected App Consumer Key
//   SF_USERNAME    — the pre-authorized integration user's username
//   SF_PRIVATE_KEY — PEM private key matching the cert uploaded to the
//                    Connected App (sf-keys/sf-jwt.key locally; in Vercel,
//                    paste the PEM as-is — the platform preserves newlines)
'use strict';
const crypto = require('crypto');
const fs = require('fs');

// Local dev convenience only — Vercel has no filesystem to point this at, so
// production always sets SF_PRIVATE_KEY directly.
function resolvePrivateKey(explicit) {
  if (explicit) return explicit;
  if (process.env.SF_PRIVATE_KEY) return process.env.SF_PRIVATE_KEY;
  if (process.env.SF_PRIVATE_KEY_FILE) return fs.readFileSync(process.env.SF_PRIVATE_KEY_FILE, 'utf8');
  return undefined;
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildJWT({ clientId, username, audience, privateKey }) {
  const header = { alg: 'RS256' };
  const now = Math.floor(Date.now() / 1000);
  // Salesforce requires this be a few minutes at most; issued fresh per call.
  const payload = { iss: clientId, sub: username, aud: audience, exp: now + 180 };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

// Returns { access_token, instance_url, ... } — instance_url is the org's
// actual API host, which differs from the login host and is what every
// subsequent API call (e.g. the Analytics REST API) must be made against.
async function getAccessToken({ loginUrl, clientId, username, privateKey } = {}) {
  loginUrl = loginUrl || process.env.SF_LOGIN_URL;
  clientId = clientId || process.env.SF_CLIENT_ID;
  username = username || process.env.SF_USERNAME;
  privateKey = resolvePrivateKey(privateKey);
  const missing = ['loginUrl', 'clientId', 'username', 'privateKey'].filter(k =>
    !{ loginUrl, clientId, username, privateKey }[k]);
  if (missing.length) throw new Error('sf-auth: missing ' + missing.join(', ') + ' (env vars SF_LOGIN_URL / SF_CLIENT_ID / SF_USERNAME / SF_PRIVATE_KEY)');

  const assertion = buildJWT({ clientId, username, audience: loginUrl, privateKey });
  const res = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`sf-auth: token request failed (${res.status}): ${json.error} — ${json.error_description || ''}`.trim());
  }
  return json;
}

module.exports = { getAccessToken, buildJWT };
