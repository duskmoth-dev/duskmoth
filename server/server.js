import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseIntent } from './lib/intent.js';
import { screenTransfer } from './lib/screening.js';
import { scoreWallet } from './lib/score.js';
import { verifyOwnership } from './lib/verify.js';
import { scoreCardSvg } from './lib/card.js';
import { walletActivity } from './lib/activity.js';
import { rateLimiter, isAddress, fetchJson } from './lib/util.js';
import { apiBudget, rpcBudget } from './lib/rpc-budget.js';
import { PROD, flags, preflight, status } from './lib/env.js';
import { rpcUrl } from './lib/activity.js';
import { createPassService } from './lib/moth-pass.js';
import { passRouter } from './lib/pass-router.js';
import { checkWithdrawalPrivacy } from './lib/withdraw-privacy.js';
import { premiumRouter } from './lib/premium-router.js';
import { magicblockRouter } from './lib/magicblock-router.js';
import { magicblockSettings } from './lib/magicblock.js';
import { MagicblockLedger } from './lib/magicblock-ledger.js';
import { magicblockExecutionRouter } from './lib/magicblock-execution-router.js';

const pf = preflight();
pf.warnings.forEach((w) => console.warn(`[duskmoth] warning: ${w}`));
if (pf.problems.length) {
  pf.problems.forEach((p) => console.error(`[duskmoth] fatal: ${p}`));
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const app = express();
const PORT = Number(process.env.PORT || 8787);

app.disable('x-powered-by');
app.set('trust proxy', 1);
// Privacy Cash relayer proxy. The browser module talks to /api/relayer on this host; we forward to the
// official relayer. Avoids CORS issues and keeps users' IP addresses away from the relayer.
const RELAYER = (process.env.RELAYER_URL || 'https://api3.privacycash.org').replace(/\/$/, '');
const RELAYER_PATHS = [/^\/config$/, /^\/deposit(\/spl)?$/, /^\/withdraw(\/spl)?$/, /^\/utxos\/(range|indices|check\/[A-Za-z0-9+/=_-]+)$/, /^\/merkle\/(root|proofv2\/?)$/];
if (flags.relayerProxy) {
  app.use('/api/relayer', rateLimiter({ capacity: 120, refillPerSec: 4 }), express.json({ limit: '512kb' }), async (req, res) => {
    const sub = req.path.replace(/\/+$/, '') || '/';
    if (/^\/(deposit|withdraw)(\/|$)/.test(sub) && !status().liveSend) {
      return res.status(503).json({ error: 'Live transfers are disabled. No transaction was submitted.' });
    }
    if (!['GET', 'POST'].includes(req.method) || !RELAYER_PATHS.some((re) => re.test(sub) || re.test(req.path))) return res.status(404).json({ error: 'Not found.' });
    // A direct relayer-proxy call must not bypass the recipient check in the interface.
    if (req.method === 'POST' && /^\/withdraw(\/|$)/.test(sub)) {
      const screening = await screenTransfer({ recipient: req.body?.recipient });
      if (screening.allowed !== true) return res.status(screening.errorCode ? 503 : 403).json({ error: screening.reason || 'Withdrawal sanctions check did not pass.' });
    }
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    try {
      const r = await fetch(`${RELAYER}${req.path}${qs}`, {
        method: req.method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: req.method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(90000),
      });
      const text = await r.text();
      res.status(r.status).type(r.headers.get('content-type') || 'application/json').set('Cache-Control', 'no-store').send(text);
    } catch {
      res.status(502).json({ error: 'The Privacy Cash relayer is unreachable right now.' });
    }
  });
}

app.use(express.json({ limit: '64kb' }));

// Security headers. Note: no request logging of bodies or addresses, on purpose.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (PROD && process.env.ALLOW_EMBEDDED_PREVIEW !== 'true') {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  }
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

const api = express.Router();
api.use(apiBudget());
const passes = createPassService({
  directory: process.env.PASS_DATA_DIR || path.join(ROOT, 'data'),
  async rpc(method, params) {
    const result = await fetchJson(rpcUrl(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }, 20000);
    if (!result.ok || result.body?.error) throw new Error('Mainnet RPC unavailable.');
    return result.body?.result;
  },
});
api.use('/pass', passRouter(passes));
api.use(premiumRouter(passes));
const magicblockLedger = new MagicblockLedger();
api.use('/engines/magicblock', magicblockRouter({ screen: screenTransfer, execution: () => magicblockLedger.health() }));
api.use('/engines/magicblock/execution', magicblockExecutionRouter({ settings: magicblockSettings(), ledger: magicblockLedger, passes, screen: screenTransfer }));
process.once('exit', () => { void passes.close(); });

api.get('/health', (req, res) => res.json({ ok: true, ...status() }));

api.get('/config', (req, res) => {
  res.json({
    ...status(),
    limits: { SOL: Number(process.env.MAX_SEND_SOL || 5), USDC: Number(process.env.MAX_SEND_USDC || 500) },
  });
});

api.post('/intent', async (req, res) => {
  const message = String(req.body?.message || '').slice(0, 500);
  if (!message.trim()) return res.status(400).json({ error: 'Say something first.' });
  res.json(await parseIntent(message));
});

api.post('/screen', async (req, res) => {
  const { sender, recipient } = req.body || {};
  const result = await screenTransfer({ sender, recipient });
  res.set('Cache-Control', 'no-store');
  res.status(result.errorCode === 'invalid-address' ? 400 : result.errorCode ? 503 : 200).json(result);
});

// Read-only, no pass consumption or retained address-pair records.
api.post('/privacy/withdraw-check', rateLimiter({ capacity: 6, refillPerSec: 0.1 }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const started = Date.now();
  try {
    const report = await checkWithdrawalPrivacy(req.body, {
      async rpc(method, params) {
        const result = await fetchJson(rpcUrl(), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        }, 8000);
        if (!result.ok || result.body?.error || !Object.hasOwn(result.body || {}, 'result')) throw new Error('RPC unavailable');
        return result.body.result;
      },
    });
    console.info(JSON.stringify({ event: 'withdraw_privacy_check', outcome: report.status, durationMs: Date.now() - started }));
    res.json(report);
  } catch (error) {
    const statusCode = error.status === 400 ? 400 : 503;
    console.warn(JSON.stringify({ event: 'withdraw_privacy_check', outcome: 'unavailable', status: statusCode, durationMs: Date.now() - started }));
    res.status(statusCode).json({ error: error.status ? error.message : 'Privacy review is unavailable. Retry without changing your transaction.' });
  }
});

