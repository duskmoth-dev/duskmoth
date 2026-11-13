import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Transaction, TransactionInstruction, ComputeBudgetProgram, PublicKey } from '@solana/web3.js';
import { localMagicblockInstructions, verifyMagicblockSigned, verifyMagicblockSource, createMagicblockEngine, magicblockATA } from '../../live/src/magicblock-engine.js';
import { restoreMagicblockOperation, createMagicblockPayments } from '../../public/assets/js/magicblock-payments.js';
import * as passStore from '../../public/assets/js/passes.js';
import { magicblockActionMessage, magicblockIntent, MAGICBLOCK_USDC, MAGICBLOCK_RPC } from '../../public/assets/js/magicblock-contract.js';
import { magicblockSettings } from './magicblock.js';
import { MagicblockLedger } from './magicblock-ledger.js';
import { magicblockExecutionRouter } from './magicblock-execution-router.js';
import express from 'express';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { deriveShuttleEphemeralAta, deriveShuttleWalletAta } from '@magicblock-labs/ephemeral-rollups-sdk';

const key = Keypair.generate(), owner = key.publicKey.toBase58(), to = Keypair.generate().publicKey.toBase58();
const validator = 'MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo';
const intent = magicblockIntent({ id: '1'.repeat(32), owner, kind: 'send', source: 'base',
  payments: [{ recipient: to, amount: 1, token: 'USDC' }], refs: [{ nonce: 123456, clientRefId: '152432' }] });
const record = () => ({ index: 0, status: 'pending', nonce: 123456, clientRefId: '152432' });
const settings = magicblockSettings({ ENGINE_MAGICBLOCK_ENABLED: 'true', MAGICBLOCK_EXECUTION_ENABLED: 'true', MAGICBLOCK_ALLOWLIST: owner });
const tx = async () => new Transaction({ feePayer: key.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
  .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }), ...await localMagicblockInstructions(intent, intent.payments[0], validator, 123456, '152432'));

