import Anthropic from '@anthropic-ai/sdk';
import { BASE58_FIND, isAddress, short } from './util.js';
import { isSolanaAddress } from './screening.js';
import { validateTransfer } from '../../public/assets/js/transfer.js';

const TOKENS = ['SOL', 'USDC'];
const MAX_AMOUNT = { SOL: Number(process.env.MAX_SEND_SOL || 5), USDC: Number(process.env.MAX_SEND_USDC || 500) };

const T = {
  en: {
    help: "I'm Duskmoth. Tell me what to do in plain words, for example: \"send 2 SOL to 7xKp…9fA privately\", \"shield 1 SOL\", or \"check my privacy score\". I never move funds without your confirmation in your wallet.",
    needRecipient: 'Who should receive it? Paste the recipient Solana address.',
    needAmount: 'How much, and in which token? I support SOL and USDC.',
    tooMuch: (max, tok) => `For now Duskmoth caps a single private send at ${max} ${tok}. Try a smaller amount.`,
    send: (a, t, r) => `Review a private transfer of ${a} ${t} to ${short(r)}, then confirm in your wallet. Privacy is not guaranteed.`,
    withdraw: (a, t, r) => `Ready to withdraw ${a} ${t} from your private balance to ${short(r)}. Check the relayer fee and what they receive, then approve.`,
    shield: (a, t) => `I'll shield ${a} ${t} into your private balance. You can send from it later, which makes the link much harder to trace.`,
    score: 'Connect your wallet and sign a short message so I can score your own wallet. I only score wallets you prove you own.',
    balance: 'Opening your shielded balance.',
    roundTip: 'Tip: round amounts and a delay between shielding and sending make you harder to trace.',
  },
};

/** Rule-based parser. Used when no ANTHROPIC_API_KEY is set, and as a fallback if the model call fails. */
export function parseRules(message) {
  const L = T.en;
  const msg = message.trim();
  const amountMatch = msg.match(/(?<![\w.+-])(\d+(?:[.,]\d+)?)\s*(sol|usdc)\b/i);
  const amount = amountMatch ? Number(amountMatch[1].replace(',', '.')) : null;
  const token = amountMatch ? amountMatch[2].toUpperCase() : null;
  const recip = (msg.match(BASE58_FIND) || [])[0] || null;
  const later = /\b(later|tonight|tomorrow)\b/i.test(msg);

  if (/\b(score|exposed|leak)\b/i.test(msg)) {
    return { reply: L.score, action: { type: 'score' } };
  }
  if (/\b(balance)\b/i.test(msg) && !amount) {
    return { reply: L.balance, action: { type: 'balance' } };
  }
  const isWithdraw = /\b(withdraw|unshield)\b|from (?:my )?(?:private|shielded) balance/i.test(msg);
  if (isWithdraw) {
    if (!amount) return { reply: L.needAmount, action: null };
    if (!recip || !isSolanaAddress(recip)) return { reply: L.needRecipient, action: null };
    const action = { type: 'withdraw', amount, token, recipient: recip };
    try { validateTransfer(action, MAX_AMOUNT); } catch (e) { return { reply: e.message, action: null }; }
    return { reply: L.withdraw(amount, token, recip), action };
  }
  const isShield = /\b(shield|deposit)\b/i.test(msg);
  const isSend = /\b(send|transfer|pay)\b/i.test(msg) || (!!recip && !!amount);

  if (isShield && !isSend) {
    if (!amount) return { reply: L.needAmount, action: null };
    try { validateTransfer({ type: 'shield', amount, token }, MAX_AMOUNT); } catch (e) { return { reply: e.message, action: null }; }
    return { reply: L.shield(amount, token), action: { type: 'shield', amount, token } };
  }
  if (isSend) {
    if (!amount) return { reply: L.needAmount, action: null };
    if (!recip || !isSolanaAddress(recip)) return { reply: L.needRecipient, action: null, partial: { amount, token } };
    try { validateTransfer({ type: 'send', amount, token }, MAX_AMOUNT); } catch (e) { return { reply: e.message, action: null }; }
    const roundish = Number.isInteger(amount) || Number.isInteger(amount * 10);
    return {
      reply: L.send(amount, token, recip) + (roundish ? '' : ' ' + L.roundTip),
      action: { type: 'send', amount, token, recipient: recip, delay: later ? 'later' : 'now' },
    };
  }
  return { reply: L.help, action: { type: 'help' } };
}

