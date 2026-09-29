// Credential storage and the invariants 0002 is supposed to enforce.
//
// These assert the schema stops bad states, not that the happy path works.
// A constraint nobody has watched reject something is a comment.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'csp-conn-'));
process.env.PGLITE_DIR = dir;
delete process.env.DATABASE_URL;
process.env.CREDENTIAL_KEY = Buffer
  .from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

const { query, close } = await import('../lib/db.js');
const { migrate } = await import('../scripts/migrate.js');
const { sealSecret, openSecret, maskSecret } = await import('../lib/crypto.js');

let orgId, connId;

before(async () => {
  await migrate({ quiet: true });
  orgId = (await query(
    `insert into org (slug, name) values ('acme', 'Acme') returning id`,
  )).rows[0].id;
  connId = (await query(
    `insert into connection (org_id, provider, external_id, label, secret_enc, scopes)
     values ($1, 'meta', '1132346424154633', 'Acme Business', $2, $3) returning id`,
    [orgId, await sealSecret('token-for-acme'), ['ads_read']],
  )).rows[0].id;
});

after(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });

test('a stored credential decrypts to what went in', async () => {
  const row = (await query('select secret_enc from connection where id = $1', [connId])).rows[0];
  assert.equal(await openSecret(row.secret_enc), 'token-for-acme');
});

test('the ciphertext in the column is not the token', async () => {
  const row = (await query('select secret_enc from connection where id = $1', [connId])).rows[0];
  const asText = Buffer.from(row.secret_enc).toString('utf8');
  assert.ok(!asText.includes('token-for-acme'), 'plaintext token found in bytea column');
});

test('an API source cannot exist without a connection', async () => {
  await assert.rejects(
    query(
      `insert into source (org_id, kind, transport, external_id, label)
       values ($1, 'meta_ads', 'api', 'act_1', 'No credential')`,
      [orgId],
    ),
    /source_api_needs_connection/,
    'a credential-less API source was accepted',
  );
});

test('a sheet source still needs no connection', async () => {
  const id = (await query(
    `insert into source (org_id, kind, transport, external_id, label)
     values ($1, 'gsc', 'sheet', 'sc-domain:acme.com', 'Acme organic') returning id`,
    [orgId],
  )).rows[0].id;
  assert.ok(id);
});

test('an API source with a connection is accepted', async () => {
  const id = (await query(
    `insert into source (org_id, kind, transport, external_id, label, connection_id)
     values ($1, 'meta_ads', 'api', 'act_4460021897602415', 'COVU Ads', $2) returning id`,
    [orgId, connId],
  )).rows[0].id;
  assert.ok(id);
});

test('a connection in use cannot be deleted out from under its sources', async () => {
  await assert.rejects(
    query('delete from connection where id = $1', [connId]),
    /violates foreign key|restrict/i,
    'deleting a connection orphaned a live source',
  );
});

test('one org cannot register the same provider account twice', async () => {
  await assert.rejects(
    query(
      `insert into connection (org_id, provider, external_id, label, secret_enc)
       values ($1, 'meta', '1132346424154633', 'Duplicate', $2)`,
      [orgId, await sealSecret('another-token')],
    ),
    /duplicate key|unique/i,
  );
});

test('two orgs may each connect the same provider account', async () => {
  // Agencies and the client they manage both legitimately hold a credential
  // for the same ad account. Tenancy must not make that a conflict.
  const other = (await query(
    `insert into org (slug, name) values ('beta', 'Beta') returning id`,
  )).rows[0].id;
  const id = (await query(
    `insert into connection (org_id, provider, external_id, label, secret_enc)
     values ($1, 'meta', '1132346424154633', 'Same account, other tenant', $2)
     returning id`,
    [other, await sealSecret('beta-token')],
  )).rows[0].id;
  assert.ok(id);
});

test('unhealthy connections are findable without scanning every org', async () => {
  await query(
    `update connection set status = 'error', last_error = 'API access blocked'
     where id = $1`, [connId],
  );
  const rows = (await query(
    `select id, last_error from connection where org_id = $1 and status <> 'ok'`,
    [orgId],
  )).rows;
  assert.equal(rows.length, 1);
  assert.match(rows[0].last_error, /blocked/);
});

test('maskSecret never reveals the middle of a token', () => {
  const masked = maskSecret('EAAZADT7uZCFXQBSl8PKLhVgxrIkQlIsDJbX83ShWB58');
  assert.ok(!masked.includes('uZCFXQBSl8PK'));
  assert.match(masked, /^EAAZ…/);
});
