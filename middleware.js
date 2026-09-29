// Gates every route behind a username and password.
//
// This runs before the static files AND before /api/data, which matters: the
// dashboard page is not the sensitive part, the 1.3MB JSON payload behind it is.
//
// Google sign-in and the covu.com domain restriction were removed on
// 2026-09-29 at the owner's instruction: this is becoming a product other
// companies use, and a gate that only admits one company's staff cannot serve
// it. Credentials are now ADMIN_USER / ADMIN_PASSWORD, defaulting to
// admin/admin.
//
// Configuration:
//   * SESSION_SECRET unset -> auth is OFF and the site is public, the state it
//     shipped in, with a banner on the dashboard so it cannot be forgotten.
//   * SESSION_SECRET set   -> auth is ON. Credentials fall back to admin/admin
//     when ADMIN_USER / ADMIN_PASSWORD are absent, and the sign-in page says so
//     while that is true.
//
// The OAuth routes still exist and still work if Google credentials are
// present, but nothing advertises them and no domain is enforced any more.
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

/** Minimal HTML escape for values interpolated into the sign-in page. */
function esc(value) {
  return String(value || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

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
    + 'padding:11px 20px;border-radius:11px;font-weight:700}'
    + 'label{display:block;margin:14px 0;font-weight:700;font-size:13px}'
    + 'input{display:block;width:100%;margin-top:6px;padding:10px 12px;font:inherit;'
    + 'border:1px solid #dfe3ec;border-radius:10px;background:#fff;color:inherit}'
    + 'button{margin-top:8px;background:#1C2945;color:#fff;border:0;padding:11px 20px;'
    + 'border-radius:11px;font:inherit;font-weight:700;cursor:pointer}'
    + '.warn{margin-top:20px;background:rgba(180,105,14,.09);border:1px solid rgba(180,105,14,.28);'
    + 'border-radius:12px;padding:11px 14px;font-size:13px;color:#7a4708}</style>'
    + '<div class="c">' + body + '</div>',
    { status: status || 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

export default async function middleware(request) {
  const secret = process.env.SESSION_SECRET;

  // No secret, no sessions to verify: the site is public, as it shipped.
  if (!secret) return;

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
  const failed = url.searchParams.get('error') === '1';

  // Reading the credentials here only to decide whether to warn. The check
  // itself happens in /api/auth/password; this is Edge code and must not grow
  // a second copy of the comparison.
  const defaults = !process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD;

  return page('Sign in',
    '<h1>COVU Search &amp; Ads Dashboard</h1>'
    + (failed ? '<p style="color:#B00020;font-weight:700">That username or password was not correct.</p>' : '')
    + '<form method="POST" action="/api/auth/password">'
    + '<input type="hidden" name="next" value="' + esc(next) + '">'
    + '<label>Username<input name="username" autocomplete="username" autofocus required></label>'
    + '<label>Password<input name="password" type="password" autocomplete="current-password" required></label>'
    + '<button type="submit">Sign in</button>'
    + '</form>'
    + (defaults
      ? '<p class="warn"><b>Default credentials are in use.</b> Anyone who finds '
        + 'this URL can sign in with <code>admin</code> / <code>admin</code> and read '
        + 'this account\u2019s advertising data. Set <code>ADMIN_USER</code> and '
        + '<code>ADMIN_PASSWORD</code> in the Vercel project to close that.</p>'
      : ''),
    401);
}
