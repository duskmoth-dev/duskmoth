import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { PassError } from './moth-pass.js';
import { rateLimiter } from './util.js';

export function passRouter(service) {
  const router = Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(rateLimiter({ capacity: 8, refillPerSec: 0.1 }));
  for (const [method, route, action] of [['get', '/info', 'info'], ['post', '/issue', 'issue'], ['post', '/redeem', 'redeem']]) {
    router[method](route, async (req, res) => {
      try { res.json(await service[action](req.body)); }
      catch (error) {
        const status = error instanceof PassError ? error.status : 503;
        if (status >= 500) console.warn(JSON.stringify({ event: 'pass_service_unavailable', operation: action, requestId: randomUUID(), status }));
        res.status(status).json({ error: error instanceof PassError ? error.message : 'Pass service unavailable. Keep your saved purchase and try again.' });
      }
    });
  }
  return router;
}
