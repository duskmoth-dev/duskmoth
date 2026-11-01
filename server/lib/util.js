import crypto from 'node:crypto';

export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const BASE58_FIND = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

export function isAddress(s) {
  return typeof s === 'string' && BASE58_RE.test(s.trim());
}

/** Deterministic 0..1 float from a string, used by demo mode so results are stable per address. */
export function seeded(str, salt = '') {
  const h = crypto.createHash('sha256').update(String(str) + '|' + salt).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

export function short(addr) {
  return addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : '';
}

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/** fetch with timeout that never logs request bodies (privacy). */
export async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

/** Tiny in-memory token bucket rate limiter keyed by IP. */
export function rateLimiter({ capacity = 30, refillPerSec = 0.5 } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = req.ip || 'anon';
    const now = Date.now() / 1000;
    const b = buckets.get(key) || { tokens: capacity, at: now };
    b.tokens = Math.min(capacity, b.tokens + (now - b.at) * refillPerSec);
    b.at = now;
    if (b.tokens < 1) {
      res.status(429).json({ error: 'Too many requests. Slow down a little.' });
      return;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 5000) buckets.clear();
    next();
  };
}
