import { Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { PassError } from './moth-pass.js';
import { generatePack, packPrompt } from './ai-pack.js';
import { validatePayments } from '../../public/assets/js/payroll.js';
import { rateLimiter } from './util.js';

export function premiumRouter(passes, { generate = generatePack } = {}) {
  const router = Router();
  const premiumBudget = rateLimiter({ capacity: 5, refillPerSec: 0.05 });
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  for (const [path, feature] of [['/ai-pack/plan', 'ai-pack'], ['/payroll/authorize', 'private-payroll']]) {
    router.post(path, premiumBudget, async (req, res) => {
      const requestId = randomUUID(), started = Date.now();
      res.set('X-Request-ID', requestId);
      try {
        const limits = { SOL: Number(process.env.MAX_SEND_SOL || 5), USDC: Number(process.env.MAX_SEND_USDC || 500) };
        let canonical, prompt;
        if (feature === 'ai-pack') {
          prompt = packPrompt(req.body?.prompt);
          canonical = JSON.stringify({ prompt });
        } else {
          try { canonical = JSON.stringify(validatePayments(req.body?.payments, limits)); }
          catch (error) { throw new PassError(400, error.message); }
        }
        const binding = createHash('sha256').update(`${feature}:${canonical}`).digest('hex');
        const result = await passes.redeem({ ...req.body?.pass, feature }, {
          binding, ...(feature === 'ai-pack' ? { prepare: () => generate(prompt, { limits }) } : {}),
        });
        console.info(JSON.stringify({ event: 'premium_action', feature, requestId, outcome: result.recovered ? 'recovered' : 'success', durationMs: Date.now() - started }));
        res.json(result);
      } catch (error) {
        const status = error instanceof PassError ? error.status : 503;
        console.warn(JSON.stringify({ event: 'premium_action', feature, requestId, status, durationMs: Date.now() - started }));
        res.status(status).json({ error: error instanceof PassError ? error.message : 'Premium service unavailable. Keep your saved request and retry.' });
      }
    });
  }
  return router;
}
