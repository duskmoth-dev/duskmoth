import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWithdrawalPrivacy, validatePrivacyRequest } from './withdraw-privacy.js';

const sender = '9ueEeBuYUc9X1GrNCyWHbKGnHJq1kaD2nvDapDsMpump';
const recipient = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const input = { sender, recipient, token: 'SOL', amount: 0.05 };
const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const now = () => 1_800_000_000_000;
const sig = 'a'.repeat(88);
function fixture(overrides = {}) {
  const calls = [];
  return {
    calls, now,
    async rpc(method, params) {
      calls.push({ method, params });
      if (overrides[method]) return overrides[method](params);
      if (method === 'getGenesisHash') return genesis;
      if (method === 'getSignaturesForAddress') return [{ signature: sig, blockTime: now() / 1000 - 120, err: null }];
      if (method === 'getTransaction') return {
        transaction: { message: { accountKeys: [{ pubkey: sender }, { pubkey: recipient }] } },
        meta: { err: null, fee: 5000, preBalances: [1e9, 1e9], postBalances: [949995000, 1050000000] },
      };
      throw new Error('Unexpected RPC');
    },
  };
}

test('rejects malformed keys, unsupported assets, coercions and unbounded amounts', () => {
  for (const change of [
    { sender: '1'.repeat(33) }, { recipient: '<script>' }, { token: 'DMOTH' },
    { amount: '0.05' }, { amount: 0 }, { amount: -1 }, { amount: Infinity }, { amount: 1e20 },
  ]) assert.throws(() => validatePrivacyRequest({ ...input, ...change }), { status: 400 });
  assert.throws(() => validatePrivacyRequest(null));
  assert.deepEqual(validatePrivacyRequest(input), input);
});

test('validates mainnet before fetching address history', async () => {
  const api = fixture({ getGenesisHash: () => 'devnet' });
  await assert.rejects(checkWithdrawalPrivacy(input, api), { status: 503 });
  assert.equal(api.calls.length, 1);
});

test('reports real sampled signals with fee-adjusted SOL amounts and evidence', async () => {
  const report = await checkWithdrawalPrivacy(input, fixture());
  assert.equal(report.network, 'solana-mainnet');
  assert.equal(report.status, 'sampled');
  assert.equal(report.checks.find(c => c.id === 'amount').status, 'warning');
  assert.equal(report.checks.find(c => c.id === 'public-link').status, 'warning');
  assert.equal(report.checks.find(c => c.id === 'timing').status, 'warning');
  assert.equal(report.warningCount, 4);
  assert.deepEqual(report.checks.find(c => c.id === 'amount').evidence, [sig]);
  assert.match(report.limitations, /not an anonymity guarantee/);
  assert.equal(report.checkedAt, new Date(now()).toISOString());
});

test('empty history is limited evidence, never a perfect score or deposit claim', async () => {
  const report = await checkWithdrawalPrivacy(input, fixture({ getSignaturesForAddress: () => [] }));
  assert.equal(report.status, 'partial');
  assert.equal(report.checks.find(c => c.id === 'amount').status, 'unknown');
  assert.equal(report.checks.find(c => c.id === 'timing').status, 'unknown');
  assert.equal(report.score, undefined);
  assert.equal(report.safe, undefined);
});

test('partial upstream failure stays unknown without blocking other public facts', async () => {
  const report = await checkWithdrawalPrivacy(input, fixture({
    getSignaturesForAddress: ([key]) => { if (key === recipient) throw new Error('provider error with secret'); return []; },
  }));
  assert.equal(report.status, 'partial');
  assert.equal(report.checks.find(c => c.id === 'recipient-history').status, 'unknown');
  assert.doesNotMatch(JSON.stringify(report), /secret|provider error/);
});

test('both history failures produce no invented assessment', async () => {
  await assert.rejects(checkWithdrawalPrivacy(input, fixture({ getSignaturesForAddress: () => { throw new Error(); } })), { status: 503 });
});

test('pruned/null transactions keep link and amount checks unknown', async () => {
  const report = await checkWithdrawalPrivacy(input, fixture({
    getSignaturesForAddress: ([key]) => key === sender ? [{ signature: sig, err: null }] : [],
    getTransaction: () => null,
  }));
  assert.equal(report.status, 'partial');
  assert.equal(report.checks.find(c => c.id === 'amount').status, 'unknown');
  assert.equal(report.checks.find(c => c.id === 'public-link').status, 'unknown');
});

test('self-recipient is exposed even when the provider has no history', async () => {
  const report = await checkWithdrawalPrivacy({ ...input, recipient: sender }, fixture({ getSignaturesForAddress: () => [] }));
  assert.equal(report.checks[0].status, 'warning');
});

test('missing balance metadata is unknown, not a clear amount check', async () => {
  for (const token of ['SOL', 'USDC']) {
    const report = await checkWithdrawalPrivacy({ ...input, token }, fixture({
      getTransaction: () => ({ transaction: { message: { accountKeys: [sender] } }, meta: { err: null } }),
    }));
    assert.equal(report.checks.find(c => c.id === 'amount').status, 'unknown');
    assert.equal(report.coverage.amountTransactionsInspected, 0);
    assert.equal(report.status, 'partial');
  }
});

test('USDC uses exact raw token balance changes rather than native balance', async () => {
  const report = await checkWithdrawalPrivacy({ ...input, token: 'USDC', amount: 25 }, fixture({
    getTransaction: () => ({
      transaction: { message: { accountKeys: [sender] } },
      meta: { err: null,
        preTokenBalances: [{ owner: sender, mint: recipient, uiTokenAmount: { amount: '30000000' } }],
        postTokenBalances: [{ owner: sender, mint: recipient, uiTokenAmount: { amount: '5000000' } }],
      },
    }),
  }));
  assert.equal(report.checks.find(c => c.id === 'amount').status, 'warning');
});

test('bounded, read-only RPC and failed transactions excluded', async () => {
  const api = fixture({ getSignaturesForAddress: () => Array.from({ length: 20 }, (_, i) => ({ signature: `${sig}${i}`, err: i === 0 ? { failed: true } : null })) });
  const report = await checkWithdrawalPrivacy(input, api);
  assert.equal(report.coverage.transactionsInspected, 3);
  assert.equal(api.calls.filter(c => c.method === 'getTransaction').length, 3);
  assert.ok(api.calls.filter(c => c.method === 'getTransaction').every(c => c.params[1].maxSupportedTransactionVersion === 1));
  assert.ok(api.calls.every(c => ['getGenesisHash', 'getSignaturesForAddress', 'getTransaction'].includes(c.method)));
  assert.ok(api.calls.filter(c => c.method === 'getSignaturesForAddress').every(c => c.params[1].limit === 20));
});
