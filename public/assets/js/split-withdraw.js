import { withdrawalQuote } from './transfer.js';
export const MIN_PART = { SOL: 0.02, USDC: 2 };
const units = token => token === 'SOL' ? 1e9 : 1e6;
const random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
export function planSplit(amount, token, rng = random) {
  if (!Object.hasOwn(MIN_PART, token) || !Number.isFinite(amount)) throw new Error('Unsupported split withdrawal.');
  const scale = units(token), total = Math.round(amount * scale), minimum = Math.round(MIN_PART[token] * scale);
  if (!Number.isSafeInteger(total) || total < minimum * 2) throw new Error(`Split withdraw needs at least ${MIN_PART[token] * 2} ${token}.`);
  const next = () => { const value = rng(); if (!(value >= 0 && value < 1)) throw new Error('Invalid random source.'); return value; };
  const n = Math.min(Math.floor(total / minimum), 2 + Math.floor(next() * 3));
  const quantum = token === 'SOL' ? 100000 : 10000;
  let amounts;
  for (let attempt = 0; attempt < 24; attempt++) {
    const weights = Array.from({ length: n }, () => 0.6 + next());
    const sum = weights.reduce((a, b) => a + b, 0);
    amounts = weights.map(weight => Math.floor(total * weight / sum / quantum) * quantum);
    amounts[n - 1] = total - amounts.slice(0, -1).reduce((a, b) => a + b, 0);
    if (amounts.every(value => value >= minimum)) break;
    amounts = null;
  }
  if (!amounts) {
    const extra = total - n * minimum, weights = Array.from({ length: n }, () => 0.6 + next()), sum = weights.reduce((a, b) => a + b, 0);
    amounts = weights.map(weight => minimum + Math.floor(extra * weight / sum / quantum) * quantum);
    amounts[n - 1] = total - amounts.slice(0, -1).reduce((a, b) => a + b, 0);
  }
  return amounts.map((value, i) => ({ amount: value / scale, wait: i ? 30 + Math.floor(next() * 91) : 0 }));
}
export function validateSplit(action, plan) {
  const scale = units(action.token);
  if (action.type !== 'withdraw' || !Array.isArray(plan) || plan.length < 2 || plan.length > 4) throw new Error('Invalid split withdrawal plan.');
  for (const [i, part] of plan.entries()) {
    if (!Number.isFinite(part.amount) || part.amount < MIN_PART[action.token] || !Number.isSafeInteger(Math.round(part.amount * scale)) || Math.abs(part.amount * scale - Math.round(part.amount * scale)) > 0.000001 || !Number.isInteger(part.wait) || (i === 0 ? part.wait !== 0 : part.wait < 30 || part.wait > 120)) throw new Error('Invalid split withdrawal part.');
  }
  if (plan.reduce((sum, part) => sum + Math.round(part.amount * scale), 0) !== Math.round(action.amount * scale)) throw new Error('The split parts do not match the approved amount.');
}
export function quoteSplit(action, plan, config) {
  validateSplit(action, plan);
  const quotes = plan.map(part => withdrawalQuote({ ...action, amount: part.amount }, config));
  return { quotes, fee: quotes.reduce((sum, q) => sum + q.fee, 0), receive: quotes.reduce((sum, q) => sum + q.receive, 0), rate: quotes[0].rate, rent: quotes.reduce((sum, q) => sum + q.rent, 0) };
}
export async function runSplitWithdrawal({ action, plan, approvedQuotes, engine, assertWallet, screen, config, spend, onStatus, onConfirmed, onBalance = () => {}, cancelled = () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  validateSplit(action, plan);
  const completed = [];
  const ensure = () => { assertWallet(); if (cancelled()) throw new Error('Remaining withdrawals were stopped.'); };
  const check = async index => {
    ensure();
    const screening = await screen();
    if (screening.allowed !== true || screening.source !== 'scorechain' || screening.scope !== 'sanctions-only') throw new Error(screening.reason || 'Recipient sanctions screening is unavailable.');
    const latest = withdrawalQuote({ ...action, amount: plan[index].amount }, await config());
    if (!approvedQuotes?.[index] || latest.fee > approvedQuotes[index].fee + 1e-12) throw new Error('Relayer fees increased. Review a new preview before sending remaining funds.');
  };
  try {
    ensure();
    onStatus('Checking your existing private balance. No deposit will be made.');
    const balance = await engine.balance(action.token);
    if (!Number.isFinite(balance[action.token])) throw new Error('Your private balance is unavailable. Nothing was withdrawn.');
    onBalance(balance[action.token]);
    if (Math.round(balance[action.token] * units(action.token)) < Math.round(action.amount * units(action.token))) throw new Error(`Your private balance shows ${balance[action.token]} ${action.token}. Shield first, or open Wallet → Show private balance. Nothing was withdrawn.`);
    for (let i = 0; i < plan.length; i++) await check(i);
    ensure();
    onStatus('Spending 1 Moth Pass for split withdrawal.');
    await spend();
    for (let i = 0; i < plan.length; i++) {
      for (let left = plan[i].wait; left > 0; left--) {
        ensure(); onStatus(`Waiting ${left} s before part ${i + 1} of ${plan.length}. Keep this tab open.`);
        await sleep(1000);
      }
      await check(i);
      ensure();
      onStatus(`Part ${i + 1} of ${plan.length}: proof and relayed withdrawal of ${plan[i].amount} ${action.token}.`);
      const signature = await engine.withdraw({
        token: action.token, amount: plan[i].amount, recipient: action.recipient,
        onProgress: progress => onStatus(`Part ${i + 1} of ${plan.length}: ${progress.detail}`),
      });
      completed.push({ signature, amount: plan[i].amount });
      onConfirmed(completed.at(-1), completed);
    }
    return completed;
  } catch (error) { error.completed = completed; throw error; }
}
