// Envelope encryption for third-party credentials.
//
// Web Crypto only, like lib/session.js, so this works unchanged in the Edge
// middleware and in Node functions. AES-256-GCM: authenticated, so a tampered
// ciphertext fails to decrypt rather than yielding plausible garbage.
//
// Stored layout, one bytea column:
//
//   [ 1 byte version ][ 12 byte IV ][ ciphertext || 16 byte GCM tag ]
//
// The version byte is not the key version — that lives in its own indexed
// column so a rotation can be driven by a query. This byte versions the
// *format*, so a future change of cipher can be told apart from this one
// without guessing from the length.
//
// CREDENTIAL_KEY is 32 bytes, base64. Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Losing it means every stored token is unrecoverable and every customer has
// to reconnect. It belongs in the platform's secret store, never in git, and
// never in the same place as a database dump — the two together are what an
// attacker needs, and separately neither is enough.

const FORMAT_V1 = 1;
const IV_BYTES = 12;

function keyMaterial() {
  const raw = process.env.CREDENTIAL_KEY;
  if (!raw) {
    throw new Error(
      'CREDENTIAL_KEY is not set. Third-party tokens cannot be stored or read '
      + 'without it. Generate one with: node -e "console.log(require(\'crypto\')'
      + '.randomBytes(32).toString(\'base64\'))"',
    );
  }
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) {
    throw new Error(`CREDENTIAL_KEY must decode to 32 bytes, got ${bytes.length}.`);
  }
  return bytes;
}

async function aesKey(usage) {
  return crypto.subtle.importKey(
    'raw', keyMaterial(), { name: 'AES-GCM' }, false, [usage],
  );
}

/**
 * Encrypt a token for storage. Returns a Uint8Array for the bytea column.
 *
 * A fresh IV per call is not optional with GCM: reusing one across two
 * messages under the same key leaks the XOR of the plaintexts and voids the
 * authentication guarantee entirely.
 */
export async function sealSecret(plaintext) {
  if (typeof plaintext !== 'string' || plaintext === '') {
    throw new Error('sealSecret expects a non-empty string.');
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await aesKey('encrypt');
  const body = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext),
  );

  const out = new Uint8Array(1 + IV_BYTES + body.byteLength);
  out[0] = FORMAT_V1;
  out.set(iv, 1);
  out.set(new Uint8Array(body), 1 + IV_BYTES);
  return out;
}

/**
 * Decrypt a stored credential.
 *
 * Throws on a wrong key, a truncated column or any tampering — GCM cannot
 * tell those apart, and neither should a caller. The message deliberately
 * carries no detail about which it was: a decryption oracle that
 * distinguishes failure modes is a gift to anyone probing it.
 */
export async function openSecret(stored) {
  const bytes = stored instanceof Uint8Array ? stored : new Uint8Array(stored);
  if (bytes.length < 1 + IV_BYTES + 16) {
    throw new Error('Stored credential is malformed.');
  }
  if (bytes[0] !== FORMAT_V1) {
    throw new Error(`Unsupported credential format version ${bytes[0]}.`);
  }
  const iv = bytes.subarray(1, 1 + IV_BYTES);
  const body = bytes.subarray(1 + IV_BYTES);

  let plain;
  try {
    const key = await aesKey('decrypt');
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body);
  } catch {
    throw new Error('Could not decrypt credential.');
  }
  return new TextDecoder().decode(plain);
}

/**
 * Redact a token for logs and error messages.
 *
 * Every path that touches a secret should funnel its human-readable output
 * through this. A token that reaches a log is as exposed as one in git: the
 * Meta system user token in this project's own history got there by being
 * pasted into a URL, not by anyone deciding to publish it.
 */
export function maskSecret(value) {
  const s = String(value || '');
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}…${s.slice(-4)} (${s.length} chars)`;
}
