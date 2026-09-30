// Password sign-in. Exercises the real handler with mock req/res, so the
// redirect, the cookie and the rejection path are all the shipping code.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET = 'test-secret-not-used-anywhere-real';
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASSWORD;

const { default: handler, credentials, usingDefaults } = await import('../api/auth/password.js');
const { verifySession, SESSION_COOKIE } = await import('../lib/session.js');

function mockRes() {
  const res = {
    headers: {}, statusCode: null, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    end() { return this; },
  };
  return res;
}

const post = (body) => ({ method: 'POST', body, headers: {} });

test('the shipped default is admin/admin', () => {
  assert.deepEqual(credentials(), { user: 'admin', pass: 'admin' });
  assert.equal(usingDefaults(), true);
});

test('correct credentials issue a verifiable session cookie', async () => {
  const res = mockRes();
  await handler(post({ username: 'admin', password: 'admin', next: '/' }), res);

  assert.equal(res.statusCode, 302);
  const cookie = res.headers['set-cookie'];
  assert.ok(cookie && cookie.includes(SESSION_COOKIE), 'no session cookie set');

  const token = String(cookie).split(';')[0].split('=').slice(1).join('=');
  const session = await verifySession(token, process.env.SESSION_SECRET);
  assert.ok(session, 'issued cookie did not verify');
  assert.equal(session.email, 'admin');
  assert.equal(session.via, 'password');
});

test('the session cookie is HttpOnly and SameSite', async () => {
  const res = mockRes();
  await handler(post({ username: 'admin', password: 'admin' }), res);
  const cookie = String(res.headers['set-cookie']);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite/i);
});

test('a wrong password sets no cookie', async () => {
  const res = mockRes();
  await handler(post({ username: 'admin', password: 'wrong' }), res);
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers['set-cookie'], undefined, 'a failed sign-in issued a cookie');
  assert.match(String(res.headers.location), /error=1/);
});

test('a wrong username sets no cookie', async () => {
  const res = mockRes();
  await handler(post({ username: 'root', password: 'admin' }), res);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('a missing body does not authenticate', async () => {
  const res = mockRes();
  await handler(post({}), res);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('an empty password does not match an empty configured one', async () => {
  // Guards the case where ADMIN_PASSWORD is set to '' and the fallback makes
  // it 'admin' — the blank must not become a skeleton key.
  const res = mockRes();
  await handler(post({ username: 'admin', password: '' }), res);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('next cannot be used as an open redirect', async () => {
  for (const hostile of ['//evil.example', 'https://evil.example', 'javascript:alert(1)']) {
    const res = mockRes();
    await handler(post({ username: 'admin', password: 'admin', next: hostile }), res);
    assert.equal(res.headers.location, '/', `open redirect via ${hostile}`);
  }
});

test('a safe relative next is honoured', async () => {
  const res = mockRes();
  await handler(post({ username: 'admin', password: 'admin', next: '/blog?range=90' }), res);
  assert.equal(res.headers.location, '/blog?range=90');
});

test('GET is rejected', async () => {
  const res = mockRes();
  await handler({ method: 'GET', headers: {}, body: {} }, res);
  assert.equal(res.statusCode, 405);
});

test('custom credentials replace the defaults', async () => {
  process.env.ADMIN_USER = 'rahul';
  process.env.ADMIN_PASSWORD = 'a-much-better-password';
  assert.equal(usingDefaults(), false);

  const bad = mockRes();
  await handler(post({ username: 'admin', password: 'admin' }), bad);
  assert.equal(bad.headers['set-cookie'], undefined, 'defaults still worked after being overridden');

  const good = mockRes();
  await handler(post({ username: 'rahul', password: 'a-much-better-password' }), good);
  assert.ok(good.headers['set-cookie']);

  delete process.env.ADMIN_USER;
  delete process.env.ADMIN_PASSWORD;
});
