// Shared review contract. No token, key, balance, or transaction is persisted.
export const MAGICBLOCK_ORIGIN = 'https://payments.magicblock.app';
export const MAGICBLOCK_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const MAGICBLOCK_TRUST = 'Engine: Private Ephemeral Rollup (hardware TEE). Different from a ZK shielded pool.';
export const MAGICBLOCK_RPC = 'https://mainnet-tee.magicblock.app';
export function magicblockIntent({ id, owner, kind, source, payments, refs }) {
  if (!/^[a-f0-9]{32}$/.test(id) || !['send', 'payroll', 'deposit', 'withdraw'].includes(kind)
    || !['base', 'ephemeral'].includes(source) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) throw new Error('Invalid MagicBlock operation.');
  if (!Array.isArray(payments) || !payments.length || payments.some(p => p.token !== 'USDC')) throw new Error('USDC payments are required.');
  if (kind !== 'payroll' && payments.length !== 1) throw new Error('This operation accepts one recipient.');
  if (['deposit', 'withdraw'].includes(kind) && payments[0].recipient !== owner) throw new Error('Deposits and withdrawals return to the connected wallet only.');
  if (kind === 'deposit' && source !== 'base' || kind === 'withdraw' && source !== 'ephemeral') throw new Error('Invalid funding source.');
  if (!Array.isArray(refs) || refs.length !== payments.length || refs.some(r => !Number.isInteger(r.nonce) || r.nonce < 0 || r.nonce > 4294967295
    || !/^\d{1,20}$/.test(r.clientRefId) || BigInt(r.clientRefId) < 1n || BigInt(r.clientRefId) > 18446744073709551615n)
    || new Set(refs.map(r => r.nonce)).size !== refs.length || new Set(refs.map(r => r.clientRefId)).size !== refs.length) throw new Error('Invalid payment recovery references.');
  return { id, owner, kind, source, payments: payments.map(p => ({ recipient: p.recipient, amount: p.amount, token: 'USDC' })),
    refs: refs.map(r => ({ nonce: r.nonce, clientRefId: r.clientRefId })) };
}
export function magicblockActionMessage(action, intent, ts) {
  return `Duskmoth MagicBlock ${action}\n${JSON.stringify(magicblockIntent(intent))}\nTimestamp: ${ts}\nUSDC on mainnet-private. This message does not sign a blockchain transaction.`;
}
export function formatMagicblockUnits(value, decimals = 6) {
  const n = BigInt(value), base = 10n ** BigInt(decimals);
  const fraction = (n % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${n / base}${fraction ? `.${fraction}` : ''}`;
}
export function magicblockReviewMessage(owner, ts, payments) {
  return `Duskmoth MagicBlock internal review\nWallet: ${owner}\nTimestamp: ${ts}\nPayments: ${JSON.stringify(payments)}\nBuild unsigned private USDC transactions for review only. No deposit, payment, or Moth Pass is submitted.`;
}
export function magicblockPayload(kind, owner, amount, recipient) {
  if (!['deposit', 'transfer', 'withdraw'].includes(kind)) throw new Error('Unsupported MagicBlock operation.');
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Invalid USDC base-unit amount.');
  const common = { cluster: 'mainnet-private', mint: MAGICBLOCK_USDC, amount, gasless: false };
  if (kind === 'transfer') return {
    ...common, from: owner, to: recipient, visibility: 'private',
    fromBalance: 'base', toBalance: 'base', legacy: true,
    exactOut: false, platformFeeBps: 0,
    minDelayMs: '0', maxDelayMs: '0', split: 1,
  };
  return { ...common, owner, ...(kind === 'deposit' ? { private: true } : {}), idempotent: true };
}
