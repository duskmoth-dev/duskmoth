import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { isAddress } from './util.js';

const MAX_AGE_MS = 5 * 60 * 1000;

/** The exact message the frontend asks the wallet to sign. Keep in sync with public/assets/js/wallet.js */
export function ownershipMessage(address, ts) {
  return `Duskmoth: prove I own ${address} to see my privacy score. Timestamp ${ts}. This costs nothing and moves no funds.`;
}

/** Verify an ed25519 signature that proves the caller controls `address`. */
export function verifyOwnership({ address, ts, signature }) {
  if (!isAddress(address)) return { ok: false, error: 'Invalid address.' };
  const t = Number(ts);
  if (!t || Math.abs(Date.now() - t) > MAX_AGE_MS) return { ok: false, error: 'Signature expired. Sign again.' };
  try {
    const msg = new TextEncoder().encode(ownershipMessage(address, t));
    const sig = bs58.decode(signature);
    const pub = bs58.decode(address);
    const ok = nacl.sign.detached.verify(msg, sig, pub);
    return ok ? { ok: true } : { ok: false, error: 'Signature does not match this wallet.' };
  } catch {
    return { ok: false, error: 'Could not read the signature.' };
  }
}
