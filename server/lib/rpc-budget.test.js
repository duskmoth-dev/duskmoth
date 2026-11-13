import test from 'node:test';
import assert from 'node:assert/strict';
import { apiBudget, rpcBudget } from './rpc-budget.js';

test('proof/RPC traffic cannot exhaust the ordinary API bucket, but remains bounded', () => {
  const api = apiBudget(), rpc = rpcBudget();
  function allowed(middleware, req) {
    let passed = false, status;
    const res = { setHeader() {}, status(code) { status = code; return this; }, json() {} };
    middleware({ ip: 'test', ...req }, res, () => { passed = true; });
    return { passed, status };
  }
  for (let i = 0; i < 40; i++) assert.equal(allowed(api, { path: '/config' }).passed, true);
  assert.equal(allowed(api, { path: '/config' }).status, 429);
  for (let i = 0; i < 120; i++) {
    assert.equal(allowed(api, { path: '/rpc' }).passed, true);
    assert.equal(allowed(rpc, { body: { method: 'getAccountInfo' } }).passed, true);
  }
  assert.equal(allowed(rpc, { body: { method: 'getAccountInfo' } }).status, 429);
  for (let i = 0; i < 8; i++) assert.equal(allowed(rpc, { body: { method: 'sendTransaction' } }).passed, true);
  assert.equal(allowed(rpc, { body: [{ method: 'getSlot' }, { method: 'sendTransaction' }] }).status, 429);
});
