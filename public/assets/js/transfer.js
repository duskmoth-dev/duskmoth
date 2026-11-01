// Pure, deterministic checks shared by the preview and the final wallet-approved action.
export function validateTransfer(action, limits = {}) {
  if (!['shield', 'send', 'withdraw'].includes(action?.type)) throw new Error('Choose shield, send, or withdraw.');
  if (!['SOL', 'USDC'].includes(action.token)) throw new Error('Only SOL and USDC are supported.');
  const amount = action.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) throw new Error('Enter an amount greater than zero.');
  const units = action.token === 'SOL' ? 1e9 : 1e6;
  if (!Number.isSafeInteger(Math.round(amount * units)) || Math.abs(amount * units - Math.round(amount * units)) > 0.000001) {
    throw new Error(`Use at most ${action.token === 'SOL' ? 9 : 6} decimal places.`);
  }
  if (!(limits[action.token] > 0) || amount > limits[action.token]) throw new Error(`The per-transaction limit is ${limits[action.token] || 0} ${action.token}.`);
  return Math.round(amount * units);
}

export function withdrawalQuote(action, config) {
  const units = action.token === 'SOL' ? 1e9 : 1e6;
  const name = action.token.toLowerCase();
  const rate = config?.withdraw_fee_rate;
  const rent = action.token === 'SOL' ? config?.withdraw_rent_fee : config?.rent_fees?.[name];
  const minimum = config?.minimum_withdrawal?.[name];
  if (![rate, rent, minimum].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0) || rate >= 1) {
    throw new Error('The relayer did not return valid fees and withdrawal minimums. Try again before signing.');
  }
  const grossUnits = Math.round(action.amount * units);
  const feeUnits = Math.floor(grossUnits * rate + units * rent);
  const receiveUnits = grossUnits - feeUnits;
  if (receiveUnits <= 0 || receiveUnits < Math.ceil(minimum * units)) {
    throw new Error(`The recipient must receive at least ${minimum} ${action.token} after relayer fees. Increase the amount.`);
  }
  return { fee: feeUnits / units, receive: receiveUnits / units, rate, rent, minimum };
}
