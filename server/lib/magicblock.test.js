import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Keypair, Transaction, SystemProgram } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { MAGICBLOCK_USDC, MAGICBLOCK_ORIGIN, magicblockPayload, magicblockReviewMessage } from '../../public/assets/js/magicblock-contract.js';
import { magicblockSettings, magicblockInfo, selectPrivacyEngine, createMagicblockAdapter, inspectUnsignedMagicblock, validateMagicblockPayments } from './magicblock.js';
import { magicblockRouter } from './magicblock-router.js';

const wallet = Keypair.generate(), owner = wallet.publicKey.toBase58();
const recipients = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
const payments = recipients.map(recipient => ({ recipient, amount: 1, token: 'USDC' }));
const env = { ENGINE_MAGICBLOCK_ENABLED: 'true', MAGICBLOCK_ALLOWLIST: owner };
function unsigned() {
  // A structural fixture only, deliberately NOT a valid MagicBlock instruction.
  // Passing structural inspection must never make this transaction signable.
  const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  return { kind: 'transfer', version: 'legacy', sendTo: 'base', recentBlockhash: tx.recentBlockhash,
    lastValidBlockHeight: 12345, instructionCount: 1, requiredSigners: [owner],
    transactionBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    fees: { lamports: '0', tokens: '1000' } };
}
function signed(rows = payments, address = owner) {
  rows = structuredClone(rows);
  const ts = Date.now();
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(magicblockReviewMessage(address, ts, rows)), wallet.secretKey));
  return { owner: address, payments: rows, proof: { ts, signature } };
}
async function fixture(t, overrides = {}) {
  const calls = [], logs = [];
  const app = express(); app.use(express.json());
  app.use(magicblockRouter({ settings: magicblockSettings(env),
    adapter: {
      health: async () => { calls.push('health'); return { status: 'ok' }; },
      reviewTransfer: async () => { calls.push('build'); return inspectUnsignedMagicblock(unsigned(), owner); },
    },
    screen: async () => { calls.push('screen'); return { allowed: true, source: 'scorechain', scope: 'sanctions-only' }; },
    log: row => logs.push(row), ...overrides }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { calls, logs,
    info: owner => fetch(`${base}/info${owner ? `?owner=${owner}` : ''}`),
    review: body => fetch(`${base}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  };
}

test('MagicBlock defaults off; configuration cannot silently select public ER, arbitrary URLs or another mint', () => {
  assert.equal(magicblockSettings({}).enabled, false);
  for (const change of [
    { MAGICBLOCK_API_BASE: 'https://attacker.invalid' }, { MAGICBLOCK_CLUSTER: 'mainnet' },
    { USDC_MINT: recipients[0] }, { MAGICBLOCK_ALLOWLIST: '' }, { MAGICBLOCK_ALLOWLIST: 'bad' },
    { MAGICBLOCK_MAX_BATCH_USDC: 'NaN' }, { MAGICBLOCK_MAX_DAILY_USDC: 'Infinity' },
    { MAGICBLOCK_MAX_BATCH_USDC: '501' }, { MAGICBLOCK_TIMEOUT_MS: '999999999' },
  ]) assert.equal(magicblockSettings({ ...env, ...change }).enabled, false);
  const settings = magicblockSettings(env);
  assert.equal(settings.enabled, true);
  assert.equal(magicblockInfo(settings).executionEnabled, false);
  assert.equal(magicblockInfo(settings).dailyLimitEnforced, false);
});

test('engine selection is explicit, preserves Privacy Cash and never reroutes an unsupported or unallowlisted payment', () => {
  const settings = magicblockSettings(env);
  assert.equal(selectPrivacyEngine({ requested: 'privacycash', asset: 'USDC', owner }, settings), 'privacycash');
  assert.equal(selectPrivacyEngine({ requested: 'privacycash', asset: 'SOL', owner }, settings), 'privacycash');
  assert.equal(selectPrivacyEngine({ requested: 'magicblock', asset: 'USDC', owner }, settings), 'magicblock');
  assert.throws(() => selectPrivacyEngine({ requested: 'magicblock', asset: 'SOL', owner }, settings));
  assert.throws(() => selectPrivacyEngine({ requested: 'magicblock', asset: 'USDC', owner: recipients[0] }, settings));
  assert.throws(() => selectPrivacyEngine({ requested: 'magicblock', asset: 'USDC', owner }, magicblockSettings({})));
});

test('request contracts fix real API field names, private visibility, units and no platform fee', () => {
  const body = magicblockPayload('transfer', owner, 1000000, recipients[0]);
  assert.equal(body.cluster, 'mainnet-private');
  assert.equal(body.mint, MAGICBLOCK_USDC);
  assert.equal(body.visibility, 'private');
  assert.equal(body.fromBalance, 'base');
  assert.equal(body.toBalance, 'base');
  assert.equal(body.platformFeeBps, 0);
  assert.equal(body.gasless, false);
  assert.equal(body.legacy, true);
  assert.equal(magicblockPayload('deposit', owner, 1).private, true);
  assert.throws(() => magicblockPayload('transfer', owner, 0.5, recipients[0]));
  assert.throws(() => magicblockPayload('send', owner, 1, recipients[0]));
  assert.throws(() => validateMagicblockPayments([{ ...payments[0], token: 'SOL' }], magicblockSettings(env)));
  assert.throws(() => validateMagicblockPayments([{ ...payments[0], amount: 501 }], magicblockSettings(env)));
});

test('structural inspection does not authorize signing or expose unsigned transaction bytes', () => {
  const result = inspectUnsignedMagicblock(unsigned(), owner);
  assert.equal(result.approvalReady, false);
  assert.equal(result.instructionVerification, 'not-complete');
  assert.ok(!('transactionBase64' in result));
  for (const change of [
    { fees: { lamports: '0', tokens: '-1' } }, { version: 'v0' }, { sendTo: 'ephemeral' },
    { requiredSigners: [recipients[0]] }, { recentBlockhash: recipients[0] }, { transactionBase64: 'invalid' },
  ]) assert.throws(() => inspectUnsignedMagicblock({ ...unsigned(), ...change }, owner));
  assert.throws(() => inspectUnsignedMagicblock(unsigned(), recipients[0]));
});

test('upstream adapter uses only official origin and verified paths, without authorization tokens or sends', async () => {
  const calls = [], settings = magicblockSettings(env);
  const adapter = createMagicblockAdapter({ settings, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/health') ? { status: 'ok' } : unsigned()));
  } });
  assert.deepEqual(await adapter.health(), { status: 'ok' });
  assert.equal((await adapter.reviewTransfer(owner, payments[0])).approvalReady, false);
  assert.equal(calls[0].url, `${MAGICBLOCK_ORIGIN}/health`);
  assert.equal(calls[1].url, `${MAGICBLOCK_ORIGIN}/v1/spl/transfer`);
  assert.equal(JSON.parse(calls[1].options.body).visibility, 'private');
  assert.ok(calls.every(call => !call.options.headers.Authorization));
  assert.ok(!('send' in adapter));
});

test('provider failures stay explicit and never return zero fees or expose response content', async () => {
  for (const response of [
    () => new Response('secret-in-upstream-body', { status: 503 }),
    () => new Response('not-json'), () => new Response(JSON.stringify({ error: 'sensitive' })),
  ]) {
    const adapter = createMagicblockAdapter({ settings: magicblockSettings(env), fetchImpl: async () => response() });
    await assert.rejects(adapter.reviewTransfer(owner, payments[0]), error => {
      assert.doesNotMatch(error.message, /secret|sensitive|not-json/); return true;
    });
  }
  const adapter = createMagicblockAdapter({ settings: magicblockSettings(env), fetchImpl: async () => {
    const body = unsigned(); body.fees.tokens = '1000000';
    return new Response(JSON.stringify(body));
  } });
  await assert.rejects(adapter.reviewTransfer(owner, payments[0]), /positive recipient amount/);
});

test('disabled review makes no upstream call and does not expose the beta allowlist', async t => {
  const f = await fixture(t, { settings: magicblockSettings({}) });
  const info = await (await f.info()).json();
  assert.equal(info.reviewEnabled, false);
  assert.ok(!JSON.stringify(info).includes(owner));
  assert.equal((await f.review(signed())).status, 503);
  assert.deepEqual(f.calls, []);
});
test('internal review is visible only to an allowlisted wallet; execution stays off for everyone', async t => {
  const f = await fixture(t);
  assert.equal((await (await f.info()).json()).reviewEnabled, false);
  assert.equal((await (await f.info(recipients[0])).json()).reviewEnabled, false);
  const allowed = await (await f.info(owner)).json();
  assert.equal(allowed.reviewEnabled, true);
  assert.equal(allowed.executionEnabled, false);
});

test('owner proof binds exact canonical recipients, amounts and timestamp before screening or building', async t => {
  const f = await fixture(t);
  const body = signed(); body.payments[0].amount = 2;
  assert.equal((await f.review(body)).status, 401);
  const expired = signed(); expired.proof.ts -= 200000;
  assert.equal((await f.review(expired)).status, 401);
  assert.deepEqual(f.calls, []);
});

test('all screening finishes before any unsigned transaction; an unavailable second recipient stops the entire review', async t => {
  let checks = 0;
  const f = await fixture(t, { screen: async () => ({ allowed: ++checks === 1, source: 'scorechain', scope: 'sanctions-only' }) });
  const response = await f.review(signed());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'SCREENING_INCOMPLETE');
  assert.equal(checks, 2);
  assert.deepEqual(f.calls, [], 'No health, builder, deposit, pass or send');
});

test('successful review returns provider operation fees but explicitly withholds full-cost and execution approval', async t => {
  const f = await fixture(t);
  const response = await f.review(signed());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls, ['screen', 'screen', 'health', 'build', 'build']);
  assert.equal(result.operationTokenUnits, '2000');
  assert.equal(result.networkLamports, null);
  assert.equal(result.accountRentLamports, null);
  assert.equal(result.totalCostVerified, false);
  assert.equal(result.approvalReady, false);
  assert.equal(result.transactionSubmitted, false);
  assert.equal(result.depositMade, false);
  assert.equal(result.passSpent, false);
  assert.ok(!JSON.stringify(result).includes('transactionBase64'));
  const logs = JSON.stringify(f.logs);
  for (const value of [owner, ...recipients, signed().proof.signature]) assert.ok(!logs.includes(value));
});
