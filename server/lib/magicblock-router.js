import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { magicblockReviewMessage } from '../../public/assets/js/magicblock-contract.js';
import { MagicBlockError, magicblockSettings, magicblockInfo, selectPrivacyEngine, validateMagicblockPayments, createMagicblockAdapter } from './magicblock.js';
import { rateLimiter } from './util.js';

export function magicblockRouter({ settings = magicblockSettings(), adapter = createMagicblockAdapter({ settings }),
  screen, execution, log = event => process.stdout.write(`${JSON.stringify(event)}\n`) } = {}) {
  const router = Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/info', async (req, res) => {
    const eligible = settings.enabled && settings.allowlist.has(req.query.owner);
    let active = false;
    if (eligible && settings.executionEnabled && execution) {
      try { active = !!await execution(); } catch {}
    }
    res.json({ ...magicblockInfo(settings), reviewEnabled: eligible,
      ...(execution ? { executionEnabled: active, phase: active ? 'internal-mainnet' : 'internal-unsigned-review',
        dailyLimitEnforced: active, publicLaunchVerified: false,
        executionReason: active ? 'Internal wallet-approved mainnet execution. Public acceptance gates are not complete.' : 'Internal execution is disabled or durable storage is unavailable.' } : {}) });
  });
  router.post('/review', rateLimiter({ capacity: 3, refillPerSec: 0.02 }), async (req, res) => {
    const requestId = randomUUID(), started = Date.now();
    res.set('X-Request-ID', requestId);
    const cancellation = new AbortController();
    const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(60000)]);
    const closed = () => { if (!res.writableEnded) cancellation.abort(); };
    res.once('close', closed);
    try {
      const owner = req.body?.owner;
      selectPrivacyEngine({ requested: 'magicblock', asset: 'USDC', owner }, settings);
      const payments = validateMagicblockPayments(req.body?.payments, settings);
      const proof = req.body?.proof, ts = proof?.ts;
      let verified = false;
      try {
        verified = Number.isSafeInteger(ts) && Math.abs(Date.now() - ts) <= 120000
          && nacl.sign.detached.verify(new TextEncoder().encode(magicblockReviewMessage(owner, ts, payments)), bs58.decode(proof.signature), bs58.decode(owner));
      } catch {}
      if (!verified) throw new MagicBlockError(401, 'OWNERSHIP_REQUIRED', 'Approve the internal review message with the batch owner wallet.');
      // Complete every recipient check before contacting any transaction builder.
      for (const payment of payments) {
        signal.throwIfAborted();
        const result = await screen({ sender: owner, recipient: payment.recipient });
        signal.throwIfAborted();
        if (result?.allowed !== true || result.source !== 'scorechain' || result.scope !== 'sanctions-only') {
          throw new MagicBlockError(503, 'SCREENING_INCOMPLETE', 'Screening did not pass for every recipient. No MagicBlock transaction was built, no deposit was made, and no pass was spent.');
        }
      }
      await adapter.health(signal);
      const rows = [];
      for (const payment of payments) {
        if (signal.aborted) throw new MagicBlockError(408, 'REVIEW_CANCELLED', 'Review was cancelled. Nothing was submitted.');
        rows.push(await adapter.reviewTransfer(owner, payment, signal));
      }
      const sum = key => rows.reduce((total, row) => total + BigInt(row[key]), 0n).toString();
      res.json({ engine: 'magicblock', asset: 'USDC', mode: 'unsigned-review-only',
        rows, operationLamports: sum('operationLamports'), operationTokenUnits: sum('operationTokenUnits'),
        networkLamports: null, accountRentLamports: null, totalCostVerified: false,
        approvalReady: false, duskmothFee: 0, passSpent: false, depositMade: false, transactionSubmitted: false,
        checkedAt: new Date().toISOString(), requestId,
      });
      log({ event: 'magicblock_review', requestId, outcome: 'reviewed-not-submitted', durationMs: Date.now() - started });
    } catch (error) {
      const status = error instanceof MagicBlockError ? error.status : 503;
      log({ event: 'magicblock_review', requestId, status, code: error instanceof MagicBlockError ? error.code : 'UNAVAILABLE', durationMs: Date.now() - started });
      if (!res.destroyed) res.status(status).json({
        error: error instanceof MagicBlockError ? error.message : 'MagicBlock internal review is unavailable. Nothing was submitted.',
        code: error instanceof MagicBlockError ? error.code : 'UNAVAILABLE', requestId,
      });
    } finally { res.removeListener('close', closed); }
  });
  return router;
}
