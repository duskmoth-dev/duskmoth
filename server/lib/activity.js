// Wallet activity from Solana mainnet, using only standard JSON-RPC methods:
// getBalance, getTokenAccountsByOwner (USDC), getSignaturesForAddress, getTransaction.
// Public chain data only. Nothing is stored.
import { fetchJson } from './util.js';

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const PRIVACY_CASH_PROGRAM = '9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD';
const DETAIL_LIMIT = 10;
const DAY = 86400;

export function rpcUrl() {
  return process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}

async function rpc(method, params) {
  const r = await fetchJson(rpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, 12000);
  if (!r.ok || r.body?.error) throw new Error(r.body?.error?.message || `rpc ${method} ${r.status}`);
  return r.body.result;
}

const keyOf = (k) => (typeof k === 'string' ? k : k?.pubkey);

/** Classify one parsed transaction from the owner's point of view. */
export function summarizeTx(tx, owner, sig) {
  if (!tx?.meta || !tx?.transaction?.message) throw new Error('Transaction details unavailable');
  const keys = (tx?.transaction?.message?.accountKeys || []).map(keyOf);
  const meta = tx?.meta || {};
  const i = keys.indexOf(owner);
  const feePayer = keys[0] === owner;
  const pre = meta.preBalances?.[i], post = meta.postBalances?.[i];
  let solDelta = i >= 0 && Number.isFinite(pre) && Number.isFinite(post) ? (post - pre) / 1e9 : 0;
  // the fee is part of the delta when the owner paid it; show it separately
  const fee = feePayer ? (meta.fee || 0) / 1e9 : 0;
  if (feePayer) solDelta += fee;
  const tok = (list) => (list || []).filter((b) => b.owner === owner && b.mint === USDC_MINT)
    .reduce((s, b) => s + Number(b.uiTokenAmount?.uiAmountString || 0), 0);
  const usdcDelta = tok(meta.postTokenBalances) - tok(meta.preTokenBalances);
  const programs = new Set((tx?.transaction?.message?.instructions || []).map((ix) => ix.programId).filter(Boolean));
  const privacy = keys.includes(PRIVACY_CASH_PROGRAM) || programs.has(PRIVACY_CASH_PROGRAM);

  let type = 'program';
  if (privacy) type = solDelta < 0 || usdcDelta < 0 ? 'shield' : 'unshield';
  else if (Math.abs(usdcDelta) > 0) type = usdcDelta > 0 ? 'receive' : 'send';
  else if (Math.abs(solDelta) >= 0.000001) type = solDelta > 0 ? 'receive' : 'send';

  return {
    signature: sig.signature,
    time: sig.blockTime ?? tx?.blockTime ?? null,
    ok: !sig.err,
    type,
    sol: Math.round(solDelta * 1e9) / 1e9,
    usdc: Math.round(usdcDelta * 1e6) / 1e6,
    fee,
  };
}

function stats(sigs, now) {
  const in30 = sigs.filter((s) => s.blockTime && now - s.blockTime <= 30 * DAY);
  const days = new Set(in30.map((s) => Math.floor(s.blockTime / DAY)));
  return {
    sampled: sigs.length,
    last30d: in30.length,
    activeDays30d: days.size,
    failed: sigs.filter((s) => s.err).length,
    lastActive: sigs[0]?.blockTime ?? null,
    oldestSampled: sigs[sigs.length - 1]?.blockTime ?? null,
  };
}

async function liveActivity(address) {
  const now = Math.floor(Date.now() / 1000);
  const [bal, usdcAccts, sigs] = await Promise.all([
    rpc('getBalance', [address, { commitment: 'confirmed' }]),
    rpc('getTokenAccountsByOwner', [address, { mint: USDC_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
    rpc('getSignaturesForAddress', [address, { limit: 100, commitment: 'confirmed' }]),
  ]);
  if (!Number.isFinite(bal?.value) || !Array.isArray(usdcAccts?.value) || !Array.isArray(sigs)) throw new Error('Incomplete RPC response');
  const usdc = usdcAccts.value.reduce((s, a) => s + Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmountString || 0), 0);
  const top = (sigs || []).slice(0, DETAIL_LIMIT);
  const txs = await Promise.all(top.map((s) =>
    rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])
      .then((tx) => summarizeTx(tx, address, s))
      .catch(() => ({ signature: s.signature, time: s.blockTime ?? null, ok: !s.err, type: 'unknown', detailsAvailable: false, sol: null, usdc: null, fee: null }))));
  return { sol: (bal?.value ?? 0) / 1e9, usdc, stats: stats(sigs || [], now), history: txs };
}

export async function walletActivity(address) {
  try {
    return { address, network: 'mainnet-beta', source: process.env.HELIUS_API_KEY ? 'helius-rpc' : 'public-rpc', ...(await liveActivity(address)) };
  } catch {
    return { address, network: 'mainnet-beta', source: 'unavailable', error: 'Mainnet RPC is unreachable right now. Try again shortly.', sol: null, usdc: null, stats: null, history: [] };
  }
}
