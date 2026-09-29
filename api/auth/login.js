// Step 1 of the OAuth code flow: bounce the visitor to Google.
import { serializeCookie, OAUTH_COOKIE } from '../../lib/session.js';

function originOf(req) {
  // PUBLIC_ORIGIN pins the redirect URI, which Google requires to match a
  // registered value exactly. Preview deployments get a fresh hostname every
  // time, so without this only the registered origin can complete a sign-in.
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return proto + '://' + host;
}

function randomState() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export default function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(503).send('GOOGLE_CLIENT_ID is not set.');
    return;
  }

  const state = randomState();
  // Only ever return to a path on this site — never to an absolute URL a
  // visitor supplied, which would make this an open redirect.
  let next = typeof req.query.next === 'string' ? req.query.next : '/';
  if (!next.startsWith('/') || next.startsWith('//')) next = '/';

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: originOf(req) + '/api/auth/callback',
    response_type: 'code',
    scope: 'openid email profile',
    state: state,
    prompt: 'select_account',
  });

  res.setHeader('set-cookie', serializeCookie(OAUTH_COOKIE, state + '|' + next, { maxAge: 600 }));
  res.setHeader('cache-control', 'no-store');
  res.setHeader('location', 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
  res.status(302).end();
}
