'use strict';
// Original implementation: no native bindings and no copied bigint-buffer code.
const { Buffer } = require('buffer');
const MAX_BYTES = 1024 * 1024;

function checkBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected unsigned bytes.');
  if (bytes.byteLength > MAX_BYTES) throw new RangeError('Byte input is too large.');
}

function toBigIntBE(bytes) {
  checkBytes(bytes);
  if (!bytes.byteLength) return 0n;
  return BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
}

function toBigIntLE(bytes) {
  checkBytes(bytes);
  // Copy before reversing: never mutate a shared account buffer.
  return toBigIntBE(Buffer.from(bytes).reverse());
}

function toBufferBE(value, width) {
  if (typeof value !== 'bigint') throw new TypeError('Expected a BigInt.');
  if (!Number.isSafeInteger(width) || width < 0 || width > MAX_BYTES) {
    throw new RangeError('Invalid byte width.');
  }
  if (value < 0n) throw new RangeError('Expected an unsigned BigInt.');
  const hex = value.toString(16);
  if ((width === 0 && value !== 0n) || (width > 0 && hex.length > width * 2)) {
    throw new RangeError('BigInt does not fit the requested byte width.');
  }
  if (width === 0) return Buffer.alloc(0);
  return Buffer.from(hex.padStart(width * 2, '0'), 'hex');
}

function toBufferLE(value, width) {
  return toBufferBE(value, width).reverse();
}

module.exports = { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE };
