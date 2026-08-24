import { serializeCookie, SESSION_COOKIE } from '../../lib/session.js';

export default function handler(req, res) {
  res.setHeader('set-cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0 }));
  res.setHeader('cache-control', 'no-store');
  res.setHeader('location', '/');
  res.status(302).end();
}
