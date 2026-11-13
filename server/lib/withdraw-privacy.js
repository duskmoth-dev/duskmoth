import { PublicKey } from '@solana/web3.js';

const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const HISTORY = 20;
const DETAILS = 3;

export class PrivacyCheckError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function address(value) {
  try {
    if (typeof value !== 'string' || new PublicKey(value).toBase58() !== value) throw new Error();
    return value;
  } catch { throw new PrivacyCheckError(400, 'Enter valid Solana sender and recipient addresses.'); }
}

export function validatePrivacyRequest(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PrivacyCheckError(400, 'Enter a withdrawal plan to check.');
  const sender = address(body.sender);
  const recipient = address(body.recipient);
  const { token, amount } = body;
  if (!['SOL', 'USDC'].includes(token) || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 ||
      amount > (token === 'SOL' ? 1e9 : 1e12)) {
    throw new PrivacyCheckError(400, 'Choose SOL or USDC and enter a positive amount.');
  }
  return { sender, recipient, token, amount };
}

function keys(tx) {
  return (tx?.transaction?.message?.accountKeys || []).map(key => typeof key === 'string' ? key : key.pubkey);
}

// A public balance change is not evidence of a Privacy Cash deposit.
function publicChanges(tx, sender, token) {
  if (!tx?.meta || tx.meta.err) return null;
  if (token === 'SOL') {
    const index = keys(tx).indexOf(sender);
    const before = tx.meta.preBalances?.[index], after = tx.meta.postBalances?.[index];
    if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after)) return null;
    const delta = after - before + (index === 0 ? tx.meta.fee || 0 : 0);
    return [Math.abs(delta) / 1e9].filter(value => value > 0);
  }
  if (!Array.isArray(tx.meta.preTokenBalances) || !Array.isArray(tx.meta.postTokenBalances)) return null;
  const totals = balances => (balances || []).filter(b => b.owner === sender && b.mint === USDC)
    .reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n);
  const delta = totals(tx.meta.postTokenBalances) - totals(tx.meta.preTokenBalances);
  return [Number(delta < 0n ? -delta : delta) / 1e6].filter(value => value > 0);
}

