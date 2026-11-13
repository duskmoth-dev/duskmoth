export function payrollReadiness(state, toolsReady = true) {
  const batch = state.payroll, reasons = [];
  if (!toolsReady || state.loading) reasons.push('Tools are loading.');
  if (!batch) return { canRun: false, reasons: ['Prepare a batch first.'], needsPass: false };
  if (state.error) reasons.push(state.error);
  if (!state.wallet) reasons.push('Connect the wallet that funds this batch.');
  else if (state.wallet.address !== batch.owner) reasons.push('Reconnect the wallet that created this batch.');
  if (!state.config?.liveSend) reasons.push('Mainnet transfers are unavailable. Refresh the connection settings.');
  if (state.passInfo?.enabled === false) reasons.push(state.passInfo.reason || 'Moth Pass is unavailable.');
  const feature = state.passInfo?.features?.['private-payroll'];
  if (feature?.enabled === false) reasons.push(feature.reason || 'Private Payroll is unavailable.');
  if (batch.busy) reasons.push('A batch operation is in progress.');
  if (batch.records?.some(row => ['uncertain', 'submitting'].includes(row.status))) {
    reasons.push('Use Reconcile with chain to check the unresolved payment. Do not resend it.');
  }
  if (!batch.busy && (batch.status !== 'reviewed' || !batch.quotes?.length || !batch.quotes.every(Boolean))) {
    reasons.push('Select Review · free to check current fees and recipients before running.');
  }
  const needsPass = !batch.authorized && state.credits < 1;
  if (!batch.authorized && state.creditError) reasons.push(state.creditError);
  else if (needsPass) {
    reasons.push('You have 0 passes available. This batch needs 1 pass. AI Pack and Payroll each cost a separate pass. Get a pass or restore an unused-pass backup.');
  }
  return { canRun: reasons.length === 0, reasons: [...new Set(reasons)], needsPass };
}
