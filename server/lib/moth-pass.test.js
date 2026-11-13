import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import express from 'express';
import { createPassService, burnedUnits, decimalUnits, burnClaimMessage, suite, TOKEN_PROGRAMS } from './moth-pass.js';
import { passRouter } from './pass-router.js';
import { importPublicKey, blindPasses, finalizePasses, verifyPass } from '../../live/src/moth-pass.js';

const hash = async value => Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(value))).toString('hex');
const mint = bs58.encode(randomBytes(32));
const program = [...TOKEN_PROGRAMS][0];
const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
async function fixture(t, env = {}, rpc = async () => null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'moth-pass-'));
  const service = createPassService({ directory, rpc, env: { NODE_ENV: 'development', ALLOW_DEMO_PASSES: 'true', ...env } });
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await service.info(); return { service, directory };
}
async function batch(service, n) {
  const info = await service.info(), pk = await importPublicKey(info.publicKey);
  return { ...await blindPasses(pk, n), pk, info };
}
test('RFC 9474 browser/server round trip, demo cap, invalid pair and one-time redemption', async t => {
  const { service } = await fixture(t), { items, blinded, pk, info } = await batch(service, 5);
  assert.equal(info.demo, true); assert.equal(info.enabled, true);
  assert.match(info.kid, /^[a-f0-9]{16}$/);
  const issued = await service.issue({ demo: true, blinded });
  assert.equal(issued.count, 3);
  const passes = await finalizePasses(pk, items, issued.signatures, issued.kid, true);
  assert.equal(passes.length, 3);
  for (const pass of passes) assert.equal(await verifyPass(pk, pass), true);
  await assert.rejects(service.redeem({ ...passes[0], sig: passes[1].sig, feature: 'split-withdraw' }), error => error.status === 400);
  const redeemed = await service.redeem({ ...passes[0], feature: 'split-withdraw' });
  assert.equal(redeemed.ok, true);
  await assert.rejects(service.redeem({ ...passes[0], feature: 'split-withdraw' }), error => error.status === 409);
  await assert.rejects(service.redeem({ ...passes[1], kid: '0000000000000000', feature: 'split-withdraw' }), error => error.status === 400);
  await assert.rejects(service.redeem({ ...passes[1], feature: 'other' }), error => error.status === 400);
});
test('HTTP pass API uses public keys and JSON status codes without caching', async t => {
  const { service } = await fixture(t), app = express();
  app.use(express.json({ limit: '64kb' })); app.use('/api/pass', passRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const infoResponse = await fetch(origin + '/api/pass/info'), info = await infoResponse.json();
  assert.equal(infoResponse.status, 200); assert.equal(infoResponse.headers.get('cache-control'), 'no-store');
  assert.equal(JSON.stringify(info).includes('privateKey'), false);
  const pk = await importPublicKey(info.publicKey), request = await blindPasses(pk, 2);
  const issue = await fetch(origin + '/api/pass/issue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ demo: true, blinded: request.blinded }) });
  assert.equal(issue.status, 200);
  const result = await issue.json(), passes = await finalizePasses(pk, request.items, result.signatures, result.kid, true);
  const body = JSON.stringify({ ...passes[0], feature: 'split-withdraw' });
  const redeem = () => fetch(origin + '/api/pass/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal((await redeem()).status, 200); assert.equal((await redeem()).status, 409);
});
test('production cannot issue demo passes and requires durable state even with a mint', async t => {
  const { service } = await fixture(t, { NODE_ENV: 'production', ALLOW_DEMO_PASSES: 'true' });
  const info = await service.info();
  assert.equal(info.enabled, false); assert.equal(info.demo, false);
  await assert.rejects(service.issue({ demo: true, blinded: [] }), error => error.status === 503);
  await assert.rejects(service.issue({ burnSignature: 'invalid', blinded: [] }), error => error.status === 503);
  const { service: missingMint } = await fixture(t, { NODE_ENV: 'production', PASS_STATE_DURABLE: 'true' });
  assert.match((await missingMint.info()).reason, /mint/);
});
test('burn parsing uses exact integers, both instruction levels, the official programs, and mint/authority filtering', () => {
  const instruction = (type, value, accountMint = mint, programId = program) => ({
    programId, parsed: { type, info: { mint: accountMint, authority: 'authority', tokenAmount: { uiAmountString: value, decimals: 6 } } },
  });
  const tx = { meta: { err: null, innerInstructions: [{ instructions: [instruction('burnChecked', '50000')] }] }, transaction: { message: { instructions: [instruction('burnChecked', '100000')] } } };
  assert.equal(burnedUnits(tx, mint, 6) / 1000000n, 150000n);
  assert.equal(burnedUnits({ ...tx, meta: { err: 'failure' } }, mint, 6), 0n);
  assert.equal(burnedUnits(tx, 'another-mint', 6), 0n);
  assert.equal(burnedUnits(tx, mint, 6, 'another-authority'), 0n);
  assert.equal(burnedUnits({ ...tx, transaction: { message: { instructions: [instruction('burn', '50000', mint, 'not-the-token-program')] } }, meta: { err: null } }, mint, 6), 0n);
  assert.equal(decimalUnits('50000.000001', 6), 50000000001n);
  assert.throws(() => decimalUnits('1.0000001', 6));
  assert.ok(TOKEN_PROGRAMS.has('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'));
});
test('official DMOTH Token-2022 identity is verified even while production purchases are blocked', async t => {
  const official = '9ueEeBuYUc9X1GrNCyWHbKGnHJq1kaD2nvDapDsMpump';
  const token2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  let initialized = true, network = genesis;
  const rpc = async (method, params) => {
    if (method === 'getGenesisHash') return network;
    assert.equal(method, 'getAccountInfo');
    assert.equal(params[0], official);
    return { value: { owner: token2022, data: { parsed: { type: 'mint', info: {
      decimals: 6, isInitialized: initialized,
      extensions: [{ extension: 'tokenMetadata', state: { name: 'Duskmoth', symbol: 'DMOTH' } }],
    } } } } };
  };
  const { service } = await fixture(t, {
    NODE_ENV: 'production', DMOTH_MINT: official, PASS_STATE_DURABLE: 'false',
  }, rpc);
  const info = await service.info();
  assert.equal(info.enabled, false);
  assert.equal(info.demo, false);
  assert.equal(info.mint, official);
  assert.match(info.reason, /durable/);
  assert.deepEqual(info.token, {
    verified: true, network: 'solana-mainnet', program: token2022,
    decimals: 6, name: 'Duskmoth', symbol: 'DMOTH', priceRaw: '50000000000',
  });
  await assert.rejects(service.issue({ demo: true, blinded: [] }), error => error.status === 503);
  initialized = false;
  const { service: invalid } = await fixture(t, {
    NODE_ENV: 'production', DMOTH_MINT: official, PASS_STATE_DURABLE: 'true',
  }, rpc);
  assert.equal((await invalid.info()).enabled, false);
  assert.equal((await invalid.info()).token, null);
  network = 'devnet';
  const { service: wrongNetwork } = await fixture(t, {
    NODE_ENV: 'production', DMOTH_MINT: official, PASS_STATE_DURABLE: 'true',
  }, rpc);
  assert.equal((await wrongNetwork.info()).enabled, false);
  assert.equal((await wrongNetwork.info()).token, null);
});
test('a public burn cannot be stolen; exact retries recover credits; different batches cannot reuse it', async t => {
  const owner = nacl.sign.keyPair(), address = bs58.encode(owner.publicKey), burn = bs58.encode(randomBytes(64));
  const tx = {
    blockTime: Math.floor(Date.now() / 1000),
    meta: { err: null, innerInstructions: [] },
    transaction: { message: { accountKeys: [{ pubkey: address, signer: true }], instructions: [
      { programId: program, parsed: { type: 'burnChecked', info: { mint, authority: address, tokenAmount: { amount: '150000000000', decimals: 6 } } } },
    ] } },
  };
  const rpc = async (method) => {
    if (method === 'getGenesisHash') return genesis;
    if (method === 'getAccountInfo') return { value: { owner: program, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } } };
    if (method === 'getTransaction') return tx;
  };
  const { service, directory } = await fixture(t, { DMOTH_MINT: mint }, rpc);
  const { info, blinded, items, pk } = await batch(service, 3), ts = Date.now(), fingerprint = await hash(JSON.stringify(blinded));
  const proof = { address, ts, signature: bs58.encode(nacl.sign.detached(Buffer.from(burnClaimMessage(burn, fingerprint, ts)), owner.secretKey)) };
  await assert.rejects(service.issue({ burnSignature: burn, blinded }), error => error.status === 403);
  const issued = await service.issue({ burnSignature: burn, blinded, proof });
  assert.equal(issued.count, 3);
  const recovered = await service.issue({ burnSignature: burn, blinded, proof });
  assert.equal(recovered.recovered, true); assert.deepEqual(recovered.signatures, issued.signatures);
  const other = await blindPasses(pk, 1);
  await assert.rejects(service.issue({ burnSignature: burn, blinded: other.blinded, proof }), error => error.status === 409);
  const passes = await finalizePasses(pk, items, issued.signatures, info.kid, false);
  const request = { ...passes[0], requestId: 'a'.repeat(32), feature: 'split-withdraw' };
  const redeemed = await service.redeem(request);
  assert.equal((await service.redeem(request)).grant, redeemed.grant);
  await service.close();
  const restarted = createPassService({ directory, rpc, env: { NODE_ENV: 'development', DMOTH_MINT: mint } });
  t.after(() => restarted.close());
  assert.equal((await restarted.info()).kid, info.kid);
  await assert.rejects(restarted.redeem({ ...passes[0], feature: 'split-withdraw' }), error => error.status === 409);
  const contents = fs.readFileSync(path.join(directory, 'pass-burns'), 'utf8') + fs.readFileSync(path.join(directory, 'pass-spent'), 'utf8');
  for (const secret of [address, passes[0].msg, passes[0].sig]) assert.equal(contents.includes(secret), false);
});
test('simultaneous redemption cannot spend one pass twice', async t => {
  const { service } = await fixture(t), batchData = await batch(service, 1);
  const result = await service.issue({ demo: true, blinded: batchData.blinded });
  const [pass] = await finalizePasses(batchData.pk, batchData.items, result.signatures, result.kid, true);
  const outcomes = await Promise.allSettled([service.redeem({ ...pass, feature: 'split-withdraw' }), service.redeem({ ...pass, feature: 'split-withdraw' })]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.status, 409);
});
