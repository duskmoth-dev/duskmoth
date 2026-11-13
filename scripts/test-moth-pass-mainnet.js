// Explicitly authorized mainnet smoke test. No default spend and no key export.
// Recovery/blinding state stays in the private, ignored application data folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const mint = '9ueEeBuYUc9X1GrNCyWHbKGnHJq1kaD2nvDapDsMpump';
const program = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const origin = 'http://localhost';
const args = new Set(process.argv.slice(2));
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/mainnet-pass-test');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.chmodSync(directory, 0o700);
const stateFile = path.join(directory, 'browser-state.json');
const receiptFile = path.join(directory, 'receipt.json');
const lockFile = path.join(directory, 'test.lock');
try {
  const fd = fs.openSync(lockFile, 'wx', 0o600);
  fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
} catch {
  console.error('Another test or an interrupted test lock needs operator review. No transaction submitted.');
  process.exit(1);
}
process.once('exit', () => { try { fs.unlinkSync(lockFile); } catch {} });
function save(filename, value) {
  const temp = filename + '.tmp';
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, filename);
  const dir = fs.openSync(directory, 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
const storage = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const receipt = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : {};
const fetchOriginal = globalThis.fetch;
let dropIssue = args.has('--test-recovery') && !receipt.purchaseComplete;
let dropRedeem = args.has('--test-recovery') && !receipt.redemptionComplete;
globalThis.window = globalThis;
globalThis.isSecureContext = true;
globalThis.location = { href: `${origin}/pass`, origin };
globalThis.dispatchEvent ||= () => true;
globalThis.localStorage = {
  getItem: key => storage[key] ?? null,
  setItem: (key, value) => { storage[key] = String(value); save(stateFile, storage); },
  removeItem: key => { delete storage[key]; save(stateFile, storage); },
};
Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name, options, run) => run({ name }) } });
globalThis.fetch = async (target, options = {}) => {
  const url = new URL(target, origin);
  assert.equal(url.origin, origin, 'Unexpected external network access blocked.');
  const response = await fetchOriginal(url, options);
  if (response.ok && url.pathname === '/api/pass/issue' && dropIssue) {
    dropIssue = false; receipt.issueResponseRecovery = true; save(receiptFile, receipt);
    throw new Error('Test: successful issuance response deliberately dropped.');
  }
  if (response.ok && url.pathname === '/api/pass/redeem' && dropRedeem) {
    dropRedeem = false; receipt.redeemResponseRecovery = true; save(receiptFile, receipt);
    throw new Error('Test: successful redemption response deliberately dropped.');
  }
  return response;
};
async function rpc(method, params) {
  const response = await fetchOriginal(`${origin}/api/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error('Application RPC check failed.');
  return result.result;
}
let owner, bytes;
try {
  const value = process.env.TEST_WALLET_PRIVATE_KEY?.trim();
  assert.ok(value, 'TEST_WALLET_PRIVATE_KEY must be set in Secrets.');
  if (value.startsWith('[')) {
    const values = JSON.parse(value);
    assert.ok(Array.isArray(values) && values.every(v => Number.isInteger(v) && v >= 0 && v <= 255));
    bytes = Uint8Array.from(values);
  } else bytes = bs58.decode(value);
  assert.ok([32, 64].includes(bytes.length), 'Unsupported test-wallet key format.');
  owner = bytes.length === 64 ? Keypair.fromSecretKey(bytes) : Keypair.fromSeed(bytes);
  const address = owner.publicKey.toBase58();
  const info = await (await fetchOriginal(`${origin}/api/pass/info`)).json();
  assert.equal(info.enabled, true, 'Pass service must be ready before any burn.');
  assert.equal(info.durable, true); assert.equal(info.storage, 'postgres');
  assert.equal(info.demo, false); assert.equal(info.mint, mint);
  assert.equal(info.token?.verified, true); assert.equal(info.price, 50000);
  assert.equal(info.token.program, program); assert.equal(info.token.decimals, 6);
  if (receipt.kid) assert.equal(info.kid, receipt.kid, 'Issuer changed; stop and recover the original key.');
  if (args.has('--verify-receipt')) assert.ok(receipt.purchaseComplete && receipt.redemptionComplete, 'A completed receipt is required; verification never starts a purchase.');
  const balance = await rpc('getBalance', [address, { commitment: 'confirmed' }]);
  const accounts = await rpc('getTokenAccountsByOwner', [address, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const dmothRaw = accounts.value.reduce((sum, row) => sum + BigInt(row.account.data.parsed.info.tokenAmount.amount), 0n);
  console.log(JSON.stringify({ event: 'preflight', address, solLamports: balance.value, dmothRaw: dmothRaw.toString(), kid: info.kid }));
  if (!args.has('--purchase-one') && !args.has('--verify-receipt')) {
    console.log('Read-only check complete. --purchase-one explicitly authorizes one 50,000 DMOTH burn.');
  } else {
    const { purchase, resumePurchase, pendingPurchase } = await import('../public/assets/js/pass-purchase.js');
    const passes = await import('../public/assets/js/passes.js');
    const wallet = {
      address, provider: { publicKey: owner.publicKey },
      async signMessage(message) { return nacl.sign.detached(new TextEncoder().encode(message), owner.secretKey); },
      async signTransaction(tx) {
        // Limit even a compromised client bundle to the approved one-token burn.
        assert.equal(tx.feePayer.toBase58(), address);
        assert.equal(tx.instructions.length, 1);
        const instruction = tx.instructions[0], data = Buffer.from(instruction.data);
        assert.equal(instruction.programId.toBase58(), program);
        assert.equal(instruction.keys.length, 3);
        assert.equal(instruction.keys[1].pubkey.toBase58(), mint);
        assert.equal(instruction.keys[2].pubkey.toBase58(), address);
        assert.equal(data.length, 10); assert.equal(data[0], 15);
        assert.equal(data[9], 6); assert.equal(data.readBigUInt64LE(1), 50000000000n);
        assert.ok(accounts.value.some(row => row.pubkey === instruction.keys[0].pubkey.toBase58()));
        const fee = await rpc('getFeeForMessage', [Buffer.from(tx.serializeMessage()).toString('base64'), { commitment: 'confirmed' }]);
        assert.ok(Number.isSafeInteger(fee.value) && fee.value <= 100000 && balance.value > fee.value, 'Network fee exceeds test limit.');
        tx.partialSign(owner);
        const simulated = await rpc('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]);
        assert.equal(simulated.value.err, null, 'Mainnet simulation failed; nothing broadcast.');
        return tx;
      },
    };
    receipt.kid = info.kid;
    const onStep = ({ step }) => console.log(JSON.stringify({ event: 'purchase-step', step }));
    if (!receipt.purchaseComplete) {
      if (!pendingPurchase() && passes.all().length) throw new Error('Existing local credits require receipt recovery; refusing another burn.');
      let result;
      try {
        result = pendingPurchase() ? await resumePurchase({ info, wallet, onStep }) : await purchase({ info, wallet, count: 1, onStep });
      } catch (error) {
        if (!pendingPurchase()?.burnSignature) throw error;
        // Same saved transaction and blinded batch, never a second purchase.
        result = await resumePurchase({ info, wallet, onStep });
      }
      assert.equal(result.passes.length, 1); assert.equal(result.demo, false);
      receipt.burnSignature = result.burnSignature;
      receipt.purchaseComplete = true;
      receipt.pass = result.passes[0]; // Bearer backup; private ignored file only.
      receipt.dmothBurned = 50000;
      save(receiptFile, receipt);
    }
    const tx = await rpc('getTransaction', [receipt.burnSignature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    assert.ok(tx && tx.meta && tx.meta.err === null, 'Burn must be confirmed.');
    receipt.feeLamports = tx.meta.fee;
    assert.ok(receipt.feeLamports <= 100000);
    if (args.has('--redeem-one') && !receipt.redemptionComplete) {
      const { spendSplitPass } = await import('../public/assets/js/pass-spend.js');
      assert.equal(passes.all().length, 1);
      const spent = await spendSplitPass(info);
      assert.equal(spent.ok, true); assert.equal(spent.feature, 'split-withdraw');
      receipt.redemptionComplete = true; receipt.grant = spent.grant;
      save(receiptFile, receipt);
    }
    if (receipt.redemptionComplete) {
      const response = await fetchOriginal(`${origin}/api/pass/redeem`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...receipt.pass, requestId: randomBytes(16).toString('hex'), feature: 'split-withdraw' }),
      });
      assert.equal(response.status, 409, 'A paid pass must not be spendable twice.');
      receipt.replayRejected = true;
    }
    save(receiptFile, receipt);
    console.log(JSON.stringify({
      event: 'mainnet-test-result', burnSignature: receipt.burnSignature,
      dmothBurned: receipt.dmothBurned, feeLamports: receipt.feeLamports,
      purchaseComplete: receipt.purchaseComplete, redemptionComplete: !!receipt.redemptionComplete,
      replayRejected: !!receipt.replayRejected, issueResponseRecovery: !!receipt.issueResponseRecovery,
      redeemResponseRecovery: !!receipt.redeemResponseRecovery,
      remainingLocalCredits: passes.all().length,
    }));
  }
} catch (error) {
  console.error('Moth Pass test stopped. Private recovery state is preserved; do not start another burn.');
  console.error(JSON.stringify({ event: 'test-stopped', kind: error?.name, frames: String(error?.stack || '').split('\n').slice(1, 5) }));
  process.exitCode = 1;
} finally {
  bytes?.fill(0); owner?.secretKey.fill(0);
  globalThis.fetch = fetchOriginal;
}