test('SDK builds private USDC routes locally, not from opaque provider bytes', async () => {
  const ixs = (await tx()).instructions, payment = ixs.find(ix => ix.data[0] === 25);
  assert.ok(payment);
  assert.equal(payment.data.readBigUInt64LE(5), 1000000n);
  assert.equal(payment.data[13], 0, 'fees deducted from recipient, not added to owner');
  assert.ok(payment.keys.some(k => k.pubkey.toBase58() === MAGICBLOCK_USDC));
  assert.equal(payment.keys[0].pubkey.toBase58(), owner);
  const deposit = await localMagicblockInstructions({ ...intent, kind: 'deposit' }, { amount: 1, recipient: owner }, validator, 123456, '1');
  assert.ok(deposit.some(ix => ix.data[0] === 24));
  const withdraw = await localMagicblockInstructions({ ...intent, kind: 'withdraw', source: 'ephemeral' }, { amount: 1, recipient: owner }, validator, 123456, '1');
  assert.ok(withdraw.some(ix => ix.data[0] === 26));
  const privateSend = await localMagicblockInstructions({ ...intent, source: 'ephemeral' }, intent.payments[0], validator, 123456, '152432');
  assert.ok(privateSend.some(ix => ix.data[0] === 16));
});
test('wallet normalization allows safe Phantom compute changes but rejects changed amount, mint, account, data and payer', async () => {
  const original = await tx();
  const copy = () => Transaction.from(original.serialize({ requireAllSignatures: false, verifySignatures: false }));
  const good = copy(); good.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 })); good.partialSign(key);
  assert.ok(verifyMagicblockSigned(good, original, owner));
  const protectedTx = copy(); protectedTx.add(new TransactionInstruction({
    programId: new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'), keys: [{ pubkey: key.publicKey, isSigner: true, isWritable: true }],
    data: Buffer.from([2, 0, 0]),
  })); protectedTx.partialSign(key);
  assert.ok(verifyMagicblockSigned(protectedTx, original, owner));
  protectedTx.instructions.at(-1).data[0] = 0; protectedTx.partialSign(key);
  assert.throws(() => verifyMagicblockSigned(protectedTx, original, owner), /unsupported Lighthouse/);
  for (const mutation of [
    t => { t.instructions.at(-1).data[5] ^= 1; },
    t => { t.instructions.at(-1).keys.find(k => k.pubkey.toBase58() === MAGICBLOCK_USDC).pubkey = new PublicKey(to); },
    t => { t.instructions.at(-1).keys[1].pubkey = new PublicKey(to); },
    t => { t.instructions.at(-1).data[14] ^= 1; },
  ]) {
    const changed = copy(); mutation(changed); changed.partialSign(key);
    assert.throws(() => verifyMagicblockSigned(changed, original, owner), /changed|signature/);
  }
  const wrongPayer = copy(); wrongPayer.feePayer = new PublicKey(to);
  assert.throws(() => verifyMagicblockSigned(wrongPayer, original, owner), /payer/);
  assert.equal(original.signatures[0].signature, null, 'wallet copy never mutates signing reference');
});
test('recovery whitelists fields, drops private data, and never replays signed or imported confirmed rows', () => {
  const signature = bs58.encode(nacl.randomBytes(64));
  const saved = { intent, bearer: 'must-not-survive', privateBalance: 100, records: [{ ...record(), status: 'signed', signature, runtime: 'base', recipientUnits: '999000', tx: 'never' }] };
  const restored = restoreMagicblockOperation(saved);
  assert.equal(restored.records[0].status, 'uncertain');
  assert.equal(restored.bearer, undefined); assert.equal(restored.privateBalance, undefined); assert.equal(restored.records[0].tx, undefined);
  saved.records[0].status = 'confirmed'; saved.records[0].settlementSignature = signature;
  assert.equal(restoreMagicblockOperation(saved, true).records[0].status, 'uncertain');
  saved.records[0].status = 'failed'; saved.records[0].failureKind = 'preflight';
  assert.equal(restoreMagicblockOperation(saved, true).records[0].status, 'uncertain');
  assert.equal(restoreMagicblockOperation(saved, true).records[0].failureKind, undefined);
  assert.throws(() => restoreMagicblockOperation({ intent, records: [{ ...record(), status: 'confirmed' }] }));
});
test('intent rejects mixed token, extra single-send recipients and deposits to another wallet', () => {
  assert.throws(() => magicblockIntent({ ...intent, payments: [{ ...intent.payments[0], token: 'SOL' }] }));
  assert.throws(() => magicblockIntent({ ...intent, payments: [...intent.payments, ...intent.payments] }));
  assert.throws(() => magicblockIntent({ ...intent, kind: 'deposit' }));
  assert.throws(() => magicblockIntent({ ...intent, kind: 'withdraw' }));
});
test('source recovery proves payer, mint, gross amount and shuttle', async () => {
  const ixs = await localMagicblockInstructions(intent, intent.payments[0], validator, 123456, '152432');
  const source = { meta: { err: null }, transaction: { message: { accountKeys: [{ pubkey: owner }], instructions: ixs.map(ix => ({
    programId: ix.programId.toBase58(), accounts: ix.keys.map(k => k.pubkey.toBase58()), data: bs58.encode(ix.data),
  })) } } };
  assert.equal(verifyMagicblockSource(source, intent, intent.payments[0], record()), true);
  assert.equal(verifyMagicblockSource(source, intent, { ...intent.payments[0], amount: 2 }, record()), false);
  assert.equal(verifyMagicblockSource(source, { ...intent, owner: to }, intent.payments[0], record()), false);
  assert.equal(verifyMagicblockSource(source, intent, intent.payments[0], { ...record(), nonce: 1 }), false);
});
async function router(t, overrides = {}) {
  const calls = [], app = express();
  app.use(express.json());
  app.use(magicblockExecutionRouter({ settings, screen: async () => ({ allowed: true, source: 'scorechain', scope: 'sanctions-only' }),
    ledger: { health: async () => true, operation: async () => { const e = new Error(); e.code = 'RESERVATION_REQUIRED'; throw e; }, reserve: async () => { calls.push('reserve'); } },
    passes: { check: async () => { calls.push('pass-check'); } }, log: () => {}, ...overrides }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const call = async (action, plan = intent, mutate = x => x) => {
    const ts = Date.now(), signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(magicblockActionMessage(action, plan, ts)), key.secretKey));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mutate({ intent: structuredClone(plan), proof: { ts, signature } })) });
    return { status: response.status, body: await response.json() };
  };
  return { call, calls };
}
test('screening failure prevents reservation and pass access; signature binds amount', async t => {
  let reserve = 0, pass = 0;
  const api = await router(t, { screen: async () => ({ allowed: false }), ledger: { reserve: async () => { reserve++; } }, passes: { check: () => { pass++; } } });
  assert.equal((await api.call('reserve')).status, 503);
  assert.equal(reserve, 0); assert.equal(pass, 0);
  assert.equal((await api.call('screen', intent, b => { b.intent.payments[0].amount = 2; return b; })).status, 401);
});
test('single send does not touch passes; Payroll validates pass before any funds or redemption', async t => {
  const api = await router(t);
  assert.equal((await api.call('reserve')).status, 200);
  assert.deepEqual(api.calls, ['reserve']);
  assert.equal((await api.call('reserve', { ...intent, kind: 'payroll' })).status, 200);
  assert.deepEqual(api.calls, ['reserve', 'pass-check', 'reserve']);
});
test('authorization recovery returns same grant without charging another pass', async t => {
  const grant = 'a'.repeat(64);
  const api = await router(t, { ledger: { operation: async () => ({ grant }) }, passes: { redeem: () => assert.fail('No second charge') } });
  const result = await api.call('authorize', { ...intent, kind: 'payroll' });
  assert.equal(result.status, 200); assert.equal(result.body.grant, grant);
});
test('mainnet execution defaults off independently of review', () => {
  assert.equal(magicblockSettings({ ENGINE_MAGICBLOCK_ENABLED: 'true', MAGICBLOCK_ALLOWLIST: owner }).executionEnabled, false);
});
test('read-only recovery remains available when execution is disabled', async t => {
  const api = await router(t, { settings: { ...settings, enabled: false, executionEnabled: false }, ledger: { operation: async () => ({ grant: null }) },
    screen: async () => assert.fail('Recovery must not depend on a new screening request') });
  const result = await api.call('recover');
  assert.equal(result.status, 200); assert.equal(result.body.verified, true);
});
test('durable reservations serialize concurrent requests and reject changed reuse', { skip: !process.env.DATABASE_URL }, async t => {
  const ledger = new MagicblockLedger();
  t.after(async () => { if (ledger.pool && ledger.secret) await ledger.pool.query('DELETE FROM duskmoth_magicblock_operations WHERE owner_key=$1', [ledger.ownerKey(owner)]); await ledger.close(); });
  const first = { ...intent, payments: [{ ...intent.payments[0], amount: 1 }] };
  const results = await Promise.allSettled([1, 2, 3].map(i => ledger.reserve({ ...first, id: String(i).repeat(32) }, 2)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  const successful = results.findIndex(r => r.status === 'fulfilled') + 1;
  assert.equal((await ledger.reserve({ ...first, id: String(successful).repeat(32) }, 2)).recovered, true);
  await assert.rejects(ledger.reserve({ ...first, id: String(successful).repeat(32), payments: [{ ...intent.payments[0], amount: 0.5 }] }, 2), /different plan/);
});
test('settlement requires a real program-scoped reference AND exact USDC credit, not just source acceptance', async () => {
  const signature = bs58.encode(nacl.randomBytes(64)), r = { ...record(), recipientUnits: '999000' };
  let spoof = true;
  const engine = createMagicblockEngine({ wallet: { address: owner, provider: { publicKey: { toString: () => owner } } }, rpcUrl: 'https://example.invalid/api/rpc',
    fetchImpl: async (url, options) => {
      assert.notEqual(url, MAGICBLOCK_RPC, 'public payout evidence needs no private balance');
      const q = JSON.parse(options.body);
      return new Response(JSON.stringify({ result: q.method === 'getSignaturesForAddress' ? [{ signature }] : {
        transaction: { message: { accountKeys: [magicblockATA(to)] } }, meta: { err: null,
          logMessages: [`Program ${spoof ? owner : 'SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2'} invoke [1]`, `Program log: client_ref_id: ${r.clientRefId}`],
          preTokenBalances: [], postTokenBalances: [{ accountIndex: 0, mint: MAGICBLOCK_USDC, owner: to, uiTokenAmount: { amount: '999000' } }] },
      } }), { headers: { 'Content-Type': 'application/json' } });
    } });
  assert.equal((await engine.settlement(intent, intent.payments[0], r)).status, 'source-confirmed');
  spoof = false;
  assert.equal((await engine.settlement(intent, intent.payments[0], r)).settlementSignature, signature);
});
test('withdrawal callback 201 requires exact shuttle, owner, mint and token credit', async () => {
  const signature = bs58.encode(nacl.randomBytes(64)), r = { ...record(), recipientUnits: '1000000' };
  const plan = magicblockIntent({ ...intent, kind: 'withdraw', source: 'ephemeral', payments: [{ recipient: owner, amount: 1, token: 'USDC' }] });
  const destination = magicblockATA(owner), shuttle = deriveShuttleEphemeralAta(key.publicKey, new PublicKey(MAGICBLOCK_USDC), r.nonce)[0];
  const shuttleWallet = deriveShuttleWalletAta(new PublicKey(MAGICBLOCK_USDC), shuttle);
  let wrong = false;
  const engine = createMagicblockEngine({ wallet: { address: owner, provider: { publicKey: key.publicKey } }, rpcUrl: 'https://test.invalid',
    fetchImpl: async (_url, options) => {
      const q = JSON.parse(options.body), accounts = Array(12).fill(owner);
      accounts[1] = wrong ? to : shuttle.toBase58(); accounts[3] = shuttleWallet.toBase58(); accounts[4] = destination; accounts[5] = MAGICBLOCK_USDC;
      if (q.method === 'getSignaturesForAddress') assert.equal(q.params[1].commitment, 'confirmed');
      return new Response(JSON.stringify({ result: q.method === 'getSignaturesForAddress' ? [{ signature }] : {
        transaction: { message: { accountKeys: [destination], instructions: [{ programId: 'SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2', data: bs58.encode(Buffer.from([201])), accounts }] } },
        meta: { err: null, preTokenBalances: [], postTokenBalances: [{ accountIndex: 0, mint: MAGICBLOCK_USDC, owner, uiTokenAmount: { amount: '1000000' } }] },
      } }));
    } });
  assert.equal((await engine.settlement(plan, plan.payments[0], r)).status, 'confirmed');
  wrong = true; assert.equal((await engine.settlement(plan, plan.payments[0], r)).status, 'source-confirmed');
});
test('Payroll controller recovers the original held pass after uncertain funding; no replay, no replacement credit', async t => {
  const originals = Object.fromEntries(['localStorage', 'fetch', 'location', 'confirm', 'dispatchEvent', 'navigator'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  t.after(() => { for (const [k, d] of Object.entries(originals)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } });
  const storage = new Map();
  Object.defineProperties(globalThis, {
    localStorage: { configurable: true, value: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) } },
    location: { configurable: true, value: { origin: 'https://test.invalid' } },
    confirm: { configurable: true, value: () => true },
    dispatchEvent: { configurable: true, value: () => {} },
    navigator: { configurable: true, value: { locks: { request: async (_name, _opts, fn) => fn({}) } } },
  });
  const kid = 'a'.repeat(16), pass = { kid, msg: Buffer.alloc(32, 1).toString('base64'), sig: Buffer.alloc(256, 2).toString('base64'), demo: false };
  passStore.add([pass, { ...pass, msg: Buffer.alloc(32, 3).toString('base64') }]);
  let sends = 0, grantCalls = 0, cleared = 0;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null; requests.push([String(url), body]);
    let result = { enabled: true, maxBatchUSDC: 500, maxDailyUSDC: 2000, kid, demo: false };
    if (String(url).endsWith('/recover')) result = { verified: true, authorized: false };
    if (String(url).endsWith('/authorize')) { grantCalls++; assert.equal(body.pass.msg, pass.msg); result = { ok: true, grant: 'a'.repeat(64) }; }
    return new Response(JSON.stringify(result));
  };
  const wallet = { address: owner, provider: { publicKey: key.publicKey }, signMessage: async msg => nacl.sign.detached(new TextEncoder().encode(msg), key.secretKey) };
  const sourceSignature = bs58.encode(nacl.randomBytes(64));
  const fake = {
    balance: async () => ({ units: '10000000', source: 'base' }),
    rpc: async () => ({ value: 10000000 }), clear: () => { cleared++; },
    quote: async () => ({ runtime: 'base', recipientUnits: '999000', reviewedAt: new Date().toISOString(),
      fees: { tokenUnits: '1000', totalLamports: '10000' } }),
    signAndSend: async (_q, r, save) => { sends++; Object.assign(r, { status: 'uncertain', signature: sourceSignature, runtime: 'base', recipientUnits: '999000' }); save(); throw Error('Simulated network timeout'); },
    status: async () => ({ status: 'source-confirmed' }),
    settlement: async () => ({ status: 'confirmed', settlementSignature: sourceSignature, settlementRuntime: 'base' }),
  };
  const make = () => createMagicblockPayments({ getWallet: () => wallet, loadEngine: async () => ({ createMagicblockEngine: () => fake }) });
  const c = await make(); await c.refresh(); c.prepare({ kind: 'payroll', source: 'base', payments: intent.payments });
  assert.equal(await c.review(), true); assert.equal(await c.execute(), false);
  assert.equal(sends, 1); assert.equal(grantCalls, 0); assert.equal(passStore.count(kid), 1);
  const recovered = await make(); await recovered.refresh();
  assert.equal(await recovered.review(), false, 'uncertain source cannot be retried');
  assert.equal(sends, 1);
  await recovered.check();
  assert.equal(grantCalls, 1); assert.equal(passStore.count(kid), 1);
  assert.equal(recovered.state.operation.records[0].status, 'confirmed');
  assert.equal(storage.has('dm_magicblock_pass_v1'), false);
  assert.ok(!recovered.backup().includes(pass.msg), 'payment backups never expose Moth Pass proofs');
  assert.ok(requests.some(([u, b]) => u.endsWith('/reserve') && b.pass.msg === pass.msg));
  await recovered.check(); assert.equal(grantCalls, 1); assert.equal(sends, 1);
  await recovered.clear(); assert.equal(recovered.state.operation, null);
});
