// Injected Solana wallets only. Keys never leave the wallet.
const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes) {
  const digits = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const byte of bytes) { if (byte === 0) out += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHA[digits[i]];
  return out;
}

export function ownershipMessage(address, ts) {
  return `Duskmoth: prove I own ${address} to see my privacy score. Timestamp ${ts}. This costs nothing and moves no funds.`;
}

export function detectWallets() {
  const w = window;
  const list = [];
  if (w.phantom?.solana?.isPhantom) list.push({ id: 'phantom', name: 'Phantom', provider: w.phantom.solana });
  if (w.solflare?.isSolflare) list.push({ id: 'solflare', name: 'Solflare', provider: w.solflare });
  if (w.backpack?.isBackpack || w.backpack?.solana) list.push({ id: 'backpack', name: 'Backpack', provider: w.backpack.solana || w.backpack });
  return list;
}

export function providerAddress(provider, key = provider?.publicKey) {
  const address = key?.toString();
  if (provider?.isConnected === false || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address || '')) throw new Error('Wallet connection is not valid.');
  let value = 0n;
  for (const char of address) value = value * 58n + BigInt(ALPHA.indexOf(char));
  let bytes = 0;
  while (value > 0n) { bytes++; value >>= 8n; }
  bytes += address.match(/^1*/)[0].length;
  if (bytes !== 32 || provider.publicKey?.toString() !== address) throw new Error('Wallet account could not be verified.');
  return address;
}

export class InjectedWallet {
  constructor({ id, name, provider }) { this.id = id; this.name = name; this.provider = provider; this.address = null; this.demo = false; }
  async connect(options) {
    const res = await this.provider.connect(options);
    this.address = providerAddress(this.provider, res?.publicKey || this.provider.publicKey);
    return this.address;
  }
  async disconnect() { try { await this.provider.disconnect(); } catch {} this.address = null; }
  async signMessage(text) {
    const bytes = new TextEncoder().encode(text);
    const out = await this.provider.signMessage(bytes, 'utf8');
    const sig = out?.signature || out;
    return new Uint8Array(sig);
  }
  async signTransaction(tx) { return this.provider.signTransaction(tx); }
}

export function makeWallet(id) {
  if (id === 'demo') return null;
  const found = detectWallets().find((w) => w.id === id);
  return found ? new InjectedWallet(found) : null;
}

/** Sign the ownership message and return the payload /api/score expects. */
export async function proveOwnership(wallet) {
  const ts = Date.now();
  const sig = await wallet.signMessage(ownershipMessage(wallet.address, ts));
  return { address: wallet.address, ts, signature: b58encode(sig) };
}
