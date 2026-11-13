import test from 'node:test';
import assert from 'node:assert/strict';
import * as passes from '../../public/assets/js/passes.js';
const map = new Map();
globalThis.localStorage = {
  getItem: key => map.get(key) || null,
  setItem: (key, value) => map.set(key, value),
  removeItem: key => map.delete(key),
};
globalThis.dispatchEvent ||= () => true;
const pass = (n, demo = false) => ({ kid: '1234567890abcdef', msg: Buffer.alloc(64, n).toString('base64'), sig: Buffer.alloc(256, n).toString('base64'), demo, at: Date.now() });
test('local bearer storage deduplicates, reserves and restores without inventing valid credits', async () => {
  map.clear();
  passes.add([pass(1), pass(2), pass(1)]);
  assert.equal(passes.count('1234567890abcdef'), 2);
  const selected = passes.take('1234567890abcdef');
  assert.equal(passes.count('1234567890abcdef'), 1);
  passes.restore(selected);
  assert.equal(passes.count('1234567890abcdef'), 2);
  const backup = JSON.parse(await passes.exportBlob().text());
  assert.equal(backup.type, 'duskmoth-moth-pass'); assert.equal(backup.passes.length, 2);
  passes.add([pass(3, true)]);
  assert.equal(passes.count('1234567890abcdef', false), 2);
  assert.equal(passes.count('1234567890abcdef', true), 1);
});
test('corrupt or conflicting bearer data is rejected without resetting to zero', () => {
  map.clear(); passes.add([pass(1)]);
  assert.throws(() => passes.add([{ ...pass(1), sig: pass(2).sig }]), /Conflicting/);
  assert.equal(passes.all().length, 1);
  map.set('dm_passes', '{broken');
  assert.throws(() => passes.count(), /could not be read/);
  assert.equal(map.get('dm_passes'), '{broken');
});
