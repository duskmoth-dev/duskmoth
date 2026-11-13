import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import * as passes from '../../public/assets/js/passes.js';
import { createPremiumTools } from '../../public/assets/js/premium-tools.js';
import { payrollReadiness } from '../../public/assets/js/payroll-readiness.js';

const owner = Keypair.generate().publicKey.toBase58();
const recipient = Keypair.generate().publicKey.toBase58();
function ready() {
  return { loading: false, error: '', creditError: '', credits: 1, wallet: { address: owner },
    config: { liveSend: true }, passInfo: { enabled: true },
    payroll: { owner, status: 'reviewed', busy: false, authorized: false,
      quotes: [{ fee: 0.006105, receive: 0.023895 }], records: [{ status: 'pending' }] } };
}

test('payroll readiness explains no-credit and re-review states, but never charges authorized batches twice', () => {
  const state = ready();
  assert.equal(payrollReadiness(state).canRun, true);
  state.credits = 0;
  assert.equal(payrollReadiness(state).canRun, false);
  assert.match(payrollReadiness(state).reasons.join(' '), /AI Pack and Payroll each cost a separate pass/);
  state.payroll.status = 'needs-review';
  assert.match(payrollReadiness(state).reasons.join(' '), /Review · free/);
  state.payroll.busy = true;
  assert.doesNotMatch(payrollReadiness(state).reasons.join(' '), /Select Review/);
  assert.equal(payrollReadiness(state).canRun, false);
  state.payroll.busy = false;
  state.payroll.status = 'reviewed'; state.payroll.authorized = true;
  assert.equal(payrollReadiness(state).canRun, true);
  state.wallet.address = recipient;
  assert.equal(payrollReadiness(state).canRun, false);
  assert.match(payrollReadiness(state).reasons.join(' '), /Reconnect/);
});

test('payroll readiness explains unresolved payments and unavailable transfer settings', () => {
  const state = ready();
  state.payroll.records[0].status = 'uncertain';
  assert.match(payrollReadiness(state).reasons.join(' '), /Reconcile with chain/);
  state.payroll.records[0].status = 'pending'; state.config.liveSend = false;
  assert.equal(payrollReadiness(state).canRun, false);
  state.config.liveSend = true; state.passInfo.features = { 'private-payroll': { enabled: false, reason: 'Temporarily unavailable' } };
  assert.deepEqual(payrollReadiness(state).reasons, ['Temporarily unavailable']);
});

test('preparing payroll automatically performs free review and credits update on pass events or focus', async t => {
  const originals = { window: globalThis.window, fetch: globalThis.fetch, storage: globalThis.localStorage, dispatch: globalThis.dispatchEvent };
  const store = new Map(), events = new EventTarget();
  const provider = { isPhantom: true, isConnected: true, publicKey: { toString: () => owner },
    connect: async () => ({ publicKey: provider.publicKey }), disconnect: async () => {} };
  globalThis.window = { phantom: { solana: provider }, addEventListener: events.addEventListener.bind(events) };
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
  globalThis.dispatchEvent = events.dispatchEvent.bind(events);
  store.set('dm_ai_pack_v1', JSON.stringify({
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    payments: [{ recipient, amount: 0.03, token: 'SOL' }],
  }));
  const kid = 'a'.repeat(16), calls = [];
  let screenAllowed = true;
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    let result;
    if (url === '/api/config') result = { liveSend: true, limits: { SOL: 1, USDC: 100 } };
    else if (url === '/api/pass/info') result = { enabled: true, kid, demo: false, features: { 'private-payroll': { enabled: true } } };
    else if (url === '/api/relayer/config') result = { withdraw_fee_rate: 0.0035, withdraw_rent_fee: 0.006, minimum_withdrawal: { sol: 0.01 } };
    else if (url === '/api/screen') result = { allowed: screenAllowed, source: 'scorechain', scope: 'sanctions-only' };
    else assert.fail(`Unexpected network request: ${url}`);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => {
    globalThis.window = originals.window; globalThis.fetch = originals.fetch;
    globalThis.localStorage = originals.storage; globalThis.dispatchEvent = originals.dispatch;
  });
  const ctl = await createPremiumTools();
  await ctl.connect('phantom');
  await ctl.preparePayroll(`${recipient},0.03,SOL`);
  assert.equal(ctl.state.payroll.status, 'reviewed');
  const batchId = ctl.state.payroll.id;
  await ctl.useAIPlan();
  assert.equal(ctl.state.payroll.id, batchId, 'Reusing the same AI plan reviews the same batch instead of replacing it');
  assert.equal(ctl.state.credits, 0);
  assert.equal(payrollReadiness(ctl.state).canRun, false);
  const pass = { kid, demo: false, msg: btoa('m'.repeat(32)), sig: btoa('s'.repeat(256)) };
  passes.add([pass]);
  assert.equal(ctl.state.credits, 1);
  assert.equal(payrollReadiness(ctl.state).canRun, true);
  store.set('dm_passes', '[]'); events.dispatchEvent(new Event('focus'));
  assert.equal(ctl.state.credits, 0);
  assert.equal(payrollReadiness(ctl.state).canRun, false);
  screenAllowed = false;
  assert.equal(await ctl.reviewPayroll(), false);
  assert.equal(ctl.state.payroll.status, 'needs-review');
  assert.match(ctl.state.payroll.error, /screening service did not complete/);
  assert.ok(calls.every(url => !/authorize|ai-pack|rpc|relayer\/withdraw/.test(url)), 'No pass spent, wallet signing or withdrawal during review');
});
