import { Transaction, PublicKey } from '@solana/web3.js';
import { MAGICBLOCK_ORIGIN, MAGICBLOCK_USDC, MAGICBLOCK_TRUST, magicblockPayload } from '../../public/assets/js/magicblock-contract.js';
import { payrollAddress, validatePayments } from '../../public/assets/js/payroll.js';

export class MagicBlockError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new MagicBlockError(status, code, message); };
export function magicblockSettings(env = process.env) {
  const allowlist = new Set(String(env.MAGICBLOCK_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean));
  const enabled = env.ENGINE_MAGICBLOCK_ENABLED === 'true';
  const base = String(env.MAGICBLOCK_API_BASE || MAGICBLOCK_ORIGIN).replace(/\/$/, '');
  const cluster = env.MAGICBLOCK_CLUSTER || 'mainnet-private';
  const maxBatch = Number(env.MAGICBLOCK_MAX_BATCH_USDC || 500);
  const maxDaily = Number(env.MAGICBLOCK_MAX_DAILY_USDC || 2000);
  const timeout = Number(env.MAGICBLOCK_TIMEOUT_MS || 8000);
  const valid = base === MAGICBLOCK_ORIGIN && cluster === 'mainnet-private'
    && (env.USDC_MINT || MAGICBLOCK_USDC) === MAGICBLOCK_USDC
    && allowlist.size > 0 && [...allowlist].every(payrollAddress)
    && Number.isFinite(maxBatch) && maxBatch > 0 && maxBatch <= 500
    && Number.isFinite(maxDaily) && maxDaily >= maxBatch && maxDaily <= 2000
    && Number.isSafeInteger(timeout) && timeout >= 1000 && timeout <= 15000;
  return { enabled: enabled && valid, executionEnabled: enabled && valid && env.MAGICBLOCK_EXECUTION_ENABLED === 'true',
    requested: enabled, allowlist, base, cluster, maxBatch, maxDaily, timeout,
    reason: !enabled ? 'MagicBlock internal review is disabled.' : !valid ? 'MagicBlock beta configuration is incomplete or invalid.' : null };
}
export function selectPrivacyEngine({ requested = 'privacycash', asset, owner }, settings) {
  if (requested === 'privacycash' && ['SOL', 'USDC'].includes(asset)) return 'privacycash';
  if (requested !== 'magicblock' || asset !== 'USDC') fail(400, 'UNSUPPORTED_ENGINE', 'This engine does not support that asset.');
  if (!settings.enabled) fail(503, 'ENGINE_DISABLED', settings.reason);
  if (!settings.allowlist.has(owner)) fail(403, 'BETA_WALLET_REQUIRED', 'This wallet is not enabled for the MagicBlock internal beta.');
  return 'magicblock';
}
export function magicblockInfo(settings) {
  return { id: 'magicblock', asset: 'USDC', reviewEnabled: settings.enabled, executionEnabled: false,
    phase: 'internal-unsigned-review', reason: settings.reason, cluster: 'mainnet-private',
    trustModel: 'tee-rollup', trustNotice: MAGICBLOCK_TRUST, requiresAllowlist: true,
    maxBatchUSDC: settings.maxBatch, plannedDailyLimitUSDC: settings.maxDaily,
    dailyLimitEnforced: false, duskmothFee: 0,
    executionReason: 'Transaction instruction verification, durable execution limits, private settlement recovery and mainnet acceptance evidence are not complete. No signing or submission is available.',
  };
}
export function validateMagicblockPayments(payments, settings) {
  let canonical;
  try { canonical = validatePayments(payments, { SOL: 5, USDC: settings.maxBatch }); }
  catch (error) { fail(400, 'INVALID_BATCH', error.message); }
  if (canonical.some(row => row.token !== 'USDC')) fail(400, 'USDC_ONLY', 'MagicBlock internal review supports USDC only.');
  return canonical;
}
// Structural inspection is NOT instruction-level verification and does not permit signing.
export function inspectUnsignedMagicblock(body, owner) {
  try {
    if (body?.kind !== 'transfer' || body.version !== 'legacy' || body.sendTo !== 'base'
      || !Number.isSafeInteger(body.lastValidBlockHeight) || body.lastValidBlockHeight < 1
      || typeof body.transactionBase64 !== 'string' || body.transactionBase64.length > 20000
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.transactionBase64)) throw new Error();
    const bytes = Buffer.from(body.transactionBase64, 'base64');
    if (bytes.toString('base64') !== body.transactionBase64) throw new Error();
    const tx = Transaction.from(bytes);
    if (tx.feePayer?.toBase58() !== owner || tx.recentBlockhash !== body.recentBlockhash
      || tx.signatures.length !== 1 || tx.signatures[0].publicKey.toBase58() !== owner
      || tx.signatures.some(row => row.signature !== null)
      || body.instructionCount !== tx.instructions.length
      || !Array.isArray(body.requiredSigners) || body.requiredSigners.length !== 1 || body.requiredSigners[0] !== owner) throw new Error();
    new PublicKey(MAGICBLOCK_USDC);
    const fees = body.fees;
    if (!fees || !['lamports', 'tokens'].every(k => typeof fees[k] === 'string' && /^\d{1,20}$/.test(fees[k]))) throw new Error();
    return {
      operationLamports: fees.lamports, operationTokenUnits: fees.tokens,
      transactionVersion: body.version, sendTo: body.sendTo,
      instructionCount: tx.instructions.length, instructionVerification: 'not-complete',
      approvalReady: false,
    };
  } catch { fail(502, 'INVALID_UNSIGNED_TRANSACTION', 'MagicBlock returned an unsigned transaction that could not be inspected. No signature was requested.'); }
}
export function createMagicblockAdapter({ settings = magicblockSettings(), fetchImpl = fetch } = {}) {
  async function call(path, body, signal) {
    try {
      const response = await fetchImpl(`${MAGICBLOCK_ORIGIN}${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(settings.timeout)]) : AbortSignal.timeout(settings.timeout),
      });
      if (!response.ok) fail(response.status === 429 ? 429 : 502, 'UPSTREAM_UNAVAILABLE', 'MagicBlock could not complete this request. Nothing was submitted.');
      const value = await response.json();
      if (!value || value.error) throw new Error();
      return value;
    } catch (error) {
      if (error instanceof MagicBlockError) throw error;
      fail(502, 'UPSTREAM_UNAVAILABLE', 'MagicBlock did not return a verified response. Nothing was submitted.');
    }
  }
  return {
    async health(signal) {
      const body = await call('/health', null, signal);
      if (body.status !== 'ok') fail(502, 'UPSTREAM_UNAVAILABLE', 'MagicBlock health could not be verified.');
      return { status: 'ok' };
    },
    async reviewTransfer(owner, payment, signal) {
      const body = await call('/v1/spl/transfer', magicblockPayload('transfer', owner, Math.round(payment.amount * 1e6), payment.recipient), signal);
      const inspected = inspectUnsignedMagicblock(body, owner);
      if (BigInt(inspected.operationTokenUnits) >= BigInt(Math.round(payment.amount * 1e6))) {
        fail(502, 'INVALID_FEES', 'MagicBlock returned fees that do not leave a positive recipient amount. No signature was requested.');
      }
      return inspected;
    },
  };
}
