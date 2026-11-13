export function receiptMatches(tx, payment, quote) {
  if (!tx?.meta || tx.meta.err || !quote) return false;
  const scale = payment.token === 'SOL' ? 1e9 : 1e6;
  let received;
  if (payment.token === 'SOL') {
    const keys = (tx.transaction?.message?.accountKeys || []).map(key => typeof key === 'string' ? key : key.pubkey);
    const index = keys.indexOf(payment.recipient);
    if (index < 0 || !Number.isSafeInteger(tx.meta.preBalances?.[index]) || !Number.isSafeInteger(tx.meta.postBalances?.[index])) return false;
    received = tx.meta.postBalances[index] - tx.meta.preBalances[index];
    if (index === 0) received += tx.meta.fee || 0;
  } else {
    const total = rows => (rows || []).filter(row => row.owner === payment.recipient && row.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
      .reduce((sum, row) => sum + BigInt(row.uiTokenAmount.amount), 0n);
    try { received = Number(total(tx.meta.postTokenBalances) - total(tx.meta.preTokenBalances)); }
    catch { return false; }
  }
  return Number.isSafeInteger(received) && received >= Math.round(quote.receive * scale) - 1 && received <= Math.round(payment.amount * scale) + 1;
}
