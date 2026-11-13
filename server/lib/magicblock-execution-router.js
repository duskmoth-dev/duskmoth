import { Router } from 'express';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createHash, randomUUID } from 'node:crypto';
import { MagicBlockError, selectPrivacyEngine, validateMagicblockPayments } from './magicblock.js';
import { magicblockIntent, magicblockActionMessage } from '../../public/assets/js/magicblock-contract.js';
import { magicblockBinding } from './magicblock-ledger.js';
import { rateLimiter } from './util.js';
import { PassError } from './moth-pass.js';

export function magicblockExecutionRouter({ settings, ledger, passes, screen, log = e => process.stdout.write(`${JSON.stringify(e)}\n`) }) {
  const router = Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/health', async (req, res) => {
    try {
      selectPrivacyEngine({ requested: 'magicblock', asset: 'USDC', owner: req.query.owner }, settings);
      if (!settings.executionEnabled) throw new MagicBlockError(503, 'EXECUTION_DISABLED', 'MagicBlock mainnet execution is not enabled on this server.');
      await ledger.health();
      res.json({ enabled: true, cluster: 'mainnet-private', dailyLimitEnforced: true, phase: 'internal-mainnet',
        maxBatchUSDC: settings.maxBatch, maxDailyUSDC: settings.maxDaily, publicLaunchVerified: false });
    } catch (e) {
      res.status(e instanceof MagicBlockError ? e.status : 503).json({ enabled: false,
        error: e instanceof MagicBlockError ? e.message : 'MagicBlock storage is unavailable.' });
    }
  });
  for (const action of ['screen', 'reserve', 'authorize', 'pass-state', 'recover']) {
    router.post(`/${action}`, rateLimiter({ capacity: 6, refillPerSec: 0.05 }), async (req, res) => {
      const requestId = randomUUID(), started = Date.now();
      res.set('X-Request-ID', requestId);
      try {
        const owner = req.body?.intent?.owner;
        if (['recover', 'pass-state'].includes(action)) {
          if (!settings.allowlist.has(owner)) throw new MagicBlockError(403, 'NOT_ALLOWED', 'Connect the allowlisted wallet that owns this operation.');
        } else {
          selectPrivacyEngine({ requested: 'magicblock', asset: 'USDC', owner }, settings);
          if (!settings.executionEnabled) throw new MagicBlockError(503, 'EXECUTION_DISABLED', 'MagicBlock mainnet execution is not enabled on this server.');
        }
        const payments = validateMagicblockPayments(req.body?.intent?.payments, settings);
        let intent;
        try { intent = magicblockIntent({ ...req.body.intent, payments }); }
        catch (e) { throw new MagicBlockError(400, 'INVALID_INTENT', e.message); }
        const proof = req.body.proof;
        let valid = false;
        try {
          valid = Number.isSafeInteger(proof.ts) && Math.abs(Date.now() - proof.ts) < 120000
            && nacl.sign.detached.verify(new TextEncoder().encode(magicblockActionMessage(action, intent, proof.ts)), bs58.decode(proof.signature), bs58.decode(owner));
        } catch {}
        if (!valid) throw new MagicBlockError(401, 'OWNERSHIP_REQUIRED', 'Approve the exact MagicBlock plan with its owner wallet.');
        if (action === 'recover') {
          const row = await ledger.operation(intent);
          res.json({ ok: true, verified: true, authorized: !!row.grant });
        } else if (action === 'pass-state') {
          if (intent.kind !== 'payroll') throw new MagicBlockError(400, 'PASS_NOT_REQUIRED', 'This action does not cost a pass.');
          const row = await ledger.operation(intent);
          const checked = await passes.check({ ...req.body.pass, feature: 'private-payroll', requestId: intent.id }, { binding: magicblockBinding(intent) });
          res.json({ ok: true, spent: checked.spent, authorized: !!row.grant });
        } else if (action !== 'authorize') {
          for (const p of payments) {
            const result = await screen({ sender: owner, recipient: p.recipient });
            if (!result?.allowed || result.source !== 'scorechain' || result.scope !== 'sanctions-only') throw new MagicBlockError(503, 'SCREENING_INCOMPLETE', 'Screening did not pass for every recipient. No new deposit or pass charge was made.');
          }
          if (action === 'reserve') {
            const previous = await ledger.operation(intent).catch(e => { if (e.code === 'RESERVATION_REQUIRED') return null; throw e; });
            if (intent.kind === 'payroll' && !previous?.grant) await passes.check({ ...req.body.pass, feature: 'private-payroll', requestId: intent.id }, { binding: magicblockBinding(intent) });
            await ledger.reserve(intent, settings.maxDaily);
          }
          res.json({ ok: true, action, binding: magicblockBinding(intent), checkedAt: new Date().toISOString() });
        } else {
          if (intent.kind !== 'payroll') throw new MagicBlockError(400, 'PASS_NOT_REQUIRED', 'This action does not cost a Moth Pass.');
          const binding = magicblockBinding(intent);
          const previous = await ledger.operation(intent);
          if (previous.grant) { res.json({ ok: true, grant: previous.grant, recovered: true }); return; }
          const pass = req.body.pass;
          // Persist the original pass choice before redemption. A crash between
          // redemption and grant storage must never charge a replacement pass.
          await passes.check({ ...pass, feature: 'private-payroll', requestId: intent.id }, { binding });
          const passKey = createHash('sha256').update(String(pass.msg)).digest('hex');
          const claimed = await ledger.claimPass(intent, passKey);
          if (claimed.grant) { res.json({ ok: true, grant: claimed.grant, recovered: true }); return; }
          const result = await passes.redeem({ ...pass, feature: 'private-payroll', requestId: intent.id }, { binding });
          await ledger.saveGrant(intent, result.grant);
          res.json(result);
        }
        log({ event: `magicblock_${action}`, requestId, outcome: 'ok', durationMs: Date.now() - started });
      } catch (e) {
        const status = e instanceof MagicBlockError || e instanceof PassError ? e.status : 503;
        log({ event: `magicblock_${action}`, requestId, status, code: e instanceof MagicBlockError ? e.code : 'UNAVAILABLE', durationMs: Date.now() - started });
        res.status(status).json({ error: e instanceof MagicBlockError || e instanceof PassError ? e.message : 'MagicBlock preparation is unavailable. Keep the saved operation and retry.', requestId });
      }
    });
  }
  return router;
}
