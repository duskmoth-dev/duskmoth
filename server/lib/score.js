import Anthropic from '@anthropic-ai/sdk';
import { fetchJson, clamp, short } from './util.js';

const HELIUS = 'https://api.helius.xyz/v1/wallet';
const EXCHANGE_RE = /(exchange|cex|binance|coinbase|okx|bybit|kraken|kucoin|bitget|gate|mexc|htx|upbit|robinhood)/i;
const PRIVACY_PROGRAMS = new Set([
  '9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD', // Privacy Cash mainnet program
]);

export const SIGNALS = {
  cexFunded: { label: 'Funded from an exchange', impact: -25, fix: 'Start a fresh wallet funded from your shielded balance, not straight from an exchange.' },
  cexFlows: { label: 'Sends to exchange deposit addresses', impact: -15, fix: 'Withdraw to exchanges from a separate wallet instead of your main one.' },
  domain: { label: 'Linked .sol / public name', impact: -15, fix: 'Keep your public name on a display wallet that holds little.' },
  oldBusy: { label: 'Long, busy public history', impact: -10, fix: 'Split activity across purpose-specific wallets.' },
  bigBalance: { label: 'Large balance visible to anyone', impact: -10, fix: 'Shield idle funds so your balance is not a target.' },
  usedPrivacy: { label: 'Has used a privacy pool', impact: +10, fix: null },
};

function grade(score) {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function collectStrings(obj, out = new Set(), depth = 0) {
  if (depth > 6 || obj == null) return out;
  if (typeof obj === 'string') out.add(obj);
  else if (Array.isArray(obj)) obj.forEach((v) => collectStrings(v, out, depth + 1));
  else if (typeof obj === 'object') Object.values(obj).forEach((v) => collectStrings(v, out, depth + 1));
  return out;
}

async function helius(path, wallet) {
  const r = await fetchJson(`${HELIUS}/${wallet}/${path}`, { headers: { 'X-Api-Key': process.env.HELIUS_API_KEY } });
  if (r.status === 404) return null; // unknown wallet / never funded is normal
  if (!r.ok) throw new Error(`helius ${path} ${r.status}`);
  return r.body;
}

async function heliusBatchIdentity(addresses) {
  if (!addresses.length) return [];
  const r = await fetchJson('https://api.helius.xyz/v1/wallet/batch-identity', {
    method: 'POST',
    headers: { 'X-Api-Key': process.env.HELIUS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ addresses: addresses.slice(0, 100) }),
  });
  if (!r.ok || !Array.isArray(r.body)) return null;
  return r.body;
}

async function liveSignals(wallet) {
  const [fundedBy, identity, transfers, balances] = await Promise.all([
    helius('funded-by', wallet).catch(() => null),
    helius('identity', wallet).catch(() => null),
    helius('transfers', wallet).catch(() => null),
    helius('balances', wallet).catch(() => null),
  ]);
  const det = {};
  if (!balances && !transfers) throw new Error('No wallet data available');
  det.cexFunded = fundedBy ? EXCHANGE_RE.test(JSON.stringify(fundedBy)) : null;
  det.domain = identity ? /\.sol\b|domain|sns/i.test(JSON.stringify(identity)) : null;

  const list = Array.isArray(transfers) ? transfers : transfers?.data || transfers?.transfers || [];
  const counterparties = [...collectStrings(list)].filter((s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && s !== wallet);
  const ids = await heliusBatchIdentity(counterparties).catch(() => []);
  det.cexFlows = transfers && ids ? ids.some((i) => EXCHANGE_RE.test(JSON.stringify(i))) : null;
  det.usedPrivacy = transfers ? counterparties.some((a) => PRIVACY_PROGRAMS.has(a)) : null;
  det.oldBusy = transfers ? list.length >= 90 : null;
  const rawUsd = balances?.totalUsdValue ?? balances?.total_usd ?? balances?.totalValueUsd;
  const usd = rawUsd == null ? null : Number(rawUsd);
  det.bigBalance = Number.isFinite(usd) ? usd >= 10000 : null;
  return { det, txCount: list.length, usd };
}

let ai = null;
async function explain({ score, g, signals }) {
  const found = signals.filter((s) => s.detected);
  const fixes = found.map((s) => s.fix).filter(Boolean).slice(0, 3);
  const template =
    found.length === 0
      ? 'Your wallet gives little away. Keep it that way: shield idle funds and avoid reusing this address publicly.'
      : `Your wallet scores ${score}/100 (${g}). The biggest leaks: ${found.filter((s) => s.impact < 0).map((s) => s.label.toLowerCase()).join(', ') || 'none'}.`;
  if (!process.env.ANTHROPIC_API_KEY) return { summary: template, fixes };
  try {
    ai ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await ai.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      max_tokens: 220,
      system: 'You explain a crypto wallet privacy score to a normal person in 2 short sentences, no jargon, no markdown. Never mention specific addresses.',
      messages: [{ role: 'user', content: JSON.stringify({ score, grade: g, leaks: found.map((s) => s.label) }) }],
    });
    const text = res.content.find((c) => c.type === 'text')?.text?.trim();
    return { summary: text || template, fixes };
  } catch {
    return { summary: template, fixes };
  }
}

export async function scoreWallet(wallet) {
  const live = !!process.env.HELIUS_API_KEY;
  if (!live) { const e = new Error('The privacy estimate is not configured on this server.'); e.status = 503; throw e; }
  let data;
  const source = 'helius';
  try {
    data = await liveSignals(wallet);
  } catch {
    const e = new Error('Wallet data is unavailable right now. No estimate was generated.'); e.status = 502; throw e;
  }
  let score = 100;
  const signals = Object.entries(SIGNALS).map(([id, s]) => {
    const detected = data.det[id] == null ? null : !!data.det[id];
    if (detected) score += s.impact;
    return { id, label: s.label, impact: s.impact, detected, fix: s.fix };
  });
  score = clamp(score, 0, 100);
  const g = grade(score);
  const { summary, fixes } = await explain({ score, g, signals });
  const unavailable = signals.filter(s => s.detected === null).map(s => s.id);
  const coverage = { checked: signals.length - unavailable.length, total: signals.length, unavailable };
  if (!coverage.checked) { const e = new Error('Not enough verified wallet data to estimate privacy.'); e.status = 503; throw e; }
  return {
    wallet: short(wallet), score, grade: g, signals,
    summary: `Heuristic estimate using ${coverage.checked} of ${coverage.total} checks; not proof of anonymity. ${summary}`,
    fixes, txCount: data.txCount, source, coverage,
  };
}