api.post('/score', async (req, res) => {
  const { address, ts, signature } = req.body || {};
  if (!isAddress(address)) return res.status(400).json({ error: 'Invalid address.' });
  const v = verifyOwnership({ address, ts, signature });
  if (!v.ok) return res.status(401).json({ error: v.error });
  res.set('Cache-Control', 'no-store');
  try { res.json(await scoreWallet(address)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'Could not score this wallet.' }); }
});

// Public mainnet activity for the connected wallet: balances, 30-day stats, recent history.
api.post('/activity', async (req, res) => {
  const { address } = req.body || {};
  if (!isAddress(address)) return res.status(400).json({ error: 'Invalid address.' });
  res.set('Cache-Control', 'no-store');
  const result = await walletActivity(address);
  res.status(result.error ? 502 : 200).json(result);
});

api.get('/card.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(scoreCardSvg({ score: req.query.score, grade: req.query.grade }));
});

api.post('/waitlist', async (req, res) => {
  res.status(503).json({ error: 'Email signup is unavailable until durable storage is configured. Your email has not been saved.' });
});

// JSON-RPC proxy so the Helius key never reaches the browser. Only methods the app needs.
const RPC_ALLOW = new Set([
  'getLatestBlockhash', 'getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getTokenAccountBalance',
  'getTokenAccountsByOwner', 'getSignatureStatuses', 'getSignaturesForAddress', 'getTransaction', 'sendTransaction', 'simulateTransaction',
  'getMinimumBalanceForRentExemption', 'getSlot', 'getBlockHeight', 'getFeeForMessage', 'getRecentPrioritizationFees',
]);
api.post('/rpc', rpcBudget(), async (req, res) => {
  const body = req.body;
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > 10 || calls.some((c) => !RPC_ALLOW.has(c?.method))) {
    return res.status(403).json({ error: 'RPC method not allowed.' });
  }
  if (!status().liveSend && calls.some(c => c.method === 'sendTransaction')) {
    return res.status(503).json({ error: 'Live transfers are disabled. No transaction was submitted.' });
  }
  const r = await fetchJson(rpcUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 15000).catch(() => null);
  if (!r) return res.status(502).json({ error: 'RPC unavailable.' });
  res.status(r.status).json(r.body);
});

app.use('/api', api);
// Pages: make share-preview image URLs absolute (X and Telegram ignore relative og:image).
const PAGE_REDIRECTS = {
  '/tools.html': '/tools', '/tools/': '/tools',
  '/index.html': '/', '/index': '/', '/index/': '/', '/index.html/': '/',
  '/app.html': '/app', '/app/': '/app', '/app.html/': '/app',
  '/docs.html': '/docs', '/docs/': '/docs', '/docs.html/': '/docs',
  '/pass.html': '/pass', '/pass/': '/pass', '/pass.html/': '/pass',
};
app.use((req, res, next) => {
  const destination = PAGE_REDIRECTS[req.path];
  if (!destination || !['GET', 'HEAD'].includes(req.method)) return next();
  // Keep campaign/search parameters; browsers preserve the original fragment automatically.
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  return res.redirect(301, destination + query);
});
const PAGES = { '/': 'index.html', '/app': 'app.html', '/docs': 'docs.html', '/pass': 'pass.html', '/tools': 'tools.html' };
const pageCache = new Map();
app.get(Object.keys(PAGES), async (req, res, next) => {
  try {
    const file = PAGES[req.path];
    if (!pageCache.has(file) || process.env.NODE_ENV !== 'production') pageCache.set(file, await fs.readFile(path.join(ROOT, 'public', file), 'utf8'));
    const origin = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const canonical = `${origin}${file === 'index.html' ? '/' : '/' + file.replace(/\.html$/, '')}`;
    const html = pageCache.get(file)
      .replace(/content="assets\/img\/brand\//g, `content="${origin}/assets/img/brand/`)
      .replace('</head>', `<link rel="canonical" href="${canonical}"></head>`);
    res.type('html').set('Cache-Control', file === 'app.html' ? 'no-store' : 'public, max-age=300').send(html);
  } catch (e) { next(e); }
});
app.use(express.static(path.join(ROOT, 'public'), {
  extensions: ['html'], maxAge: '1h',
  setHeaders(res, file) { if (file.endsWith('.js')) res.setHeader('Cache-Control', 'no-cache'); },
}));
app.use((req, res) => res.status(404).sendFile(path.join(ROOT, 'public', 'index.html')));
// Never leak stack traces: every unhandled error becomes a short JSON message.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status === 400 ? 'Bad request.' : 'Something went wrong. Try again.' });
});

app.listen(PORT, '0.0.0.0', () => {
  const st = status();
  console.log(`Duskmoth ${st.mode} on http://localhost:${PORT} · network ${st.network} · ai ${st.ai} · screening ${st.screening} · data ${st.data} · live send ${st.liveSend} · demo wallet ${st.demoWallet}`);
});
