import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { sdkBrowserPlugin } from '../../live/sdk-browser-plugin.js';
import { sdkFetch, sdkLog, scanBatch, scanStorage, scanYield, withProgress, abortableRead } from '../../live/src/runtime.js';

const require = createRequire(import.meta.url);
const sdk = path.dirname(require.resolve('privacycash'));

test('installed SOL and SPL scan adapters yield without removing or skipping records', () => {
  const plugin = sdkBrowserPlugin();
  for (const name of ['getUtxos.js', 'getUtxosSPL.js']) {
    const file = path.join(sdk, name);
    const original = fs.readFileSync(file, 'utf8');
    const result = plugin.transform(original, file).code;
    assert.match(result, /processed\+\+ % 100/);
    assert.match(result, /await encryptionService.decryptUtxo/);
    assert.match(result, /sdkFetch\(url/);
    assert.doesNotMatch(result, /return await (isUtxoSpent|areUtxosSpent)\(/);
    assert.match(result, /scanBatch\(data\)/);
  }
  assert.throws(() => plugin.transform('export async function getUtxos() {}', path.join(sdk, 'getUtxos.js')), /contract changed/);
  const noteFile = path.join(sdk, 'models/utxo.js');
  const noteResult = plugin.transform(fs.readFileSync(noteFile, 'utf8'), noteFile).code;
  assert.doesNotMatch(noteResult, /console\.log/);
});

test('progress filters SDK private payloads and reports only safe phases/counters', async () => {
  const messages = [];
  await withProgress(message => messages.push(message), async () => {
    sdkLog('debug', 'sensitive wallet / UTXO / encryption fixture');
    sdkLog('info', 'unexpected private payload');
    sdkLog('info', 'generating ZK proof...');
    scanBatch({ start: 20000, total: 883060 });
    await scanYield(100, 20000);
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].phase, 'proof');
  assert.match(messages[1].detail, /20,100 of 883,060/);
  assert.doesNotMatch(JSON.stringify(messages), /sensitive|fixture|unexpected/);
  sdkLog('info', 'generating ZK proof...');
  assert.equal(messages.length, 2, 'listener is cleared after completion');
});

test('SDK requests have a deadline and service errors cannot look like success', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      return new Response('{}', { status: 503 });
    };
    await assert.rejects(sdkFetch('https://example.invalid'), /failed \(503\)/);
    globalThis.fetch = async () => { throw new Error('private network detail'); };
    await assert.rejects(sdkFetch('https://example.invalid'), /timed out or could not connect/);
  } finally { globalThis.fetch = original; }
});

test('interrupted scans never persist offsets ahead of their recovered notes', () => {
  const data = new Map([['fetch_offsetwallet', '100'], ['encrypted_outputswallet', '["existing"]']]);
  const persisted = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
  };
  const interrupted = scanStorage(persisted);
  interrupted.setItem('fetch_offsetwallet', '20000');
  assert.equal(interrupted.getItem('fetch_offsetwallet'), '20000');
  assert.equal(data.get('fetch_offsetwallet'), '100');
  const retry = scanStorage(persisted);
  assert.equal(retry.getItem('fetch_offsetwallet'), '100');
  retry.setItem('fetch_offsetwallet', '40000');
  retry.setItem('encrypted_outputswallet', '["existing","recovered"]');
  assert.equal(data.get('encrypted_outputswallet'), '["existing","recovered"]');
  assert.equal(data.get('fetch_offsetwallet'), '40000');
});

test('read cancellation interrupts wallet approval and pool requests and clears the operation signal', async () => {
  const original = globalThis.fetch;
  try {
    let controller = new AbortController();
    const message = withProgress(null, () => abortableRead(new Promise(() => {})), controller.signal);
    controller.abort(new Error('Stopped before sending'));
    await assert.rejects(message, /Stopped before sending/);
    controller = new AbortController();
    globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const request = withProgress(null, () => sdkFetch('https://offline.invalid/pool'), controller.signal);
    controller.abort(new Error('Stopped before sending'));
    await assert.rejects(request, /Stopped before sending/);
    await withProgress(null, () => scanYield(0, 1)); // Not poisoned by the aborted read.
    await assert.rejects(withProgress(null, () => scanYield(0, 1), controller.signal), /Stopped before sending/);
  } finally { globalThis.fetch = original; }
});
