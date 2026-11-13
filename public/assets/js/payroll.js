import { validateTransfer, withdrawalQuote } from './transfer.js';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function payrollAddress(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let n = 0n;
  for (const char of value) n = n * 58n + BigInt(alphabet.indexOf(char));
  let size = 0;
  while (n) { size++; n >>= 8n; }
  return size + (value.match(/^1*/)?.[0].length || 0) === 32;
}
export function validatePayments(rows, limits = { SOL: 5, USDC: 500 }) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 20) throw new Error('Provide 1–20 recipients per batch.');
  const seen = new Set();
  let total = 0;
  const result = rows.map((row, index) => {
    if (!payrollAddress(row?.recipient)) throw new Error(`Row ${index + 1}: invalid Solana recipient address.`);
    if (seen.has(row.recipient)) throw new Error(`Row ${index + 1}: duplicate recipient. Combine amounts before continuing.`);
    seen.add(row.recipient);
    const payment = { recipient: row.recipient, amount: row.amount, token: row.token };
    total += validateTransfer({ ...payment, type: 'withdraw' }, limits);
    return payment;
  });
  const token = result[0].token, scale = token === 'SOL' ? 1e9 : 1e6;
  if (result.some(row => row.token !== token)) throw new Error('Use one token per batch: SOL or USDC.');
  if (!Number.isSafeInteger(total) || total > Math.round(limits[token] * scale)) throw new Error(`Batch total exceeds the configured ${limits[token]} ${token} limit.`);
  return result;
}
export function parsePayroll(text, limits) {
  if (typeof text !== 'string' || text.length > 12000) throw new Error('The recipient list is too large.');
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (/^recipient\s*,\s*amount\s*,\s*token$/i.test(lines[0] || '')) lines.shift();
  return validatePayments(lines.map((line, index) => {
    const fields = line.split(/[,;\t]/).map(field => field.trim().replace(/^"([^"]*)"$/, '$1'));
    if (fields.length !== 3 || !/^\d+(?:\.\d+)?$/.test(fields[1])) throw new Error(`Row ${index + 1}: use recipient,amount,token.`);
    return { recipient: fields[0], amount: Number(fields[1]), token: fields[2].toUpperCase() };
  }), limits);
}
export function quotePayroll(payments, config) {
  return payments.map(payment => withdrawalQuote({ ...payment, type: 'withdraw' }, config));
}
export function payrollTotal(payments) {
  const scale = payments[0].token === 'SOL' ? 1e9 : 1e6;
  return payments.reduce((sum, row) => sum + Math.round(row.amount * scale), 0) / scale;
}

// An unavailable lookup is not a sanctions match. Never turn either into a pass.
export function requirePayrollScreening(result, index) {
  if (result?.allowed === true && result.source === 'scorechain' && result.scope === 'sanctions-only') return;
  const subject = result?.failedRole === 'sender' ? 'Funding wallet' : `Recipient ${index + 1}`;
  if (result?.source === 'scorechain' && (result.recipient?.isSanctioned === true || result.sender?.isSanctioned === true)) {
    const matched = result.sender?.isSanctioned === true ? 'Funding wallet' : `Recipient ${index + 1}`;
    throw new Error(`${matched}: Scorechain reports a sanctions-list match. This payment cannot proceed.`);
  }
  const messages = {
    'rate-limited': 'Scorechain request limit reached. Wait before selecting Review · free again. This is not a confirmed sanctions match.',
    authentication: 'The screening provider rejected this server’s credentials. The operator must repair the connection.',
    'not-configured': 'Sanctions screening is not configured on this server. The operator must configure it.',
    'invalid-address': 'The screening service could not validate the Solana address. Check the funding wallet and recipient.',
    'invalid-response': 'The screening provider returned an unverifiable response. No sanctions result is available. Review again later.',
    timeout: 'Scorechain did not respond within the screening deadline after a retry. No sanctions match has been confirmed. Review again later.',
    'network-error': 'The server could not connect to Scorechain after a retry. No sanctions result is available. Review again later.',
    'provider-unavailable': 'Scorechain returned a temporary service error after a retry. No sanctions result is available. Review again later.',
    'provider-rejected': 'The screening provider rejected this lookup. The operator must inspect the reference below.',
    unavailable: 'The screening service did not complete the check. No sanctions match has been confirmed. Select Review · free to try again.',
  };
  const reference = /^[a-f0-9-]{36}$/i.test(result?.requestId || '') ? ` Reference: ${result.requestId}.` : '';
  throw new Error(`${subject}: ${messages[result?.errorCode] || messages.unavailable}${reference}`);
}

