import test from 'node:test';
import assert from 'node:assert/strict';
import { requestPremium, pendingPremium } from '../../public/assets/js/pass-spend.js';
import * as passes from '../../public/assets/js/passes.js';
import fs from 'node:fs';
import { createPremiumTools } from '../../public/assets/js/premium-tools.js';

test('browser premium journal survives result-save failure and recovers without consuming a second credit', async t => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const originalDispatch = globalThis.dispatchEvent;
  const originalWindow = globalThis.window;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
  globalThis.dispatchEvent = () => true;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name, _options, callback) => callback({}) } } });
  t.after(() => {
    globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; globalThis.dispatchEvent = originalDispatch;
    globalThis.window = originalWindow;
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
  });
  const pass = { kid: 'a'.repeat(16), msg: btoa('m'.repeat(32)), sig: btoa('s'.repeat(256)), demo: false };
  passes.add([pass]);
  const requests = new Map(); let charges = 0, calls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/ai-pack/plan'); calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.prompt, 'original plan');
    const recovered = requests.has(body.pass.requestId);
    if (!recovered) { charges++; requests.set(body.pass.requestId, true); }
    return new Response(JSON.stringify({ ok: true, feature: 'ai-pack', grant: 'b'.repeat(64), result: { payments: [] }, recovered }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const info = { enabled: true, kid: pass.kid, demo: false };
  await assert.rejects(requestPremium(info, 'ai-pack', { prompt: 'original plan' }, () => { throw new Error('disk full'); }), /disk full/);
  assert.ok(pendingPremium());
  assert.equal(passes.count(pass.kid), 1, 'Reserved credit is restored locally but retry journal prevents another plan');
  await assert.rejects(requestPremium(info, 'ai-pack', { prompt: 'different plan' }), /earlier premium request/);
  assert.equal(calls, 1);
  let persisted = false;
  const result = await requestPremium(info, 'ai-pack', { prompt: 'original plan' }, (response, journal) => {
    assert.equal(response.recovered, true);
    assert.equal(journal.pass.msg, pass.msg);
    assert.ok(pendingPremium(), 'Journal remains until caller saves result');
    persisted = true;
  });
  assert.equal(result.ok, true); assert.equal(persisted, true);
  assert.equal(charges, 1); assert.equal(pendingPremium(), null); assert.equal(passes.count(pass.kid), 0);
  // Actual controller failure must propagate a non-success outcome to its UI.
  passes.add([pass]);
  globalThis.fetch = async url => new Response(JSON.stringify(
    url.endsWith('/config') ? { limits: { SOL: 5, USDC: 500 }, liveSendEnabled: true }
      : url.endsWith('/pass/info') ? { ...info, features: { 'ai-pack': { enabled: true } } }
        : { error: 'Controlled provider failure' }
  ), { status: url.endsWith('/ai-pack/plan') ? 503 : 200, headers: { 'Content-Type': 'application/json' } });
  const controller = await createPremiumTools();
  assert.equal(await controller.generateAI('original plan'), false);
  assert.equal(controller.state.ai.error, 'Controlled provider failure');
  assert.equal(passes.count(pass.kid), 1);
});

test('page action wrapper never announces a successful plan for a failed controller result', async () => {
  const source = fs.readFileSync(new URL('../../public/assets/js/tools-page.js', import.meta.url), 'utf8');
  const action = source.match(/(async function act\(fn, okText\) \{[\s\S]+?\n\})\n/)[1];
  const messages = [], announcer = { textContent: 'stale success' };
  const act = new Function('announce', 'render', 'ctl', 'announcer',
    `let localErr = '', lastAnnounce = ''; ${action}; return act;`
  )(message => messages.push(message), () => {}, { state: {} }, announcer);
  await act(async () => false, 'Plan generated.');
  assert.deepEqual(messages, []);
  assert.equal(announcer.textContent, '');
  await act(async () => {}, 'Plan generated.');
  assert.deepEqual(messages, ['Plan generated.']);
});
