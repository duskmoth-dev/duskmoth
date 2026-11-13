import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import adapter from '../../vendor/bigint-buffer/index.cjs';

test('unsigned byte conversion matches independent BigInt arithmetic in both byte orders', () => {
  for (const width of [0, 1, 2, 8, 16, 24, 32, 128]) {
    for (let i = 0; i < 12; i++) {
      const bytes = randomBytes(width);
      const original = Buffer.from(bytes);
      let be = 0n, le = 0n;
      for (let j = 0; j < width; j++) {
        be = (be << 8n) + BigInt(bytes[j]);
        le += BigInt(bytes[j]) << BigInt(8 * j);
      }
      assert.equal(adapter.toBigIntBE(bytes), be);
      assert.equal(adapter.toBigIntLE(bytes), le);
      assert.deepEqual(adapter.toBufferBE(be, width), original);
      assert.deepEqual(adapter.toBufferLE(le, width), original);
      assert.deepEqual(bytes, original);
    }
  }
});

test('byte adapter rejects overflow, signed values, invalid types and oversized allocations', () => {
  for (const fn of [adapter.toBufferBE, adapter.toBufferLE]) {
    assert.deepEqual(fn(0n, 0), Buffer.alloc(0));
    assert.deepEqual(fn(255n, 1), Buffer.from([255]));
    for (const [value, width] of [[256n, 1], [-1n, 8], [1n, 0], [0n, -1], [0n, 0.5], [0n, Infinity], [0n, 1048577], [0n, NaN]]) {
      assert.throws(() => fn(value, width), RangeError);
    }
    assert.throws(() => fn(1, 8), TypeError);
  }
  for (const fn of [adapter.toBigIntBE, adapter.toBigIntLE]) {
    assert.throws(() => fn('ff'), TypeError);
    assert.throws(() => fn(Buffer.alloc(1048577)), RangeError);
    assert.equal(fn(Buffer.alloc(4096, 255)), (1n << 32768n) - 1n);
  }
});

test('Solana account layouts resolve the safe adapter and preserve integer encoding', async () => {
  const require = createRequire(import.meta.url);
  const sdkRequire = createRequire(require.resolve('privacycash'));
  const splRequire = createRequire(sdkRequire.resolve('@solana/spl-token'));
  const layoutRequire = createRequire(splRequire.resolve('@solana/buffer-layout-utils'));
  const installed = layoutRequire('bigint-buffer');
  assert.deepEqual(Object.keys(installed).sort(), Object.keys(adapter).sort());
  // pnpm copies file dependencies into its store; verify source, not object identity.
  assert.equal(readFileSync(layoutRequire.resolve('bigint-buffer'), 'utf8'),
    readFileSync(new URL('../../vendor/bigint-buffer/index.cjs', import.meta.url), 'utf8'));
  const layouts = splRequire('@solana/buffer-layout-utils');
  for (const [name, width] of [['u64', 8], ['u128', 16], ['u192', 24], ['u256', 32]]) {
    for (const suffix of ['', 'be']) {
      const layout = layouts[name + suffix]();
      for (const value of [0n, 1n, (1n << BigInt(width * 8)) - 1n]) {
        const bytes = Buffer.alloc(width + 4, 0x5a);
        assert.equal(layout.encode(value, bytes, 2), width);
        assert.equal(layout.decode(bytes, 2), value);
        assert.equal(bytes[0], 0x5a);
        assert.equal(bytes.at(-1), 0x5a);
      }
      assert.throws(() => layout.encode(1n << BigInt(width * 8), Buffer.alloc(width)), RangeError);
    }
  }
});
