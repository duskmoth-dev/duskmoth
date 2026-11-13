// Offline integration test. Uses an unfunded ephemeral wallet and an in-memory
// RPC fixture; no request reaches Solana, the application, or an external API.
// Run after the browser bundle has been built.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createPassService } from '../server/lib/moth-pass.js';
import { premiumRouter } from '../server/lib/premium-router.js';
import { purchase, resumePurchase, pendingPurchase } from '../public/assets/js/pass-purchase.js';
import { requestPremium, spendSplitPass } from '../public/assets/js/pass-spend.js';
import { premiumAction } from '../public/assets/js/api.js';
import * as passes from '../public/assets/js/passes.js';

test('built browser client: burn-issued passes work across all three features, recovery and verified backups', async () => {
  const originalFetch = globalThis.fetch;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'moth-client-'));
  const storage = new Map(), owner = Keypair.generate(), mint = Keypair.generate().publicKey.toBase58();
  const tokenAccount = Keypair.generate().publicKey.toBase58();
  const address = owner.publicKey.toBase58(), program = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  let broadcasts = 0, burn, dropIssue = true, dropRedeem = true, dropAI = true, claims = 0, generated = 0;
  globalThis.window = globalThis;
  globalThis.isSecureContext = true;
  globalThis.location = { href: 'https://offline.invalid/pass', origin: 'https://offline.invalid' };
  globalThis.dispatchEvent ||= () => true;
  globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name, options, run) => run({ name }) } });
  const service = createPassService({ directory, env: { NODE_ENV: 'development', DMOTH_MINT: mint, SESSION_SECRET: randomBytes(32).toString('hex') }, rpc: async method => {
    if (method === 'getGenesisHash') return '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
    if (method === 'getAccountInfo') return { value: { owner: program, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } } };
    if (method === 'getTransaction') return burn;
    throw Error('Unexpected offline issuer RPC call.');
  } });
  const payments = [{ recipient: mint, amount: 0.03, token: 'SOL' }, { recipient: tokenAccount, amount: 0.03, token: 'SOL' }];
  const app = express();
  app.use(express.json());
  app.use('/api', premiumRouter(service, { generate: async () => { generated++; return { payments, engine: 'offline-fixture' }; } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const wallet = {
    address, provider: { publicKey: owner.publicKey },
    async signTransaction(tx) {
      // Reproduce extension behavior that changes the serialized message without
      // changing the approved burn. No network or funded wallet is used.
      tx.instructions.unshift(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }),
      );
      // Phantom's official Lighthouse assertion program is injected on mainnet.
      // AssertTokenAccount / silent / Amount / expected balance 0 / Equal.
      const assertion = Buffer.alloc(12); assertion[0] = 9; assertion[2] = 2;
      tx.add(new TransactionInstruction({
        programId: new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),
        keys: [{ pubkey: new PublicKey(tokenAccount), isSigner: false, isWritable: false }],
        data: assertion,
      }));
      tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
      tx.partialSign(owner);
      return Transaction.from(tx.serialize());
    },
    async signMessage(message) { return nacl.sign.detached(new TextEncoder().encode(message), owner.secretKey); },
  };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url), input = options.body ? JSON.parse(options.body) : {};
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (target.endsWith('/api/pass/info')) return json(await service.info());
    if (target.endsWith('/api/pass/issue')) {
      const result = await service.issue(input); claims++;
      if (dropIssue) { dropIssue = false; throw Error('Offline fixture: issuance response lost.'); }
      return json(result);
    }
    if (target.endsWith('/api/pass/redeem')) {
      assert.equal(Object.hasOwn(input, 'at'), false);
      assert.equal(Object.hasOwn(input, 'address'), false);
      let result;
      try { result = await service.redeem(input); }
      catch (error) { return json({ error: error.message }, error.status || 500); }
      if (dropRedeem) { dropRedeem = false; throw Error('Offline fixture: redemption response lost.'); }
      return json(result);
    }
    if (target === '/api/ai-pack/plan' || target === '/api/payroll/authorize') {
      // Only this ephemeral loopback fixture is reachable; never the real API.
      const response = await originalFetch(`http://127.0.0.1:${server.address().port}${target}`, options);
      if (target === '/api/ai-pack/plan' && dropAI) {
        dropAI = false; await response.text();
        throw Error('Offline fixture: paid AI response lost.');
      }
      return response;
    }
    assert.equal(target, 'https://offline.invalid/api/rpc', 'unexpected network access blocked');
    const { method, params, id } = input;
    let result;
    if (method === 'getTokenAccountsByOwner') {
      result = { context: { slot: 1 }, value: [{ pubkey: tokenAccount, account: {
        executable: false, lamports: 2039280, owner: program, rentEpoch: 0, space: 165,
        data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: { owner: address, mint, tokenAmount: { amount: '150000000000', decimals: 6, uiAmount: 150000, uiAmountString: '150000' } } } },
      } }] };
    } else if (method === 'getLatestBlockhash') {
      result = { context: { slot: 1 }, value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 10000 } };
    } else if (method === 'sendTransaction') {
      broadcasts++;
      const tx = Transaction.from(Buffer.from(params[0], 'base64'));
      assert.equal(tx.instructions.length, 4, 'preserve the wallet safety assertion and compute settings');
      assert.equal(tx.instructions.at(-1).programId.toBase58(), 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
      const instruction = tx.instructions.find(row => row.programId.toBase58() === program);
      assert.equal(tx.verifySignatures(), true);
      assert.equal(instruction.programId.toBase58(), program);
      assert.equal(instruction.keys[1].pubkey.toBase58(), mint);
      assert.equal(instruction.data[0], 15); assert.equal(instruction.data[9], 6);
      assert.equal(instruction.data.readBigUInt64LE(1), 150000000000n);
      const signature = bs58.encode(tx.signature);
      assert.equal(pendingPurchase().burnSignature, signature, 'persist signature before submitting');
      const pending = JSON.parse(storage.get('dm_pass_pending'));
      assert.equal(pending.blockhash, tx.recentBlockhash, 'persist the wallet-returned blockhash');
      assert.equal(pending.lastValidBlockHeight, undefined, 'do not use the old blockhash expiry');
      burn = { blockTime: Math.floor(Date.now() / 1000), meta: { err: null }, transaction: { message: {
        accountKeys: [{ pubkey: address, signer: true }],
        instructions: [{ programId: program, parsed: { type: 'burnChecked', info: { mint, authority: address, tokenAmount: { amount: '150000000000', decimals: 6 } } } }],
      } } };
      result = signature;
    } else if (method === 'getSignatureStatuses') {
      result = { context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] };
    } else if (method === 'getBlockHeight') result = 1;
    else throw Error(`Unexpected offline wallet RPC method: ${method}`);
    return json({ jsonrpc: '2.0', id, result });
  };
  try {
    const info = await service.info();
    assert.equal(info.enabled, true); assert.equal(info.demo, false);
    await assert.rejects(purchase({ info, wallet, count: 3 }), /server could not be reached/);
    assert.equal(broadcasts, 1); assert.equal(passes.count(info.kid), 0);
    assert.ok(pendingPurchase()?.burnSignature);
    await resumePurchase({ info, wallet });
    assert.equal(broadcasts, 1); assert.equal(claims, 2);
    assert.equal(pendingPurchase(), null); assert.equal(passes.count(info.kid), 3);
    assert.match((await spendSplitPass(info)).grant, /^[a-f0-9]{64}$/);
    assert.equal(passes.count(info.kid), 2);
    const backup = await passes.exportBlob().text();
    storage.delete('dm_passes');
    await passes.importFile(new File([backup], 'passes.json', { type: 'application/json' }));
    assert.equal(passes.count(info.kid), 2);
    const tampered = JSON.parse(backup);
    tampered.passes[0].msg = Buffer.alloc(64, 7).toString('base64');
    await assert.rejects(passes.importFile(new File([JSON.stringify(tampered)], 'invalid.json')), /could not be verified/);
    assert.equal(passes.count(info.kid), 2);
    const prompt = `Prepare 0.03 SOL to ${mint}; 0.03 SOL to ${tokenAccount}.`;
    const plan = await requestPremium(info, 'ai-pack', { prompt });
    assert.deepEqual(plan.result.payments, payments);
    assert.equal(plan.recovered, true, 'Lost AI response recovers the same paid result');
    assert.equal(generated, 1);
    assert.equal(passes.count(info.kid), 1);
    let payrollProof;
    const payroll = await requestPremium(info, 'private-payroll', { payments }, (_response, journal) => {
      payrollProof = { ...journal.pass, requestId: journal.requestId };
    });
    assert.equal(payroll.feature, 'private-payroll');
    assert.equal(passes.count(info.kid), 0);
    const recovered = await premiumAction('private-payroll', { payments, pass: payrollProof });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.grant, payroll.grant, 'Already authorized payroll does not need another pass');
    await passes.importFile(new File([backup], 'old-backup.json', { type: 'application/json' }));
    for (let remaining = 1; remaining >= 0; remaining--) {
      await assert.rejects(spendSplitPass(info), { status: 409 });
      assert.equal(passes.count(info.kid), remaining, 'Used backup credits cannot be reused on another feature');
    }
    assert.equal(broadcasts, 1, 'No extra burn for three features or recovery');
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise(resolve => server.close(resolve));
    await service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
