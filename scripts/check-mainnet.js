// npm run check
// Verifies a Duskmoth install against the real Solana mainnet services before you go live.
// Every check makes a real network call with your keys. Nothing is written and no funds move.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { screenTransfer } from '../server/lib/screening.js';

const PROGRAM = '9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CLEAN = '6AwuGoRLd54NTjAWeYZBVHnK4reK78FYpsqe6Z2PvU27';
const RELAYER = (process.env.RELAYER_URL || 'https://api3.privacycash.org').replace(/\/$/, '');
const RPC = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

let failed = 0, warned = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const warn = (m) => { warned++; console.log(`  \x1b[33mWARN\x1b[0m ${m}`); };
const get = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, ok: r.ok, json: j, text: t };
};
const rpc = (method, params = []) => get(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

async function step(name, fn) {
  console.log(`\n${name}`);
  try { await fn(); } catch (e) { bad(`${name}: ${e.message}`); }
}

console.log('Duskmoth mainnet preflight\n');

await step('1. Build artifacts', async () => {
  const need = ['public/circuit2/transaction2.wasm', 'public/circuit2/transaction2.zkey', 'public/assets/js/live/privacy-cash.js', 'public/assets/js/live/moth-pass.js', 'public/assets/js/live/light_wasm_hasher_bg.wasm', 'public/assets/js/live/hasher_wasm_simd_bg.wasm'];
  for (const f of need) fs.existsSync(path.resolve(f)) ? ok(f) : bad(`${f} missing. Run: npm run build`);
});

await step('2. Solana mainnet RPC', async () => {
  const g = await rpc('getGenesisHash');
  if (g.json?.result === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') ok(`mainnet-beta genesis confirmed (${process.env.HELIUS_API_KEY ? 'Helius' : 'public RPC'})`);
  else bad(`RPC is not mainnet-beta or unreachable (status ${g.status})`);
  const p = await rpc('getAccountInfo', [PROGRAM, { encoding: 'base64' }]);
  p.json?.result?.value?.executable ? ok(`Privacy Cash program ${PROGRAM} is deployed and executable`) : bad('Privacy Cash program not found on this RPC');
  const m = await rpc('getAccountInfo', [USDC, { encoding: 'base64' }]);
  m.json?.result?.value ? ok('USDC mint found') : bad('USDC mint not found');
  if (!process.env.HELIUS_API_KEY) warn('No HELIUS_API_KEY: the public RPC is heavily rate limited. Use a paid RPC for a public launch.');
});

await step('2b. Optional Moth Pass configuration', async () => {
  if (!process.env.DMOTH_MINT) return warn('DMOTH_MINT is empty: Moth Pass is disabled; ordinary Duskmoth features do not require it.');
  const { TOKEN_PROGRAMS } = await import('../server/lib/moth-pass.js');
  const result = await rpc('getAccountInfo', [process.env.DMOTH_MINT, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const value = result.json?.result?.value, parsed = value?.data?.parsed;
  if (TOKEN_PROGRAMS.has(value?.owner) && parsed?.type === 'mint' && Number.isInteger(parsed.info?.decimals)) {
    ok(`$DMOTH mainnet SPL mint found; decimals = ${parsed.info.decimals}`);
  } else bad('DMOTH_MINT is not a supported mainnet SPL mint.');
  if (process.env.PASS_STATE_DURABLE !== 'true') warn('Real burns are blocked until the pass key and ledgers use persistent, single-writer storage.');
  warn('Back up the original pass signing key and both ledgers securely. Lost or reset state can invalidate credits or replay protection.');
});

await step('3. Privacy Cash relayer', async () => {
  const c = await get(`${RELAYER}/config`);
  if (!c.ok || !c.json) return bad(`relayer ${RELAYER}/config returned ${c.status}`);
  ok(`relayer reachable at ${RELAYER}`);
  const j = c.json;
  if (j.withdraw_fee_rate != null) ok(`withdraw_fee_rate = ${j.withdraw_fee_rate}`);
  if (j.deposit_fee_rate != null) ok(`deposit_fee_rate = ${j.deposit_fee_rate}`);
  if (j.rent_fees) ok(`rent_fees = ${JSON.stringify(j.rent_fees)}`);
  if (j.minimum_withdrawal) ok(`minimum_withdrawal = ${JSON.stringify(j.minimum_withdrawal)}`);
  const root = await get(`${RELAYER}/merkle/root`);
  root.ok ? ok('merkle root endpoint answers') : warn(`merkle root returned ${root.status}`);
});

await step('4. Scorechain sanctions screening', async () => {
  const result = await screenTransfer({ recipient: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' });
  if (result.errorCode) return bad(`Scorechain check failed (${result.errorCode}). Screening cannot pass.`);
  ok(`Live Scorechain lookup completed: sanctions match = ${result.recipient.isSanctioned}`);
  warn('Sanctions-only result; not full AML risk screening. Free tier: non-commercial use, 100 lookups/hour. Verify provider coverage and commercial-use eligibility separately.');
});

await step('5. Helius Wallet API (privacy score)', async () => {
  if (!process.env.HELIUS_API_KEY) return warn('HELIUS_API_KEY missing: the privacy score is disabled in production.');
  const h = { 'X-Api-Key': process.env.HELIUS_API_KEY };
  const b = await get(`https://api.helius.xyz/v1/wallet/${CLEAN}/balances`, { headers: h });
  b.ok ? ok('balances endpoint works') : bad(`balances returned ${b.status}`);
  const f = await get(`https://api.helius.xyz/v1/wallet/${CLEAN}/funded-by`, { headers: h });
  if (f.status === 403) warn('funded-by needs a paid Helius plan: the "funded from an exchange" signal will be skipped.');
  else if (f.ok || f.status === 404) ok('funded-by endpoint available');
  else warn(`funded-by returned ${f.status}`);
});

await step('6. Claude (optional)', async () => {
  if (!process.env.ANTHROPIC_API_KEY) return warn('ANTHROPIC_API_KEY missing: the English rule parser is used instead.');
  const r = await get('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } });
  if (!r.ok) return bad(`Anthropic rejected the key (${r.status})`);
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
  const ids = (r.json?.data || []).map((m) => m.id);
  ids.includes(model) ? ok(`model ${model} available`) : warn(`model ${model} not in your model list; set ANTHROPIC_MODEL to one of: ${ids.slice(0, 4).join(', ')}`);
});

await step('7. Production settings', async () => {
  process.env.NODE_ENV === 'production' ? ok('NODE_ENV=production') : warn('NODE_ENV is not production. Demo data is disabled in every mode.');
  process.env.ENABLE_LIVE_SEND === 'true' ? ok('Wallet-approved transfers enabled. This does not prove a transaction has passed.') : warn('Operator disabled live transfers; no simulated transactions.');
  process.env.PUBLIC_URL?.startsWith('https://') ? ok(`PUBLIC_URL=${process.env.PUBLIC_URL}`) : warn('PUBLIC_URL should be your https:// domain.');
  process.env.ALLOW_UNSIGNED_SCORE === 'true' ? bad('ALLOW_UNSIGNED_SCORE=true lets anyone score any wallet. Set it to false.') : ok('ownership signature required for scores');
  ok('Demo wallet implementation removed.');
});

console.log(`\n${failed ? `\x1b[31m${failed} check(s) failed\x1b[0m` : '\x1b[32mAll required checks passed\x1b[0m'}${warned ? `, ${warned} warning(s)` : ''}.`);
if (!failed) console.log('Connectivity checks passed; no funds were moved. Solana sanctions coverage, commercial-use terms, and real-wallet transaction verification are separate checks.');
process.exit(failed ? 1 : 0);
