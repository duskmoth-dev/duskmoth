// User-authorized, resumable mainnet check. No secrets are written or printed.
// Default is read-only. --execute permits exactly 100,000 DMOTH and a bounded
// SOL test using only this wallet and a recoverable, purpose-derived recipient.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Keypair, SystemProgram, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const origin = 'http://localhost';
const dir = path.resolve(import.meta.dirname, '../data/mainnet-premium-test');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.chmodSync(dir, 0o700);
const lockPath = path.join(dir, 'run.lock');
const lock = fs.openSync(lockPath, 'wx', 0o600); fs.closeSync(lock);
process.once('exit', () => { try { fs.unlinkSync(lockPath); } catch {} });
const file = path.join(dir, 'private-recovery.json');
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { storage: {}, receipts: {}, stage: 'start' };
function save() {
  const temp = file + '.tmp';
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
const event = (phase, details = {}) => process.stdout.write(JSON.stringify({ phase, utc: new Date().toISOString(), ...details }) + '\n');
// The SDK must not add commitment/note payloads to a headless test's output.
console.log = console.debug = console.info = () => {};
const execute = process.argv.includes('--execute');
const originalFetch = globalThis.fetch;
globalThis.window = globalThis;
globalThis.location = { origin, href: origin + '/tools' };
globalThis.isSecureContext = true;
globalThis.__DM_RELAYER__ = origin + '/api/relayer';
globalThis.dispatchEvent ||= () => true;
globalThis.addEventListener ||= () => {};
globalThis.localStorage = {
  getItem: key => state.storage[key] ?? null,
  setItem(key, value) { state.storage[key] = String(value); save(); },
  removeItem(key) {
    if (key === 'dm_pass_pending' && state.storage[key]) {
      state.receipts.burn ||= JSON.parse(state.storage[key]).burnSignature;
    }
    delete state.storage[key]; save();
  },
};
Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name, _options, callback) => callback({ name }) } });
globalThis.fetch = (input, options = {}) => {
  const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin);
  if (target.protocol !== 'data:') assert.equal(target.origin, origin, 'Unexpected SDK network destination refused.');
  return originalFetch(target, options);
};
async function rpc(method, params = []) {
  const response = await originalFetch(origin + '/api/rpc', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  assert.ok(response.ok && !body.error, `Application RPC failed for ${method}`);
  return body.result;
}
async function txReceipt(signature) {
  for (let n = 0; n < 20; n++) {
    const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
    if (tx) { assert.equal(tx.meta.err, null); return tx; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Receipt not indexed yet; preserve the existing signature, never resend.');
}
let owner, recipient, bytes, phase = 'preflight';
try {
  const encoded = process.env.TEST_WALLET_PRIVATE_KEY?.trim();
  assert.ok(encoded, 'Missing test-wallet Secret');
  bytes = encoded.startsWith('[') ? Uint8Array.from(JSON.parse(encoded)) : bs58.decode(encoded);
  owner = bytes.length === 64 ? Keypair.fromSecretKey(bytes) : Keypair.fromSeed(bytes);
  const seed = createHash('sha256').update('duskmoth:payroll-mainnet-test:v1').update(owner.secretKey).digest();
  recipient = Keypair.fromSeed(seed); seed.fill(0);
  const address = owner.publicKey.toBase58();
  if (state.owner) assert.equal(state.owner, address, 'Test wallet changed; preserve original recovery state.');
  state.owner = address; save();
  const api = await import('../public/assets/js/api.js');
  const { purchase, resumePurchase, pendingPurchase } = await import('../public/assets/js/pass-purchase.js');
  const passes = await import('../public/assets/js/passes.js');
  const { requestPremium, pendingPremium } = await import('../public/assets/js/pass-spend.js');
  const { quotePayroll, runPayroll } = await import('../public/assets/js/payroll.js');
  const { receiptMatches } = await import('../public/assets/js/payroll-receipt.js');
  const info = await api.passInfo(), config = await api.config();
  assert.ok(info.enabled && info.durable && !info.demo && info.token.verified);
  assert.equal(info.price, 50000);
  assert.ok(info.features['ai-pack']?.enabled && info.features['private-payroll']?.enabled);
  // pass/info verifies the actual mainnet genesis and mint server-side.
  // The public RPC proxy intentionally does not expose getGenesisHash.
  assert.equal(config.network, 'mainnet-beta');
  if (state.kid) assert.equal(state.kid, info.kid, 'Issuer changed; do not burn again.');
  state.kid = info.kid;
  const initial = (await rpc('getBalance', [address, { commitment: 'confirmed' }])).value;
  state.initialLamports ??= initial;
  const tokenAccounts = await rpc('getTokenAccountsByOwner', [address, { mint: info.mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const tokenRaw = tokenAccounts.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  const payments = [{ recipient: address, amount: 0.02, token: 'SOL' }, { recipient: recipient.publicKey.toBase58(), amount: 0.02, token: 'SOL' }];
  const quotes = quotePayroll(payments, await api.relayerConfig());
  event('wallet-preflight', { address, sol: initial / 1e9, dmoth: Number(tokenRaw) / 1e6, quotes });
  if (!state.usd || execute) {
    const priceResponse = await originalFetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', { signal: AbortSignal.timeout(12000) });
    state.usd = Number((await priceResponse.json()).data.amount);
  }
  assert.ok(Number.isFinite(state.usd) && state.usd > 0 && state.usd * 0.05 <= 5, 'SOL test would exceed the authorized $5 ceiling.');
  let signedDeposit = false;
  const wallet = {
    address, provider: { publicKey: owner.publicKey },
    async signMessage(message) {
      assert.ok(message === 'Privacy Money account sign in' || (phase === 'purchase' && message.startsWith('Duskmoth Moth Pass\nBurn:')), 'Unexpected wallet message refused.');
      return nacl.sign.detached(new TextEncoder().encode(message), owner.secretKey);
    },
    async signTransaction(tx) {
      assert.ok(execute, 'Read-only test cannot sign a transaction.');
      if (phase === 'purchase') {
        assert.equal(tx.feePayer.toBase58(), address); assert.equal(tx.instructions.length, 1);
        const ix = tx.instructions[0], data = Buffer.from(ix.data);
        assert.equal(ix.programId.toBase58(), info.token.program); assert.equal(ix.keys[1].pubkey.toBase58(), info.mint);
        assert.equal(ix.keys[2].pubkey.toBase58(), address);
        assert.ok(tokenAccounts.value.some(row => row.pubkey === ix.keys[0].pubkey.toBase58()));
        assert.equal(data.length, 10); assert.equal(data[0], 15); assert.equal(data[9], 6);
        assert.equal(data.readBigUInt64LE(1), 100000000000n, 'Only the approved two-pass burn may be signed.');
        tx.partialSign(owner);
      } else {
        assert.equal(phase, 'deposit'); assert.equal(signedDeposit, false, 'A deposit was already signed; never sign another automatically.');
        assert.equal(tx.message.staticAccountKeys[0].toBase58(), address);
        const simulation = await rpc('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'), {
          encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true,
          accounts: { encoding: 'base64', addresses: [address] }, commitment: 'confirmed',
        }]);
        assert.equal(simulation.value.err, null, 'Deposit failed simulation.');
        const before = (await rpc('getBalance', [address, { commitment: 'confirmed' }])).value;
        const after = simulation.value.accounts?.[0]?.lamports;
        assert.ok(Number.isSafeInteger(after) && before - after >= 0 && state.initialLamports - after <= 50000000,
          'Deposit would exceed the total 0.05 SOL test ceiling.');
        tx.sign([owner]); signedDeposit = true;
        state.receipts.deposit = bs58.encode(tx.signatures[0]); state.stage = 'deposit-signed'; save();
        event('deposit-signed', { signature: state.receipts.deposit });
      }
      return tx;
    },
  };
  phase = 'private-balance'; event(phase);
  const { createLive } = await import('../public/assets/js/live/privacy-cash.js');
  const engine = await createLive({ rpcUrl: origin + '/api/rpc', wallet });
  let lastProgress = 0;
  const progress = value => {
    if (Date.now() - lastProgress > 15000) { lastProgress = Date.now(); event('privacy-progress', { detail: value.detail }); }
  };
  const balance = await engine.balance('SOL', progress);
  event('private-balance-result', { SOL: balance.SOL, execute });
  if (!execute) { state.stage = 'inspection-complete'; save(); }
  else {
    assert.ok(initial >= 60000000 || state.receipts.deposit || balance.SOL >= 0.04, 'Insufficient public and private SOL for the bounded test.');
    if (balance.SOL < 0.04 && !state.batch) {
      phase = 'deposit';
      if (state.receipts.deposit) {
        await txReceipt(state.receipts.deposit);
        throw new Error('Existing deposit needs indexing or balance recovery. No new deposit will be made.');
      }
      await engine.shield({ token: 'SOL', amount: Number((0.04 - balance.SOL).toFixed(9)), onProgress: progress });
      await txReceipt(state.receipts.deposit);
      state.stage = 'deposited'; save(); event('deposit-confirmed', { signature: state.receipts.deposit });
      assert.ok((await engine.balance('SOL', progress)).SOL >= 0.04, 'Deposit is not indexed yet.');
    }
    phase = 'purchase';
    if (!state.purchase && passes.count(info.kid) >= 2 && state.receipts.burn) {
      await txReceipt(state.receipts.burn); state.purchase = true; save();
    }
    if (!state.purchase) {
      assert.ok(tokenRaw >= 100000000000n || pendingPurchase(), 'Need 100,000 DMOTH for exactly two passes.');
      const purchaseResult = pendingPurchase()
        ? await resumePurchase({ info, wallet, onStep: ({ step }) => event('pass-step', { step }) })
        : await purchase({ info, wallet, count: 2, onStep: ({ step }) => event('pass-step', { step }) });
      state.purchase = true; state.receipts.burn = purchaseResult.burnSignature; save();
      await txReceipt(state.receipts.burn);
      event('two-passes-issued', { burn: state.receipts.burn, credits: passes.count(info.kid) });
    }
    phase = 'ai-pack';
    const prompt = `Prepare private withdrawals from my existing balance: 0.02 SOL to ${address}; 0.02 SOL to ${recipient.publicKey.toBase58()}. No schedule or automatic payments.`;
    if (!state.ai) await requestPremium(info, 'ai-pack', { prompt }, (response, journal) => {
      const sorted = rows => [...rows].sort((a, b) => a.recipient.localeCompare(b.recipient));
      assert.deepEqual(sorted(response.result.payments), sorted(payments));
      state.ai = response.result; state.aiProof = { ...journal.pass, requestId: journal.requestId };
      state.aiGrant = response.grant; save();
    });
    const recoveredAI = await api.premiumAction('ai-pack', { prompt, pass: state.aiProof });
    assert.equal(recoveredAI.grant, state.aiGrant); assert.deepEqual(recoveredAI.result, state.ai);
    event('ai-pack-real-result', { count: state.ai.payments.length, exactRecovery: true, credits: passes.count(info.kid) });
    phase = 'payroll';
    state.batch ||= { id: crypto.randomUUID(), owner: address, token: 'SOL', payments, records: payments.map((_, index) => ({ index, status: 'pending' })), status: 'prepared', authorized: false };
    const batch = state.batch;
    // Do not replace approved historical quotes on an uncertain payment.
    batch.quotes ||= quotes; save();
    if (batch.records.some(row => ['submitting', 'uncertain'].includes(row.status))) {
      for (const row of batch.records.filter(row => ['submitting', 'uncertain'].includes(row.status))) {
        if (!row.signature) throw new Error('An uncertain payment has no signature. Obtain it from the relayer; never retry.');
        const tx = await txReceipt(row.signature);
        assert.ok(receiptMatches(tx, payments[row.index], batch.quotes[row.index]), 'Uncertain receipt does not match; never retry.');
        row.status = 'confirmed'; save();
      }
    }
    await runPayroll({
      batch, engine, save, screen: recipient => api.screen({ sender: address, recipient }), config: api.relayerConfig,
      assertWallet: () => assert.equal(wallet.provider.publicKey.toBase58(), address),
      onStatus: detail => event('payroll-step', { detail }),
      authorize: async () => requestPremium(info, 'private-payroll', { payments }, (response, journal) => {
        batch.authorized = true; batch.authorization = { grant: response.grant, binding: response.binding, proof: { ...journal.pass, requestId: journal.requestId } }; save();
      }),
    });
    for (const row of batch.records) {
      assert.equal(row.status, 'confirmed');
      const tx = await txReceipt(row.signature);
      assert.ok(receiptMatches(tx, payments[row.index], batch.quotes[row.index]), 'Mainnet recipient/net receipt mismatch.');
      event('payment-proven', { row: row.index + 1, signature: row.signature, recipient: payments[row.index].recipient, net: batch.quotes[row.index].receive });
    }
    const auth = await api.premiumAction('private-payroll', { payments, pass: batch.authorization.proof });
    assert.equal(auth.grant, batch.authorization.grant);
    event('payroll-authorization-recovered', { extraPasses: 0 });
    phase = 'return-test-funds';
    if (state.receipts.sweep && !state.sweepWire) {
      const signature = state.receipts.sweep;
      const status = await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
      if (!status.value[0]) {
        // Older test runs did not retain their signed wire/blockhash. Wait an
        // entire validity window beyond a newly observed height, then verify
        // status and funds before signing a replacement. Never overlap them.
        state.sweepExpiryBound ??= (await rpc('getBlockHeight', [{ commitment: 'confirmed' }])) + 170;
        save(); event('waiting-for-old-return-expiry', { untilHeight: state.sweepExpiryBound });
        let expired = false;
        for (let attempt = 0; attempt < 180; attempt++) {
          if ((await rpc('getBlockHeight', [{ commitment: 'confirmed' }])) > state.sweepExpiryBound) { expired = true; break; }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        assert.ok(expired, 'Old return validity remains uncertain; do not sign a replacement.');
        const finalStatus = await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
        if (!finalStatus.value[0]) {
          const funds = (await rpc('getBalance', [recipient.publicKey.toBase58(), { commitment: 'confirmed' }])).value;
          assert.ok(funds >= Math.round(quotes[1].receive * 1e9), 'Return balance changed; reconcile before proceeding.');
          state.expiredReturnSignatures ||= []; state.expiredReturnSignatures.push(signature);
          delete state.receipts.sweep; save();
        }
      }
    }
    if (!state.receipts.sweep) {
      const available = (await rpc('getBalance', [recipient.publicKey.toBase58(), { commitment: 'confirmed' }])).value;
      const recent = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const tx = new Transaction({ feePayer: recipient.publicKey, ...recent.value });
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 10000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }));
      tx.add(SystemProgram.transfer({ fromPubkey: recipient.publicKey, toPubkey: owner.publicKey, lamports: available - 5000 }));
      const fee = await rpc('getFeeForMessage', [tx.serializeMessage().toString('base64'), { commitment: 'confirmed' }]);
      assert.ok(Number.isSafeInteger(fee.value) && fee.value <= 20000 && available > fee.value);
      tx.instructions[2] = SystemProgram.transfer({ fromPubkey: recipient.publicKey, toPubkey: owner.publicKey, lamports: available - fee.value });
      tx.sign(recipient);
      state.receipts.sweep = bs58.encode(tx.signature); state.sweepWire = tx.serialize().toString('base64');
      state.sweepLastValidHeight = recent.value.lastValidBlockHeight; save();
    }
    if (state.sweepWire) {
      const status = await rpc('getSignatureStatuses', [[state.receipts.sweep], { searchTransactionHistory: true }]);
      if (!status.value[0]) {
        assert.ok((await rpc('getBlockHeight', [{ commitment: 'confirmed' }])) <= state.sweepLastValidHeight, 'Saved return expired. Reconcile before replacing it.');
        const signature = await rpc('sendTransaction', [state.sweepWire, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]);
        assert.equal(signature, state.receipts.sweep);
      }
    }
    await txReceipt(state.receipts.sweep);
    state.stage = 'completed'; save();
    const final = (await rpc('getBalance', [address, { commitment: 'confirmed' }])).value;
    event('mainnet-premium-proven', { receipts: { ...state.receipts, payroll: batch.records.map(row => row.signature) }, dmothBurned: 100000, remainingPasses: passes.count(info.kid), solBefore: state.initialLamports / 1e9, solAfter: final / 1e9, noPrivateKeysExported: true, extensionBrowserTest: false });
  }
} catch (error) {
  event('stopped-preserving-recovery', { stage: phase, error: String(error.message).replace(/[A-Za-z0-9+/=_-]{100,}/g, '[redacted]').slice(0, 300) });
  process.exitCode = 1;
} finally {
  bytes?.fill(0); owner?.secretKey.fill(0); recipient?.secretKey.fill(0);
}
