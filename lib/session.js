// Signed session cookies, shared by the Edge middleware and the Node auth
// routes. Uses Web Crypto only, which exists in both runtimes — no deps.
//
// Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256 of that string)
// The payload is readable by anyone holding the cookie (it only carries an
// email and an expiry) but cannot be altered without SESSION_SECRET.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToB64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

export async function signSession(payload, secret) {
  const body = bytesToB64url(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return body + '.' + bytesToB64url(new Uint8Array(sig));
}

export async function verifySession(token, secret) {
  if (!token || !secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      'HMAC', key, b64urlToBytes(parts[1]), encoder.encode(parts[0]),
    );
    if (!ok) return null;
    const payload = JSON.parse(decoder.decode(b64urlToBytes(parts[0])));
    if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, opts) {
  const o = opts || {};
  let s = name + '=' + encodeURIComponent(value);
  s += '; Path=' + (o.path || '/');
  if (typeof o.maxAge === 'number') s += '; Max-Age=' + o.maxAge;
  s += '; HttpOnly';
  s += '; SameSite=' + (o.sameSite || 'Lax');
  if (o.secure !== false) s += '; Secure';
  return s;
}

export const SESSION_COOKIE = 'covu_session';
export const OAUTH_COOKIE = 'covu_oauth';
export const SESSION_DAYS = 7;