// Persist "submitting" BEFORE calling the relayer. Any ambiguous response stops
// the batch; never retry a potentially delivered payment automatically.
export async function runPayroll({ batch, engine, save, screen, config, authorize, assertWallet, onStatus = () => {}, onPhase = () => {}, onBalance = () => {}, balanceSignal, cancelled = () => false }) {
  const ensure = () => {
    assertWallet();
    if (cancelled()) throw new Error('Stopped after the current payment. Review the remaining payments before resuming.');
  };
  if (batch.records.some(row => ['submitting', 'uncertain'].includes(row.status))) throw new Error('Resolve the uncertain payment before resuming. Nothing else was sent.');
  const remaining = batch.payments.map((payment, index) => ({ payment, index })).filter(({ index }) => batch.records[index].status !== 'confirmed');
  if (!remaining.length) return;
  const check = async ({ payment, index }) => {
    ensure();
    onPhase('screen');
    onStatus(`Checking recipient ${index + 1}/${batch.payments.length} with Scorechain. No new payment is submitted during this check.`);
    const result = await screen(payment.recipient);
    requirePayrollScreening(result, index);
    onPhase('fees');
    onStatus(`Checking current withdrawal fees for payment ${index + 1}/${batch.payments.length}.`);
    const current = withdrawalQuote({ ...payment, type: 'withdraw' }, await config());
    if (!batch.quotes?.[index] || current.fee > batch.quotes[index].fee + 1e-12) throw new Error('Fees increased. Review the remaining payments again.');
  };
  ensure(); onStatus('Scanning existing private balance. No deposit will be made.');
  onPhase('scan');
  let detail = 'Reading private pool history. No new payment or pass is submitted during this scan.';
  const started = Date.now();
  const update = () => onStatus(`${detail} · ${Math.floor((Date.now() - started) / 1000)}s elapsed`);
  let lastUpdate = 0;
  const ticker = setInterval(update, 1000);
  let balance;
  try {
    balance = await engine.balance(batch.token, progress => {
      ensure();
      if (!['unlock', 'scan'].includes(progress?.phase)) return;
      onPhase(progress.phase);
      detail = progress.detail || detail;
      if (Date.now() - lastUpdate >= 400 || progress.phase === 'unlock') { lastUpdate = Date.now(); update(); }
    }, { signal: balanceSignal });
  } finally { clearInterval(ticker); }
  ensure();
  const scale = batch.token === 'SOL' ? 1e9 : 1e6;
  const requiredUnits = Math.round(payrollTotal(remaining.map(row => row.payment)) * scale);
  const amount = balance?.[batch.token], availableUnits = Math.round(amount * scale);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(availableUnits)) {
    onBalance({ token: batch.token, available: null, required: requiredUnits / scale, shortfall: null, checkedAt: new Date().toISOString() });
    throw new Error('Private balance could not be verified. No balance is assumed and no additional pass was spent. Read the balance again before running this batch.');
  }
  const funding = { token: batch.token, available: availableUnits / scale, required: requiredUnits / scale,
    shortfall: Math.max(0, requiredUnits - availableUnits) / scale, checkedAt: new Date().toISOString() };
  onBalance(funding);
  if (availableUnits < requiredUnits) {
    // This error is saved in the batch journal. Exact wallet totals belong only
    // in the in-memory funding card, not in persisted errors or exported files.
    throw new Error(`Insufficient private ${batch.token} for the remaining payments. Check the private balance details below and shield the missing amount using the same wallet, then review again. Public-wallet funds and Moth Passes are separate. No additional pass was spent.`);
  }
  for (const row of remaining) await check(row);
  ensure();
  if (!batch.authorized) {
    onPhase('authorize');
    onStatus('Authorizing this batch with 1 Moth Pass.');
    await authorize();
  }
  for (const row of remaining) {
    await check(row); ensure();
    const record = batch.records[row.index];
    record.status = 'submitting'; delete record.error;
    batch.status = 'running'; save();
    onPhase('sending');
    onStatus(`Payment ${row.index + 1}/${batch.payments.length}: preparing proof and submitting withdrawal.`);
    try {
      const signature = await engine.withdraw({
        ...row.payment,
        onProgress: progress => onStatus(`Payment ${row.index + 1}: ${progress.detail || 'Working…'}`),
      });
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature || '')) throw new Error('The relayer did not return a verifiable transaction signature.');
      record.signature = signature;
      record.status = 'confirmed';
      save();
    } catch (error) {
      record.status = 'uncertain';
      if (/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(error.submittedSignature || '')) record.signature = error.submittedSignature;
      record.error = 'Payment outcome is uncertain. Check chain status or contact the relayer before making another payment.';
      batch.status = 'uncertain'; save();
      throw new Error(record.error);
    }
  }
  batch.status = 'completed'; save();
}
