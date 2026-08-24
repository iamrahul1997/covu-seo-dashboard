// Who is signed in, for the header chip. The session cookie is HttpOnly so the
// page cannot read it directly.
//
// Note this route sits under /api/auth/ and is therefore NOT behind the
// middleware matcher — it has to verify the session itself.
import { verifySession, parseCookies, SESSION_COOKIE } from '../../lib/session.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const secret = process.env.SESSION_SECRET;
  const authEnabled = Boolean(
    secret && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
  );
  if (!authEnabled) {
    res.status(200).json({ authEnabled: false });
    return;
  }
  const cookies = parseCookies(req.headers.cookie);
  const session = await verifySession(cookies[SESSION_COOKIE], secret);
  if (!session) {
    res.status(401).json({ authEnabled: true, error: 'not authenticated' });
    return;
  }
  res.status(200).json({
    authEnabled: true,
    email: session.email,
    name: session.name,
    expires: session.exp,
  });
}
