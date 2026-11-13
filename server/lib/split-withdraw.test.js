import test from 'node:test';
import assert from 'node:assert/strict';
import { planSplit, quoteSplit, validateSplit, runSplitWithdrawal, MIN_PART } from '../../public/assets/js/split-withdraw.js';
import { parseRules, validateProposedAction } from './intent.js';
const address = '11111111111111111111111111111111';
const config = { withdraw_fee_rate: 0.0035, withdraw_rent_fee: 0.006, rent_fees: { usdc: 0.574 }, minimum_withdrawal: { sol: 0.01, usdc: 2 } };
test('withdraw intent and model validation can never trigger a new deposit', () => {
  for (const verb of ['Withdraw', 'unshield']) {
    const message = `${verb} 0.03 SOL to ${address}`;
    assert.equal(parseRules(message).action.type, 'withdraw');
    for (const type of ['send', 'shield', 'withdraw']) {
      const result = validateProposedAction({ type, amount: 0.03, token: 'SOL', recipient: address, delay: 'later' }, message);
      assert.equal(result.type, 'withdraw'); assert.equal(Object.hasOwn(result, 'delay'), false);
    }
  }
  assert.equal(validateProposedAction({ type: 'withdraw', amount: 0.04, token: 'SOL', recipient: address }, `withdraw 0.03 SOL to ${address}`), null);
  assert.equal(validateProposedAction({ type: 'withdraw', amount: 0.03, token: 'SOL', recipient: address }, 'withdraw 0.03 SOL'), null);
  assert.equal(parseRules('withdraw 0.03 SOL').reply, 'Who should receive it? Paste the recipient Solana address.');
  assert.equal(parseRules(`withdraw SOL to ${address}`).reply, 'How much, and in which token? I support SOL and USDC.');
  assert.equal(parseRules(`withdraw -0.03 SOL to ${address}`).action, null);
});
test('random plans preserve all units, minimums, 2–4 parts and real waits including edge amounts', () => {
  for (const [token, amounts] of [['SOL', [0.04, 0.05, 0.080000001, 0.1, 1]], ['USDC', [4, 4.01, 8.123456, 25, 100]]]) {
    for (const amount of amounts) for (let i = 0; i < 50; i++) {
      const plan = planSplit(amount, token);
      validateSplit({ type: 'withdraw', amount, token }, plan);
      assert.ok(plan.every(part => part.amount >= MIN_PART[token]));
      assert.ok(plan[0].wait === 0 && plan.slice(1).every(part => part.wait >= 30 && part.wait <= 120));
    }
  }
  assert.throws(() => planSplit(0.03, 'SOL'));
  assert.throws(() => validateSplit({ type: 'send', amount: 0.1, token: 'SOL' }, planSplit(0.1, 'SOL')));
});
test('every part pays its own current fee and must independently meet the received minimum', () => {
  const action = { type: 'withdraw', amount: 0.1, token: 'SOL' }, plan = planSplit(0.1, 'SOL', () => 0.5);
  const quote = quoteSplit(action, plan, config);
  assert.equal(quote.quotes.length, plan.length);
  assert.ok(Math.abs(quote.rent - plan.length * 0.006) < 1e-12);
  assert.ok(Math.abs(quote.receive + quote.fee - action.amount) < 1e-12);
  assert.throws(() => quoteSplit({ type: 'withdraw', amount: 4, token: 'USDC' }, planSplit(4, 'USDC'), config), /at least/);
});
function options(overrides = {}) {
  const action = { type: 'withdraw', amount: 0.1, token: 'SOL', recipient: address }, plan = planSplit(0.1, 'SOL', () => 0.3);
  return { action, plan, approvedQuotes: quoteSplit(action, plan, config).quotes,
    assertWallet() {}, screen: async () => ({ allowed: true, source: 'scorechain', scope: 'sanctions-only' }),
    config: async () => config, spend: async () => {}, onStatus() {}, onConfirmed() {}, sleep: async () => {},
    engine: { balance: async () => ({ SOL: 0.1 }), withdraw: async () => 'fixture-signature', shield: () => { throw Error('deposit must never run'); } }, ...overrides };
}
test('zero private balance, failed screening and rising fees stop before spending a pass', async () => {
  let spends = 0;
  const spend = async () => { spends++; };
  for (const override of [
    { engine: { balance: async () => ({ SOL: 0 }) } },
    { screen: async () => ({ allowed: false }) },
    { config: async () => ({ ...config, withdraw_rent_fee: 0.007 }) },
  ]) await assert.rejects(runSplitWithdrawal(options({ spend, ...override })));
  assert.equal(spends, 0);
});
test('split withdraw spends exactly one pass and never calls deposit', async () => {
  let spends = 0, confirmations = 0, initialBalance;
  const opts = options({ spend: async () => { spends++; }, onConfirmed: () => { confirmations++; }, onBalance: balance => { initialBalance = balance; } });
  const result = await runSplitWithdrawal(opts);
  assert.equal(spends, 1); assert.equal(confirmations, opts.plan.length); assert.equal(result.length, opts.plan.length);
  assert.equal(initialBalance, 0.1);
});
test('a partial failure preserves confirmed receipts and does not retry or redeposit', async () => {
  let calls = 0;
  const opts = options({ engine: { balance: async () => ({ SOL: 0.1 }), withdraw: async () => { if (++calls === 2) throw Error('fixture failure'); return 'fixture-signature'; } } });
  await assert.rejects(runSplitWithdrawal(opts), error => error.completed.length === 1 && error.completed[0].amount === opts.plan[0].amount);
  assert.equal(calls, 2);
});
