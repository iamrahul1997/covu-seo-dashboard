// Exercises the auth layer end to end against a locally spawned server, in all
// three configuration states. The Google redirect itself cannot be tested
// without real credentials, so this mints a session directly with
// SESSION_SECRET to prove the gate opens for a valid one and stays shut
// otherwise.
//
// Run: node scripts/auth-check.js
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signSession, SESSION_COOKIE } from '../lib/session.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}

async function withServer(port, env, fn) {
  const child = spawn('node', ['scripts/serve.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    const s = String(d);
    if (s.includes('Error') || s.includes('error:')) process.stdout.write('    server: ' + s);
  });
  try {
    for (let i = 0; i < 60; i++) {
      try {
        await fetch(`http://localhost:${port}/api/auth/me`);
        break;
      } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    await fn(`http://localhost:${port}`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 150));
  }
}

const SECRET = 'test-secret-not-used-in-production';
const FULL = {
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: SECRET,
};

console.log('\n1. No auth configured — should stay public');
await withServer(3311, {
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', SESSION_SECRET: '',
}, async (base) => {
  check('GET /', (await fetch(base + '/')).status, 200);
  const me = await fetch(base + '/api/auth/me');
  check('GET /api/auth/me', me.status, 200);
  check('authEnabled', (await me.json()).authEnabled, false);
});

console.log('\n2. Partially configured — should fail closed');
await withServer(3312, {
  GOOGLE_CLIENT_ID: FULL.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: '', SESSION_SECRET: '',
}, async (base) => {
  check('GET /', (await fetch(base + '/')).status, 503);
  check('GET /api/data', (await fetch(base + '/api/data')).status, 503);
});

console.log('\n3. Fully configured — should gate everything');
await withServer(3313, FULL, async (base) => {
  const page = await fetch(base + '/', { redirect: 'manual' });
  check('GET / unauthenticated', page.status, 401);
  const html = await page.text();
  check('login button present', html.includes('/api/auth/login') ? 'yes' : 'no', 'yes');

  const api = await fetch(base + '/api/data');
  check('GET /api/data unauthenticated', api.status, 401);
  check('api body is json error', (await api.json()).error, 'not authenticated');

  check('GET /app.js unauthenticated', (await fetch(base + '/app.js')).status, 401);

  const login = await fetch(base + '/api/auth/login', { redirect: 'manual' });
  check('GET /api/auth/login', login.status, 302);
  const dest = login.headers.get('location') || '';
  check('redirects to Google', dest.startsWith('https://accounts.google.com/') ? 'yes' : 'no', 'yes');
  check('requests covu.com domain', dest.includes('hd=covu.com') ? 'yes' : 'no', 'yes');
  check('sets state cookie', (login.headers.get('set-cookie') || '').includes('covu_oauth') ? 'yes' : 'no', 'yes');

  // Open-redirect guard.
  const eviL = await fetch(base + '/api/auth/login?next=https://evil.example.com', { redirect: 'manual' });
  const cookie = eviL.headers.get('set-cookie') || '';
  check('rejects absolute next', cookie.includes('evil.example.com') ? 'leaked' : 'stripped', 'stripped');

  // A valid session must open the gate.
  const good = await signSession({ email: 'rahul.poudel@covu.com', name: 'Rahul', exp: Date.now() + 6e5 }, SECRET);
  const withGood = { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(good)}` } };
  check('GET / with session', (await fetch(base + '/', withGood)).status, 200);
  const meOk = await fetch(base + '/api/auth/me', withGood);
  check('GET /api/auth/me with session', meOk.status, 200);
  check('me returns email', (await meOk.json()).email, 'rahul.poudel@covu.com');

  // Tampered and expired sessions must not.
  const tampered = good.slice(0, -4) + 'AAAA';
  check('tampered signature rejected',
    (await fetch(base + '/', { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(tampered)}` } })).status, 401);

  const expired = await signSession({ email: 'x@covu.com', exp: Date.now() - 1000 }, SECRET);
  check('expired session rejected',
    (await fetch(base + '/', { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(expired)}` } })).status, 401);

  const wrongKey = await signSession({ email: 'x@covu.com', exp: Date.now() + 6e5 }, 'a-different-secret');
  check('session signed with wrong secret rejected',
    (await fetch(base + '/', { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(wrongKey)}` } })).status, 401);

  // A forged callback with no matching state cookie must be refused.
  check('callback without state', (await fetch(base + '/api/auth/callback?code=abc&state=xyz')).status, 403);
});

console.log(failures ? `\n${failures} FAILED\n` : '\nall auth checks passed\n');
process.exit(failures ? 1 : 0);