export async function checkWithdrawalPrivacy(body, { rpc, now = () => Date.now() }) {
  const input = validatePrivacyRequest(body);
  const genesis = await rpc('getGenesisHash', []).catch(() => null);
  if (genesis !== MAINNET) throw new PrivacyCheckError(503, 'Solana mainnet could not be verified. Retry the check.');
  const checkedAt = new Date(now()).toISOString();
  const history = async target => {
    const rows = await rpc('getSignaturesForAddress', [target, { limit: HISTORY, commitment: 'confirmed' }]);
    if (!Array.isArray(rows) || rows.some(row => typeof row?.signature !== 'string')) throw new Error('Invalid history');
    return rows.filter(row => !row.err);
  };
  const [senderResult, recipientResult] = await Promise.allSettled([history(input.sender), history(input.recipient)]);
  if (senderResult.status !== 'fulfilled' && recipientResult.status !== 'fulfilled') {
    throw new PrivacyCheckError(503, 'Public mainnet history is unavailable. No privacy assessment was produced.');
  }
  const sender = senderResult.status === 'fulfilled' ? senderResult.value : null;
  const recipient = recipientResult.status === 'fulfilled' ? recipientResult.value : null;
  const details = await Promise.allSettled((sender || []).slice(0, DETAILS).map(async row => {
    // Read parsed JSON directly; mainnet now also returns version-1 transactions.
    const tx = await rpc('getTransaction', [row.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
    if (!tx?.meta || !tx?.transaction?.message) throw new Error('Transaction unavailable');
    return { tx, signature: row.signature };
  }));
  const transactions = details.filter(row => row.status === 'fulfilled').map(row => row.value);
  const signal = (id, status, title, detail, evidence = []) => ({ id, status, title, detail, evidence });
  const checks = [
    signal('self-recipient', input.sender === input.recipient ? 'warning' : 'observed', 'Return to connected wallet',
      input.sender === input.recipient ? 'The recipient is your connected public wallet. Withdrawing here can reconnect funds to an identity already visible on-chain.' : 'The recipient differs from your connected wallet. This alone does not make it unlinked.'),
    signal('recipient-history', recipient === null ? 'unknown' : recipient.length ? 'warning' : 'observed', 'Recipient address reuse',
      recipient === null ? 'Recipient history could not be loaded.' : recipient.length ? `Found ${recipient.length} successful entries within the latest ${HISTORY} address-history entries. This address has public activity.` : `No successful entries were returned within the latest ${HISTORY} address-history entries. Token-account history and older activity are not fully covered.`),
  ];
  const recent = (sender || []).find(row => Number.isFinite(row.blockTime));
  const age = recent ? Math.max(0, now() / 1000 - recent.blockTime) : null;
  checks.push(signal('timing', age === null ? 'unknown' : age < 3600 ? 'warning' : 'observed', 'Recent sender activity',
    age === null ? 'No timestamped successful sender activity was available.' : `Latest timestamped sender activity was ${Math.floor(age / 60)} minutes before this check. ${age < 3600 ? 'Close timing may help observers correlate activity.' : 'A longer interval alone does not prove privacy.'} This activity is not a verified pool deposit.`,
    recent ? [recent.signature] : []));
  const common = (sender || []).filter(row => recipient?.some(other => other.signature === row.signature)).map(row => row.signature);
  const linked = [...new Set([...common, ...transactions.filter(({ tx }) => keys(tx).includes(input.recipient)).map(row => row.signature)])];
  const complete = sender !== null && recipient !== null && details.length > 0 && transactions.length === details.length;
  checks.push(signal('public-link', linked.length ? 'warning' : complete ? 'observed' : 'unknown', 'Shared public activity',
    linked.length ? 'Both addresses appear in shared public activity. This is not necessarily a direct payment, but it can expose a relationship.' : 'No shared activity was found in the inspected sample; this is not a full address-link analysis.', linked));
  const amountSamples = transactions.map(row => {
    try { return { ...row, changes: publicChanges(row.tx, input.sender, input.token) }; }
    catch { return { ...row, changes: null }; }
  }).filter(row => row.changes !== null);
  const matches = amountSamples.filter(({ changes }) => changes
    .some(value => Math.abs(value - input.amount) <= Math.max(input.amount * 0.01, 0.000001)));
  checks.push(signal('amount', matches.length ? 'warning' : amountSamples.length && amountSamples.length === details.length ? 'observed' : 'unknown', 'Similar public amounts',
    matches.length ? 'A sender balance change is within 1% of the proposed gross withdrawal. Similar amounts can aid correlation. This is not proof of a deposit or a linked withdrawal.' : 'No similar sender balance change was found in the available sample. Relayer fees, split amounts and activity outside the sample are not covered.',
    matches.map(row => row.signature)));
  return {
    version: 1, network: 'solana-mainnet', checkedAt, input,
    status: checks.some(row => row.status === 'unknown') ? 'partial' : 'sampled',
    warningCount: checks.filter(row => row.status === 'warning').length,
    checks,
    suggestions: [
      ...(checks.some(c => ['self-recipient', 'recipient-history', 'public-link'].includes(c.id) && c.status === 'warning')
        ? ['Consider a recipient address not already associated with your public wallet. A fresh address alone does not guarantee privacy.'] : []),
      ...(checks.some(c => c.id === 'timing' && c.status === 'warning')
        ? ['Review close timing between public activity and your proposed withdrawal. Waiting alone cannot guarantee that activity is unlinked.'] : []),
      ...(matches.length ? ['Review the similarity between the proposed gross amount and public balance changes. Changing an amount alone does not guarantee anonymity.'] : []),
      'Review the final recipient, net amount and fees before approving. This optional report does not approve or submit a transaction.',
    ],
    coverage: { historyLimitPerAddress: HISTORY, senderEntries: sender?.length ?? null, recipientEntries: recipient?.length ?? null, transactionLimit: DETAILS, transactionsInspected: transactions.length, amountTransactionsInspected: amountSamples.length },
    limitations: 'Heuristic public-history review, not an anonymity guarantee or sanctions check. No pool-wide anonymity analysis, verified deposit age, complete token-account history, off-chain identity or network-metadata analysis. Split parts require separate checks.',
  };
}
