// Step 2 of the OAuth code flow: exchange the code, check the domain, set the
// session cookie.
import {
  signSession, parseCookies, serializeCookie,
  SESSION_COOKIE, OAUTH_COOKIE, SESSION_DAYS,
} from '../../lib/session.js';

function originOf(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return proto + '://' + host;
}

function deny(res, message) {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.status(403).send(
    '<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'background:#F1F3F9;color:#1C2945;font-family:system-ui,sans-serif}'
    + '.c{max-width:480px;padding:34px 38px;background:#fff;border-radius:18px;line-height:1.6;'
    + 'box-shadow:0 10px 30px -12px rgba(28,41,69,.28)}a{color:#11426B}</style>'
    + '<div class="c"><h1 style="font-size:19px;margin:0 0 10px">Sign-in failed</h1><p>'
    + message + '</p><p><a href="/api/auth/login">Try again</a></p></div>',
  );
}

// The token endpoint is called by us, over TLS, authenticated with the client
// secret, so the id_token it returns in that response is trustworthy without a
// separate JWKS signature check. We still verify the claims we care about.
function decodeClaims(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return null;
  const s = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  try {
    return JSON.parse(Buffer.from(s + pad, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const secret = process.env.SESSION_SECRET;
  if (!clientId || !clientSecret || !secret) return deny(res, 'Sign-in is not fully configured.');

  const cookies = parseCookies(req.headers.cookie);
  const saved = String(cookies[OAUTH_COOKIE] || '');
  const sep = saved.indexOf('|');
  const savedState = sep < 0 ? saved : saved.slice(0, sep);
  let next = sep < 0 ? '/' : saved.slice(sep + 1);
  if (!next.startsWith('/') || next.startsWith('//')) next = '/';

  const { code, state, error } = req.query;
  if (error) return deny(res, 'Google returned: ' + String(error));
  // Constant-ish comparison is overkill here, but the state must match to stop
  // a forged callback from logging someone into an attacker's account.
  if (!code || !state || !savedState || state !== savedState) {
    return deny(res, 'The sign-in link expired or did not match. Start again from the dashboard.');
  }

  let claims;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: originOf(req) + '/api/auth/callback',
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text();
      return deny(res, 'Google rejected the sign-in (HTTP ' + tokenRes.status + '). '
        + 'If this says redirect_uri_mismatch, the callback URL is not registered in the Google project. '
        + '<br><small>' + String(detail).slice(0, 300).replace(/[<>]/g, '') + '</small>');
    }
    claims = decodeClaims((await tokenRes.json()).id_token);
  } catch (err) {
    return deny(res, 'Could not reach Google: ' + String((err && err.message) || err));
  }

  if (!claims) return deny(res, 'Google did not return a readable identity token.');
  if (claims.aud !== clientId) return deny(res, 'Identity token was issued for a different app.');
  if (claims.exp && Date.now() / 1000 > claims.exp) return deny(res, 'Identity token had already expired.');

  const email = String(claims.email || '').toLowerCase();
  const domain = (process.env.ALLOWED_DOMAIN || 'covu.com').toLowerCase();
  const extra = String(process.env.ALLOWED_EMAILS || '')
    .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);

  if (!claims.email_verified) return deny(res, 'That Google account has an unverified email address.');
  const domainOk = claims.hd === domain || email.endsWith('@' + domain);
  if (!domainOk && extra.indexOf(email) < 0) {
    return deny(res, 'This dashboard is restricted to <b>' + domain + '</b> accounts. '
      + 'You signed in as <b>' + email.replace(/[<>]/g, '') + '</b>.');
  }

  const token = await signSession({
    email: email,
    name: claims.name || email,
    exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
  }, secret);

  res.setHeader('set-cookie', [
    serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 24 * 60 * 60 }),
    serializeCookie(OAUTH_COOKIE, '', { maxAge: 0 }),
  ]);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('location', next);
  res.status(302).end();
}