const SYSTEM = `You are Duskmoth, a privacy assistant for Solana. You turn a user's plain-language request into ONE structured action by calling propose_action, plus a short reply.
Rules:
- You never execute anything. The user always confirms in their own wallet.
- Supported actions: send (deposit then private transfer), shield (deposit into a private balance), withdraw (send from an existing private balance WITHOUT another deposit), score, balance, help.
- For "withdraw", "unshield", or "send from my private/shielded balance", use withdraw, not send. Ask for a recipient if missing.
- Tokens: SOL or USDC only. Max per send: ${MAX_AMOUNT.SOL} SOL or ${MAX_AMOUNT.USDC} USDC; refuse larger amounts politely.
- If a field is missing (amount, token, recipient), ask for it and do not call the tool.
- Recipient must be a Solana base58 address copied exactly from the user's message. Never invent addresses.
- Give one short privacy tip when useful: round amounts, and waiting between shield and send.
- Refuse help with laundering stolen funds, evading sanctions, or hiding proceeds of crime.
- Always reply in English. Max 2 sentences. No markdown.`;

const TOOL = {
  name: 'propose_action',
  description: 'Propose the single action the user wants. The app will show a preview; nothing executes without the user signing.',
  input_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['send', 'shield', 'withdraw', 'score', 'balance', 'help'] },
      amount: { type: 'number' },
      token: { type: 'string', enum: TOKENS },
      recipient: { type: 'string' },
      delay: { type: 'string', enum: ['now', 'later'] },
    },
    required: ['type'],
  },
};

let client = null;
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  client ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/** Validate a model-proposed action server-side. The model is never trusted with limits or addresses. */
export function validateProposedAction(action, message) {
  if (!action || typeof action !== 'object' || !['send', 'shield', 'withdraw', 'score', 'balance', 'help'].includes(action.type)) return null;
  const existingBalance = /\b(withdraw|unshield)\b|from (?:my )?(?:private|shielded) balance/i.test(message);
  const a = { type: existingBalance && ['send', 'shield'].includes(action.type) ? 'withdraw' : action.type };
  if (['send', 'shield', 'withdraw'].includes(a.type)) {
    if (!TOKENS.includes(action.token)) return null;
    const amountInMessage = message.match(/(?<![\w.+-])(\d+(?:[.,]\d+)?)\s*(sol|usdc)\b/i);
    if (!amountInMessage || amountInMessage[2].toUpperCase() !== action.token || Number(amountInMessage[1].replace(',', '.')) !== action.amount) return null;
    const amt = action.amount;
    if (!(amt > 0) || amt > MAX_AMOUNT[action.token]) return null;
    a.token = action.token;
    a.amount = amt;
    try { validateTransfer(a, MAX_AMOUNT); } catch { return null; }
    if (a.type !== 'shield') {
      if (!isSolanaAddress(action.recipient) || !message.includes(action.recipient)) return null;
      a.recipient = action.recipient;
      if (a.type === 'send') a.delay = action.delay === 'later' ? 'later' : 'now';
    }
  }
  return a;
}

export async function parseIntent(message) {
  const ai = anthropic();
  if (!ai) return { ...parseRules(message), engine: 'rules' };
  try {
    const res = await ai.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      max_tokens: 400,
      system: SYSTEM,
      tools: [TOOL],
      messages: [{ role: 'user', content: message }],
    });
    const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();
    const tool = res.content.find((c) => c.type === 'tool_use');
    let action = tool ? validateProposedAction(tool.input, message) : null;
    // Existing-private-balance requests must never accidentally make a second deposit.
    if (action?.type === 'send' && /\b(withdraw|unshield)\b|from (?:my )?(?:private|shielded) balance/i.test(message)) {
      const { delay, ...withdrawal } = action;
      action = { ...withdrawal, type: 'withdraw' };
    }
    if (tool && !action) {
      // Model proposed something invalid; fall back to deterministic rules.
      return { ...parseRules(message), engine: 'rules-fallback' };
    }
    const canonicalReply = action && ['send', 'shield', 'withdraw'].includes(action.type)
      ? T.en[action.type](action.amount, action.token, action.recipient) : null;
    return { reply: canonicalReply || text || parseRules(message).reply, action, engine: 'claude' };
  } catch {
    return { ...parseRules(message), engine: 'rules-fallback' };
  }
}
