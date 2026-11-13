import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { protectKey, restoreKey, PostgresPassLedger } from './pass-postgres.js';
import { createPassService } from './moth-pass.js';

test('issuer encryption authenticates data and rejects missing or changed Secrets', () => {
  const secret = randomBytes(32).toString('hex');
  const jwk = { kty: 'RSA', d: 'test-sensitive-value' };
  const encrypted = protectKey(jwk, secret);
  assert.equal(encrypted.includes(jwk.d), false);
  assert.deepEqual(restoreKey(encrypted, secret), jwk);
  assert.notEqual(protectKey(jwk, secret), encrypted);
  assert.throws(() => restoreKey(encrypted, randomBytes(32).toString('hex')));
  const damaged = JSON.parse(encrypted); damaged.tag = randomBytes(16).toString('base64');
  assert.throws(() => restoreKey(JSON.stringify(damaged), secret));
  assert.throws(() => protectKey(jwk, 'short'));
  assert.throws(() => restoreKey(encrypted, 'short'));
});

test('PostgreSQL persists issuer/replay state and serializes independent app instances', {
  skip: process.env.PASS_DATABASE_TEST !== 'true',
}, async t => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Development database required.');
  assert.notEqual(process.env.NODE_ENV, 'production', 'Never run this against production.');
  const root = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `pass_test_${randomBytes(8).toString('hex')}`;
  const directories = [], resources = [];
  t.after(async () => {
    for (const resource of resources) await resource.close().catch(() => {});
    await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await root.end();
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  });
  await root.query(`CREATE SCHEMA "${schema}"`);
  for (const table of ['moth_pass_issuers', 'moth_pass_burns', 'moth_pass_spent']) {
    await root.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
  }
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const connectionString = url.toString(), secret = randomBytes(32).toString('hex');
  const env = {
    NODE_ENV: 'production', PASS_STORAGE: 'postgres', PASS_STATE_DURABLE: 'false',
    DATABASE_URL: connectionString, SESSION_SECRET: secret,
    DMOTH_MINT: '9ueEeBuYUc9X1GrNCyWHbKGnHJq1kaD2nvDapDsMpump',
  };
  const rpc = async method => method === 'getGenesisHash'
    ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
    : { value: { owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', data: { parsed: { type: 'mint', info: { isInitialized: true, decimals: 6 } } } } };
  function instance(overrides = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-pg-'));
    directories.push(directory);
    const service = createPassService({ directory, rpc, env: { ...env, ...overrides } });
    resources.push(service); return service;
  }
  const first = instance(), second = instance();
  const [a, b] = await Promise.all([first.info(), second.info()]);
  assert.equal(a.enabled, true); assert.equal(a.durable, true);
  assert.equal(a.storage, 'postgres'); assert.equal(a.kid, b.kid);
  assert.equal(a.publicKey, b.publicKey);
  const one = new PostgresPassLedger({ connectionString, secret }), two = new PostgresPassLedger({ connectionString, secret });
  resources.push(one, two);
  await one.issuerKey(() => { throw Error('Existing key must be restored without a file.'); });
  await two.issuerKey(() => { throw Error('Existing key must be restored without a file.'); });
  const burn = { burn: 'test-burn', batch: 'a'.repeat(64), count: 1, kid: a.kid };
  assert.equal((await Promise.all([one.burn(burn), two.burn(burn)])).filter(Boolean).length, 1);
  assert.deepEqual(await two.getBurn(burn.burn), burn);
  const spent = { hash: 'b'.repeat(64), grant: 'c'.repeat(64), requestId: 'd'.repeat(32) };
  assert.equal((await Promise.all([one.spend(spent), two.spend(spent)])).filter(Boolean).length, 1);
  assert.deepEqual(await two.getSpend(spent.hash), spent);
  const premium = {
    hash: 'f'.repeat(64), grant: 'e'.repeat(64), requestId: 'a'.repeat(32),
    feature: 'ai-pack', binding: 'b'.repeat(64), encryptedResult: 'test-encrypted-result',
    resultExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  assert.equal(await one.spend(premium), true);
  const restoredResult = await two.getSpend(premium.hash);
  assert.equal(restoredResult.feature, 'ai-pack');
  assert.equal(restoredResult.encryptedResult, premium.encryptedResult);
  const expired = { ...premium, hash: 'e'.repeat(64), resultExpiresAt: new Date(Date.now() - 3600000).toISOString() };
  assert.equal(await one.spend(expired), true);
  const expiredResult = await two.getSpend(expired.hash);
  assert.equal(expiredResult.encryptedResult, undefined);
  assert.equal(expiredResult.grant, premium.grant, 'Expiry must not erase replay protection');
  await first.close(); await second.close();
  resources.splice(resources.indexOf(first), 1); resources.splice(resources.indexOf(second), 1);
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  const restarted = instance();
  const restored = await restarted.info();
  assert.equal(restored.enabled, true); assert.equal(restored.kid, a.kid);
  assert.equal((await one.getBurn(burn.burn)).batch, burn.batch);
  assert.equal((await one.getSpend(spent.hash)).grant, spent.grant);
  const wrongSecret = instance({ SESSION_SECRET: randomBytes(32).toString('hex') });
  assert.equal((await wrongSecret.info()).enabled, false);
  const keyRow = await root.query(`SELECT encrypted_key FROM "${schema}".moth_pass_issuers`);
  assert.equal(keyRow.rows.length, 1);
  assert.equal(keyRow.rows[0].encrypted_key.includes('"d":'), false);
});
