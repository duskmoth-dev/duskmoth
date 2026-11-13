import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { createPremiumTools } from '../../public/assets/js/premium-tools.js';
import { magicblockReviewMessage } from '../../public/assets/js/magicblock-contract.js';

test('internal MagicBlock review signs only its bound message, keeps fees in memory and does not alter the Payroll journal or passes', async t => {
  const key = Keypair.generate(), owner = key.publicKey.toBase58(), recipient = Keypair.generate().publicKey.toBase58();
  const original = { window: globalThis.window, fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  const store = new Map(), calls = [];
  const batch = { id: 'a'.repeat(32), owner, payments: [{ recipient, amount: 1, token: 'USDC' }],
    records: [{ index: 0, status: 'pending' }], busy: false, status: 'needs-review' };
  store.set('dm_payroll_v1', JSON.stringify(batch));
  let signedMessages = 0, rejectMessage = false;
  const provider = { isPhantom: true, isConnected: true, publicKey: { toString: () => owner },
    connect: async () => ({ publicKey: provider.publicKey }), disconnect: async () => {},
    signTransaction: () => assert.fail('No transaction signing during review'),
    signMessage: async bytes => {
      signedMessages++;
      if (rejectMessage) throw new Error('Wallet rejected the message.');
      return { signature: nacl.sign.detached(bytes, key.secretKey) };
    } };
  globalThis.window = { phantom: { solana: provider }, addEventListener() {} };
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    let body;
    if (url === '/api/config') body = { liveSend: true, limits: { SOL: 5, USDC: 500 } };
    else if (url === '/api/pass/info') body = { enabled: true, kid: 'b'.repeat(16) };
    else if (url.startsWith('/api/engines/magicblock/info')) body = { reviewEnabled: true, executionEnabled: false, maxBatchUSDC: 500 };
    else if (url === '/api/engines/magicblock/review') {
      const request = JSON.parse(options.body);
      assert.deepEqual(request.payments, batch.payments);
      assert.equal(request.owner, owner);
      assert.ok(nacl.sign.detached.verify(new TextEncoder().encode(magicblockReviewMessage(owner, request.proof.ts, request.payments)),
        bs58.decode(request.proof.signature), key.publicKey.toBytes()));
      body = { mode: 'unsigned-review-only', operationTokenUnits: '1000', operationLamports: '0',
        networkLamports: null, accountRentLamports: null, totalCostVerified: false,
        approvalReady: false, transactionSubmitted: false, passSpent: false, depositMade: false,
        checkedAt: new Date().toISOString() };
    } else assert.fail(`Unexpected request ${url}`);
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.window = original.window; globalThis.fetch = original.fetch; globalThis.localStorage = original.localStorage; });
  const ctl = await createPremiumTools();
  await ctl.connect('phantom'); await ctl.loadMagicblockInfo();
  const before = store.get('dm_payroll_v1');
  await ctl.reviewMagicblock();
  assert.equal(signedMessages, 1);
  assert.equal(ctl.state.magicblock.result.operationTokenUnits, '1000');
  assert.equal(ctl.state.magicblock.busy, false);
  assert.equal(store.get('dm_payroll_v1'), before);
  assert.equal(store.get('dm_passes'), undefined);
  assert.ok(calls.every(url => !/payroll\/authorize|transaction\/send|relayer\/|\/rpc/.test(url)));
  rejectMessage = true;
  const beforeRejected = calls.filter(url => url.endsWith('/review')).length;
  assert.equal(await ctl.reviewMagicblock(), false);
  assert.match(ctl.state.magicblock.error, /rejected/);
  assert.equal(ctl.state.magicblock.busy, false);
  assert.equal(calls.filter(url => url.endsWith('/review')).length, beforeRejected);
  ctl.state.payroll.records[0].status = 'uncertain';
  await assert.rejects(ctl.reviewMagicblock(), /fresh, unsent batch/);
  assert.equal(signedMessages, 2, 'Uncertain batch never requests another message');
});
