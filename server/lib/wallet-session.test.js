import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { InjectedWallet, providerAddress } from '../../public/assets/js/wallet.js';
import { createWalletSession } from '../../public/assets/js/wallet-session.js';

const first = 'So11111111111111111111111111111111111111112';
const second = '11111111111111111111111111111111';
function fixture() {
  const items = new Map(), changes = [], calls = [];
  const provider = new EventEmitter();
  provider.publicKey = { toString: () => first };
  provider.isConnected = true;
  provider.connect = async options => { calls.push(options); return { publicKey: provider.publicKey }; };
  provider.disconnect = async () => { provider.isConnected = false; provider.emit('disconnect'); };
  const storage = { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key) };
  const makeWallet = id => new InjectedWallet({ id, name: id, provider });
  const create = options => createWalletSession({ makeWallet, storage, onChange: w => changes.push(w), ...options });
  return { provider, items, calls, changes, storage, makeWallet, create };
}
test('refresh restores only the saved wallet with trusted-only permission and revalidates its address', async () => {
  const f = fixture();
  await f.create().connect('phantom');
  assert.equal(f.items.get('dm_wallet'), 'phantom');
  assert.equal(f.calls[0], undefined);
  assert.equal(await f.create().restore(), true);
  assert.deepEqual(f.calls[1], { onlyIfTrusted: true });
  assert.equal(f.changes.at(-1).address, first);
  assert.equal([...f.items.keys()].length, 1, 'no cached address or key is persisted');
});
test('explicit disconnect clears immediately and remains disconnected after refresh', async () => {
  const f = fixture(), session = f.create();
  await session.connect('phantom');
  await session.disconnect();
  assert.equal(f.changes.at(-1), null);
  assert.equal(f.items.get('dm_wallet'), undefined);
  assert.equal(await f.create().restore(), false);
  assert.equal(f.provider.listenerCount('accountChanged'), 0);
});
test('denied silent restore does not fall back to prompting or adopt cached identity', async () => {
  const f = fixture();
  f.items.set('dm_wallet', 'phantom');
  f.provider.connect = async options => { f.calls.push(options); throw new Error('Not trusted'); };
  assert.equal(await f.create().restore(), false);
  assert.equal(f.changes.length, 0);
  assert.deepEqual(f.calls, [{ onlyIfTrusted: true }]);
});
test('account switching produces a new identity; revoked account clears the session', async () => {
  const f = fixture(), session = f.create();
  await session.connect('phantom');
  const previous = f.changes.at(-1);
  f.provider.publicKey = { toString: () => second };
  f.provider.emit('accountChanged', f.provider.publicKey);
  assert.equal(f.changes.at(-1).address, second);
  assert.notEqual(f.changes.at(-1), previous);
  f.provider.emit('accountChanged', null);
  assert.equal(f.changes.at(-1), null);
  assert.equal(f.items.get('dm_wallet'), undefined);
});
test('provider disconnect events and focus validation never leave a stale account connected', async () => {
  const f = fixture(), session = f.create();
  await session.connect('phantom');
  f.provider.isConnected = false;
  session.validate();
  assert.equal(f.changes.at(-1), null);
  f.provider.isConnected = true;
  await session.connect('phantom');
  f.provider.emit('disconnect');
  assert.equal(f.changes.at(-1), null);
});
test('late connect responses cannot reconnect after explicit disconnect', async () => {
  const f = fixture(), session = f.create();
  let resolve;
  f.provider.connect = () => new Promise(done => { resolve = done; });
  const pending = session.connect('phantom');
  await session.disconnect();
  resolve({ publicKey: f.provider.publicKey });
  assert.equal(await pending, false);
  assert.equal(f.changes.at(-1), null);
  assert.equal(f.items.get('dm_wallet'), undefined);
});
test('invalid or mismatched extension identities are rejected', async () => {
  const f = fixture();
  assert.throws(() => providerAddress(f.provider, { toString: () => second }), /verified/);
  f.provider.publicKey = { toString: () => 'not-a-solana-address' };
  await assert.rejects(f.create().connect('phantom'), /not valid/);
  assert.equal(f.changes.length, 0);
});
test('delayed extension injection is allowed, but missing or hanging extensions do not fake a connection', async () => {
  const f = fixture();
  f.items.set('dm_wallet', 'phantom');
  let available = false;
  const session = f.create({ makeWallet: id => available ? f.makeWallet(id) : null });
  const timer = setTimeout(() => { available = true; }, 20);
  assert.equal(await session.restore({ waitMs: 150 }), true);
  clearTimeout(timer);
  f.provider.connect = () => new Promise(() => {});
  assert.equal(await f.create({ timeout: 5 }).restore({ waitMs: 0 }), false);
});
