import { rateLimiter } from './util.js';

// Pool scans and proof preparation issue many legitimate RPC reads. Sharing
// the ordinary API bucket can otherwise prevent the final wallet preflight.
// Keep both paths bounded and give broadcasts a separate, stricter allowance.
export function apiBudget() {
  const general = rateLimiter({ capacity: 40, refillPerSec: 0.7 });
  return (req, res, next) => req.path === '/rpc' ? next() : general(req, res, next);
}
export function rpcBudget() {
  const reads = rateLimiter({ capacity: 120, refillPerSec: 4 });
  const broadcasts = rateLimiter({ capacity: 8, refillPerSec: 0.2 });
  return (req, res, next) => {
    const calls = Array.isArray(req.body) ? req.body : [req.body];
    return (calls.some(call => call?.method === 'sendTransaction') ? broadcasts : reads)(req, res, next);
  };
}
