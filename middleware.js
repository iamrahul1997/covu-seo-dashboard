// Gates every route behind Google sign-in, restricted to one email domain.
//
// This runs before the static files AND before /api/data, which matters: the
// dashboard page is not the sensitive part, the 1.3MB JSON payload behind it is.
//
// Configuration is all-or-nothing on purpose:
//   * none of the three env vars set  -> auth is OFF, site is public (the state
//     it shipped in), and the dashboard shows an "unprotected" banner so this
//     cannot be forgotten about.
//   * all three set                   -> auth is ON, no redeploy needed.
//   * some but not all                -> fail CLOSED with a setup page, because
//     partial configuration means somebody meant to turn protection on.
import { verifySession, parseCookies, SESSION_COOKIE } from './lib/session.js';

export const config = {
  // Everything except Vercel's own internals, the auth endpoints themselves
  // (which obviously cannot require a session to reach), and the scheduled
  // ingest.
  //
  // api/cron/ is exempt because Vercel Cron presents `Authorization: Bearer
  // $CRON_SECRET`, not a session cookie — behind this gate it would get a 401
  // and the refresh would silently never run. It is not unprotected: the route
  // checks that secret itself and refuses to run at all when CRON_SECRET is
  // unset, which is the same fail-closed posture as the rest of this file.
  //
  // /api/health is deliberately NOT exempt. It reveals property names, row
  // counts and data dates, and nothing yet monitors it from outside, so it
  // stays behind sign-in. Open it up when there is an uptime check that needs
  // it, and give it a token of its own rather than making it public.
  matcher: ['/((?!_vercel/|api/auth/|api/cron/).*)'],
};

function page(title, body, status) {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title>'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'background:#F1F3F9;color:#1C2945;font-family:system-ui,-apple-system,Segoe UI,sans-serif}'
    + '.c{max-width:520px;padding:34px 38px;background:#fff;border-radius:18px;'
    + 'box-shadow:0 10px 30px -12px rgba(28,41,69,.28);line-height:1.6}'
    + 'h1{font-size:20px;margin:0 0 12px}code{background:#F1F3F9;padding:2px 6px;border-radius:5px;font-size:13px}'
    + 'a.btn{display:inline-block;margin-top:18px;background:#1C2945;color:#fff;text-decoration:none;'
    + 'padding:11px 20px;border-radius:11px;font-weight:700}</style>'
    + '<div class="c">' + body + '</div>',
    { status: status || 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

export default async function middleware(request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const secret = process.env.SESSION_SECRET;
  const configured = [clientId, clientSecret, secret].filter(Boolean).length;

  // Not configured at all — behave exactly as before.
  if (configured === 0) return;

  if (configured < 3) {
    const missing = [
      !clientId && 'GOOGLE_CLIENT_ID',
      !clientSecret && 'GOOGLE_CLIENT_SECRET',
      !secret && 'SESSION_SECRET',
    ].filter(Boolean);
    return page('Setup incomplete',
      '<h1>Sign-in is half-configured</h1><p>Access is blocked until it is finished. Still missing: '
      + missing.map((m) => '<code>' + m + '</code>').join(', ')
      + '.</p><p>Add them in the Vercel project’s Environment Variables, then redeploy.</p>', 503);
  }

  const url = new URL(request.url);
  const cookies = parseCookies(request.headers.get('cookie'));
  const session = await verifySession(cookies[SESSION_COOKIE], secret);
  if (session) return;

  // An unauthenticated API call should get a clean 401, not an HTML redirect.
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'not authenticated' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  const next = url.pathname + (url.search || '');
  return page('Sign in',
    '<h1>COVU SEO &amp; AEO Dashboard</h1>'
    + '<p>This dashboard is restricted to '
    + (process.env.ALLOWED_DOMAIN || 'covu.com') + ' accounts.</p>'
    + '<a class="btn" href="/api/auth/login?next=' + encodeURIComponent(next) + '">Sign in with Google</a>',
    401);
}
