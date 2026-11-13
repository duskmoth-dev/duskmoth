import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { InjectedWallet, providerAddress, detectWallets } from '../../public/assets/js/wallet.js';
import { createWalletSession } from '../../public/assets/js/wallet-session.js';
import { observeWallets, walletBrowserLinks, walletConnectionError } from '../../public/assets/js/wallet-discovery.js';

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
test('mobile and legacy window.solana aliases are discovered without duplicate providers', () => {
  const provider = { connect() {}, signMessage() {}, signTransaction() {}, isPhantom: true };
  assert.deepEqual(detectWallets({ solana: provider }).map(w => w.id), ['phantom']);
  assert.equal(detectWallets({ phantom: { solana: provider }, solana: provider }).length, 1);
  assert.equal(detectWallets({ phantom: { solana: {} } }).length, 0);
  for (const [flag, id] of [['isSolflare', 'solflare'], ['isBackpack', 'backpack']]) {
    assert.equal(detectWallets({ solana: { connect() {}, signMessage() {}, signTransaction() {}, [flag]: true } })[0].id, id);
  }
  const compatible = { ...provider, isBackpack: true };
  assert.equal(detectWallets({ backpack: compatible, solana: compatible })[0].id, 'backpack', 'compatibility flags must not relabel Backpack as Phantom');
});
test('repeated clicks share one pending approval and clear connecting state', async () => {
  const f = fixture(), statuses = [];
  let resolve, calls = 0;
  f.provider.connect = () => { calls++; return new Promise(done => { resolve = done; }); };
  const session = f.create({ onConnectingChange: pending => statuses.push(pending) });
  const a = session.connect('phantom'), b = session.connect('phantom');
  await assert.rejects(session.connect('solflare'), /already pending/);
  resolve({ publicKey: f.provider.publicKey });
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(calls, 1); assert.equal(f.changes.length, 1);
  assert.deepEqual(statuses, [true, false]);
});
test('manual approval remains valid after eight seconds without increasing silent-restore timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let resolve;
  f.provider.connect = () => new Promise(done => { resolve = done; });
  const pending = f.create().connect('phantom');
  t.mock.timers.tick(9000);
  resolve({ publicKey: f.provider.publicKey });
  assert.equal(await pending, true);
});
test('connection waits for the provider to publish its authorized account', async () => {
  const f = fixture(), key = f.provider.publicKey;
  f.provider.publicKey = null; f.provider.isConnected = false;
  f.provider.connect = async () => {
    setTimeout(() => { f.provider.publicKey = key; f.provider.isConnected = true; }, 15);
    return { publicKey: key };
  };
  assert.equal(await f.create().connect('phantom'), true);
  assert.equal(f.changes.at(-1).address, first);
});
test('rejected and timed-out approvals release UI state and permit retry', async () => {
  const f = fixture(), statuses = [], session = f.create({ timeout: 5, onConnectingChange: v => statuses.push(v) });
  f.provider.connect = async () => { throw Object.assign(new Error('User rejected'), { code: 4001 }); };
  await assert.rejects(session.connect('phantom'), /rejected/);
  assert.equal(statuses.at(-1), false);
  f.provider.connect = () => new Promise(() => {});
  await assert.rejects(session.connect('phantom'), /timed out/);
  assert.equal(statuses.at(-1), false);
  f.provider.connect = async () => ({ publicKey: f.provider.publicKey });
  assert.equal(await session.connect('phantom'), true);
});
test('denied preference storage does not prevent a verified live wallet connection', async () => {
  const f = fixture(), storage = { getItem() { throw Error('Blocked'); }, setItem() { throw Error('Blocked'); }, removeItem() { throw Error('Blocked'); } };
  const session = f.create({ storage });
  assert.equal(await session.restore(), false);
  assert.equal(await session.connect('phantom'), true);
  await session.disconnect(); assert.equal(f.changes.at(-1), null);
});
test('late injection updates discovery without requiring a page reload', () => {
  const root = new EventTarget(), lengths = [];
  root.document = new EventTarget();
  const stop = observeWallets(list => lengths.push(list.length), root);
  root.solana = { isPhantom: true, connect() {}, signMessage() {}, signTransaction() {} };
  root.dispatchEvent(new Event('solana#initialized'));
  delete root.solana; root.dispatchEvent(new Event('duskmoth:wallets-refresh'));
  stop(); assert.deepEqual(lengths, [0, 1, 0]);
});
test('mobile browse links use documented endpoints and do not forward query or fragment secrets', () => {
  const links = walletBrowserLinks({ navigator: { userAgent: 'iPhone' }, location: { origin: 'https://example.test', pathname: '/pass', search: '?secret=not-forwarded', hash: '#private-backup' } });
  assert.equal(links.length, 2);
  assert.ok(links[0].href.startsWith('https://phantom.com/ul/browse/'));
  assert.ok(links[1].href.startsWith('https://solflare.com/ul/v1/browse/'));
  assert.ok(links.every(l => l.href.includes(encodeURIComponent('https://example.test/pass')) && !l.href.includes('not-forwarded') && !l.href.includes('private-backup')));
});
test('a replacement provider cannot inherit a different provider’s validated identity', async () => {
  const f = fixture(); let replaced = false;
  const session = f.create({ makeWallet: id => replaced ? new InjectedWallet({ id, name: id, provider: {} }) : f.makeWallet(id) });
  await session.connect('phantom');
  replaced = true; f.provider.publicKey = { toString: () => second };
  f.provider.emit('accountChanged', f.provider.publicKey);
  assert.equal(f.changes.at(-1), null);
});
test('connection errors distinguish rejection and an already-open wallet request', () => {
  assert.match(walletConnectionError({ code: 4001 }), /declined/);
  assert.match(walletConnectionError({ code: -32002 }), /already open/);
  assert.match(walletConnectionError(new Error('timed out')), /Unlock/);
});
