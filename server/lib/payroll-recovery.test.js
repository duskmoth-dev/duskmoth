import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { createPremiumTools } from '../../public/assets/js/premium-tools.js';
import { payrollProgress } from '../../public/assets/js/payroll-progress.js';

const owner = Keypair.generate().publicKey.toBase58();
const recipient = Keypair.generate().publicKey.toBase58();
const signature = '2'.repeat(88);
const quote = { receive: 0.023895, fee: 0.006105, rate: 0.0035, rent: 0.006 };
function savedBatch() {
  return { id: 'a'.repeat(32), owner, payments: [{ recipient, amount: 0.03, token: 'SOL' }],
    records: [{ index: 0, status: 'submitting', signature }], quotes: [quote],
    authorization: { grant: 'b'.repeat(64) }, status: 'running', busy: true };
}
function receipt() {
  return { transaction: { message: { accountKeys: [owner, recipient] } },
    meta: { err: null, preBalances: [100000000, 0], postBalances: [99995000, 23895000], fee: 5000 } };
}
async function controller(t, batch, rpcResult = receipt()) {
  const original = { window: globalThis.window, fetch: globalThis.fetch, storage: globalThis.localStorage };
  const store = new Map([['dm_payroll_v1', JSON.stringify(batch)]]);
  const calls = [], snapshots = [];
  const provider = { isPhantom: true, isConnected: true, publicKey: { toString: () => owner },
    connect: async () => ({ publicKey: provider.publicKey }), disconnect: async () => {} };
  globalThis.window = { phantom: { solana: provider }, addEventListener() {} };
  globalThis.localStorage = { getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    let body;
    if (url === '/api/config') body = { liveSend: true, limits: { SOL: 1, USDC: 100 } };
    else if (url === '/api/pass/info') body = { enabled: true, kid: 'c'.repeat(16), features: { 'private-payroll': { enabled: true } } };
    else if (url.startsWith('/api/engines/magicblock/info')) body = { reviewEnabled: false, executionEnabled: false };
    else if (url === '/api/rpc') {
      assert.equal(JSON.parse(options.body).method, 'getTransaction');
      body = rpcResult instanceof Error ? { error: { message: 'Fixture unavailable' } } : { result: rpcResult };
    } else assert.fail(`Recovery must not call ${url}`);
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => {
    globalThis.window = original.window; globalThis.fetch = original.fetch; globalThis.localStorage = original.storage;
  });
  const ctl = await createPremiumTools({ onChange: state => {
    if (state.payroll) snapshots.push(structuredClone(state.payroll));
  } });
  await ctl.connect('phantom');
  return { ctl, store, calls, snapshots };
}

test('restored in-flight payroll recovers from saved quotes without relayer, pass spend or withdrawal', async t => {
  const { ctl, store, calls, snapshots } = await controller(t, savedBatch());
  assert.equal(ctl.state.payroll.records[0].status, 'uncertain');
  assert.equal(ctl.state.payroll.busy, false);
  assert.equal(ctl.state.payroll.authorized, true);
  await ctl.reconcilePayroll();
  assert.equal(ctl.state.payroll.status, 'completed');
  assert.equal(ctl.state.payroll.records[0].status, 'confirmed');
  assert.equal(JSON.parse(store.get('dm_payroll_v1')).status, 'completed');
  assert.ok(snapshots.some(batch => batch.phase === 'reconcile' && batch.busy));
  assert.equal(ctl.state.payroll.phase, null);
  assert.deepEqual(calls.filter(url => !['/api/config', '/api/pass/info'].includes(url) && !url.startsWith('/api/engines/magicblock/info')), ['/api/rpc']);
});

test('recovery keeps missing or mismatched receipts unresolved and never resends', async t => {
  const batch = savedBatch(); delete batch.records[0].signature;
  const { ctl, calls } = await controller(t, batch, null);
  await ctl.reconcilePayroll();
  assert.equal(ctl.state.payroll.status, 'uncertain');
  assert.match(ctl.state.payroll.records[0].error, /attach it below/);
  assert.ok(!calls.includes('/api/rpc'), 'No invented signature lookup');
  ctl.state.payroll.records[0].signature = signature;
  await ctl.reconcilePayroll();
  assert.equal(ctl.state.payroll.records[0].status, 'uncertain');
  assert.match(ctl.state.payroll.records[0].error, /not be retried/);
});

test('RPC failure releases the recovery operation without clearing unresolved receipts or authorization', async t => {
  const { ctl, store } = await controller(t, savedBatch(), new Error('Unavailable'));
  assert.equal(await ctl.reconcilePayroll(), false);
  assert.equal(ctl.state.payroll.busy, false);
  assert.equal(ctl.state.payroll.phase, null);
  assert.equal(ctl.state.payroll.status, 'uncertain');
  assert.equal(ctl.state.payroll.records[0].signature, signature);
  assert.equal(ctl.state.payroll.authorized, true);
  assert.equal(JSON.parse(store.get('dm_payroll_v1')).records[0].status, 'uncertain');
});

test('progress explains each busy phase without changing batch state', () => {
  for (const phase of ['initializing', 'unlock', 'scan', 'screen', 'fees', 'recover', 'authorize', 'sending', 'reconcile']) {
    const batch = { ...savedBatch(), phase, operation: phase === 'reconcile' ? 'reconcile' : 'run' };
    const before = JSON.stringify(batch), progress = payrollProgress(batch);
    assert.ok(progress.label && progress.title && progress.detail);
    assert.doesNotMatch(progress.label, /Working/);
    assert.equal(JSON.stringify(batch), before);
  }
});

test('restored partial paid batch explains free review, skipped receipts and no additional pass', () => {
  const batch = { ...savedBatch(), busy: false, authorized: true, status: 'needs-review',
    payments: [{ recipient }, { recipient: owner }],
    records: [{ status: 'confirmed' }, { status: 'pending' }] };
  const progress = payrollProgress(batch);
  assert.match(progress.detail, /1\/2 payments confirmed; 1 remaining/);
  assert.match(progress.detail, /Review · free/);
  assert.match(progress.detail, /no additional pass/);
  assert.match(progress.detail, /Confirmed rows are skipped/);
  batch.records[1].status = 'uncertain';
  assert.match(payrollProgress(batch).detail, /never automatically resent/);
  batch.records[1].status = 'confirmed';
  assert.equal(payrollProgress(batch).label, 'Complete');
});
