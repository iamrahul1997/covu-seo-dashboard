// Username and password sign-in.
//
// Replaces the Google/covu.com gate as the way in. Credentials come from the
// environment and default to admin/admin, so this works with nothing
// configured — which is the point, and also the risk. See WARNING below.
//
// The session it issues is the same signed cookie the OAuth path used, so
// middleware.js, /api/auth/me and logout need no special case: they verify a
// signature and do not care how the identity was established.
//
// WARNING — default credentials.
// admin/admin is guessable by anyone who finds the URL, and this deployment
// serves real advertising data. Set ADMIN_USER and ADMIN_PASSWORD in the
// Vercel project to something else. While the defaults are in use the sign-in
// page says so in plain sight, because a warning nobody sees is decoration.

import { signSession, serializeCookie, SESSION_COOKIE, SESSION_DAYS } from '../../lib/session.js';

const DEFAULT_USER = 'admin';
const DEFAULT_PASS = 'admin';

export function credentials() {
  return {
    user: process.env.ADMIN_USER || DEFAULT_USER,
    pass: process.env.ADMIN_PASSWORD || DEFAULT_PASS,
  };
}

/** True while either credential is still the shipped default. */
export function usingDefaults() {
  const { user, pass } = credentials();
  return user === DEFAULT_USER || pass === DEFAULT_PASS;
}

/**
 * Compare without leaking length or position through timing.
 *
 * A plain === returns as soon as two characters differ, which over enough
 * attempts reveals the password a character at a time. This always walks the
 * full width of both inputs.
 */
function timingSafeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  const width = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < width; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return Object.fromEntries(new URLSearchParams(req.body));
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return Object.fromEntries(new URLSearchParams(raw));
}

/** Only allow redirects back into this site. */
function safeNext(value) {
  const next = String(value || '/');
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export default async function handler(req, res) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'SESSION_SECRET is not set; sessions cannot be signed.' });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const body = await readBody(req);
  const { user, pass } = credentials();

  // A fixed delay on every attempt, right or wrong. It does not stop a
  // determined attacker — that needs a rate limiter with shared state, which a
  // stateless function cannot provide — but it turns an unlimited-speed guess
  // loop into a slow one, and it costs a legitimate sign-in a quarter second.
  await new Promise((r) => setTimeout(r, 250));

  const ok = timingSafeEqual(body.username, user) && timingSafeEqual(body.password, pass);
  if (!ok) {
    const next = safeNext(body.next);
    res.setHeader('location', '/?error=1&next=' + encodeURIComponent(next));
    res.status(302).end();
    return;
  }

  const token = await signSession({
    email: user,
    name: user,
    via: 'password',
    exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
  }, secret);

  res.setHeader('set-cookie', serializeCookie(SESSION_COOKIE, token, {
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  }));
  res.setHeader('cache-control', 'no-store');
  res.setHeader('location', safeNext(body.next));
  res.status(302).end();
}
