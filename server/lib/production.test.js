import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { ownershipMessage, verifyOwnership } from './verify.js';
import { status, transferReadiness } from './env.js';
import { parseRules } from './intent.js';
import { validateTransfer, withdrawalQuote } from '../../public/assets/js/transfer.js';
import { scoreWallet } from './score.js';
import { walletActivity } from './activity.js';
import { makeWallet, b58encode, ownershipMessage as browserMessage } from '../../public/assets/js/wallet.js';

const address = '11111111111111111111111111111111';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('real transfers follow operator configuration; demo wallets never exist', () => {
  assert.equal(makeWallet('demo'), null);
  assert.equal(status().demoWallet, false);
  assert.deepEqual(transferReadiness({ liveSend: true, scorechain: true, helius: true }), { liveSend: true, transferStatus: 'wallet-approval-required', transferBlockReason: null });
  assert.equal(transferReadiness({ liveSend: false, scorechain: true, helius: true }).liveSend, false);
  assert.equal(transferReadiness({ liveSend: true, scorechain: false, helius: true }).liveSend, false);
  assert.equal(transferReadiness({ liveSend: true, scorechain: true, helius: false }).liveSend, false);
});

test('withdraw requests use existing private balance instead of another deposit', () => {
  for (const text of [`Withdraw 0.02 SOL to ${address}`, `Unshield 0.02 SOL to ${address}`, `Send 0.02 SOL from my private balance to ${address}`]) {
    const result = parseRules(text);
    assert.equal(result.action.type, 'withdraw');
    assert.equal(result.action.recipient, address);
  }
  assert.equal(parseRules('Withdraw 0.02 SOL').action, null);
  assert.equal(parseRules('Shield 0.02 SOL').action.type, 'shield');
  assert.equal(parseRules(`Send 0.02 SOL to ${address}`).action.type, 'send');
});

test('invalid amounts and excess decimal places never reach the wallet', () => {
  const limits = { SOL: 1, USDC: 100 };
  const action = { type: 'shield', token: 'SOL', amount: 0.02 };
  assert.equal(validateTransfer(action, limits), 20000000);
  for (const amount of [0, -1, NaN, Infinity, 2, 0.0000000001]) assert.throws(() => validateTransfer({ ...action, amount }, limits));
  assert.throws(() => validateTransfer({ ...action, token: 'USDC', amount: 0.0000001 }, limits));
  assert.throws(() => validateTransfer({ ...action, token: 'ETH' }, limits));
});

test('current relayer fees and received minimum are enforced for SOL and USDC', () => {
  const config = { withdraw_fee_rate: 0.0035, withdraw_rent_fee: 0.006, rent_fees: { usdc: 0.574 }, minimum_withdrawal: { sol: 0.01, usdc: 2 } };
  const q = withdrawalQuote({ token: 'SOL', amount: 0.02 }, config);
  assert.equal(q.fee, 0.00607);
  assert.equal(q.receive, 0.01393);
  assert.throws(() => withdrawalQuote({ token: 'SOL', amount: 0.01 }, config), /at least/);
  assert.throws(() => withdrawalQuote({ token: 'USDC', amount: 2 }, config), /at least/);
  assert.ok(withdrawalQuote({ token: 'USDC', amount: 5 }, config).receive > 4);
  assert.throws(() => withdrawalQuote({ token: 'SOL', amount: 0.02 }, {}), /valid fees/);
  assert.throws(() => withdrawalQuote({ token: 'SOL', amount: 0.02 }, { ...config, withdraw_fee_rate: NaN }), /valid fees/);
});

test('real Ed25519 ownership proof verifies; altered and expired proofs fail', () => {
  // Ephemeral, unfunded test key. Never persisted or printed, and never used for a transaction.
  const keys = nacl.sign.keyPair();
  const address = bs58.encode(keys.publicKey), ts = Date.now();
  assert.equal(browserMessage(address, ts), ownershipMessage(address, ts));
  const signature = b58encode(nacl.sign.detached(new TextEncoder().encode(browserMessage(address, ts)), keys.secretKey));
  assert.equal(verifyOwnership({ address, ts, signature }).ok, true);
  assert.equal(verifyOwnership({ address, ts: ts - 1, signature }).ok, false);
  assert.equal(verifyOwnership({ address, ts: ts - 600000, signature }).ok, false);
  assert.equal(verifyOwnership({ address, ts }).ok, false);
  keys.secretKey.fill(0);
});

test('offline browser operations never produce invented results', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('offline fixture'); };
    const api = await import('../../public/assets/js/api.js');
    for (const operation of [() => api.config(), () => api.intent('balance'), () => api.score({ address }), () => api.activity(address), () => api.waitlist('test@example.invalid')]) {
      await assert.rejects(operation(), /could not be reached/);
    }
    assert.equal((await api.screen({ recipient: address })).allowed, false);
  } finally { globalThis.fetch = original; }
});

test('failed RPC does not substitute a zero balance or invented activity', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => json({ error: 'offline fixture' }, 502);
    const result = await walletActivity(address, { demo: true });
    assert.equal(result.source, 'unavailable');
    assert.equal(result.sol, null);
    assert.equal(result.usdc, null);
    assert.deepEqual(result.history, []);
  } finally { globalThis.fetch = original; }
});

test('restricted Helius signals remain unknown, not clear', { skip: !process.env.HELIUS_API_KEY }, async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async url => {
      if (String(url).includes('anthropic.com')) return json({
        id: 'fixture', type: 'message', role: 'assistant', model: 'fixture',
        content: [{ type: 'text', text: 'This is a limited heuristic estimate.' }],
        stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      });
      if (String(url).endsWith('/balances')) return json({ totalUsdValue: 100 });
      if (String(url).endsWith('/transfers')) return json([]);
      return json({ error: 'Plan restricted fixture' }, 403);
    };
    const result = await scoreWallet(address);
    assert.equal(result.source, 'helius');
    assert.equal(result.signals.find(s => s.id === 'cexFunded').detected, null);
    assert.equal(result.signals.find(s => s.id === 'domain').detected, null);
    assert.ok(result.coverage.checked < result.coverage.total);
    assert.match(result.summary, /not proof of anonymity/);
  } finally { globalThis.fetch = original; }
});
