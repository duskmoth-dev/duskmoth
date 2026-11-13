// Presentation only: never changes receipts, spends passes or starts a payment.
export function payrollProgress(batch) {
  const records = batch.records || [];
  const confirmed = records.filter(row => row.status === 'confirmed').length;
  const unresolved = records.filter(row => ['uncertain', 'submitting'].includes(row.status)).length;
  const remaining = batch.payments.length - confirmed;
  const labels = {
    initializing: 'Loading privacy engine…', unlock: 'Approve message in wallet…',
    scan: 'Reading private balance…', screen: 'Checking sanctions…',
    fees: 'Checking withdrawal fees…', recover: 'Verifying saved authorization…',
    authorize: 'Authorizing batch…', sending: 'Processing current payment…',
    reconcile: 'Checking Solana receipts…',
  };
  if (batch.busy) return {
    label: labels[batch.phase] || 'Preparing batch…',
    title: batch.operation === 'reconcile' ? 'Read-only receipt recovery' : 'Batch operation in progress',
    detail: batch.operation === 'reconcile'
      ? 'Only saved transaction receipts are checked. This action does not spend a pass or submit a payment.'
      : batch.phase === 'unlock'
        ? 'Open your wallet and approve the message to read your private balance. This message is not a deposit.'
        : batch.phase === 'scan'
          ? 'The private pool history must finish loading before the balance can be verified. You can stop preparation; no new deposit is made.'
          : 'Keep this tab open. Confirmed rows remain saved; stopping does not undo an in-flight payment.',
  };
  if (!remaining) return { label: 'Complete', title: 'All payments confirmed', detail: `${confirmed}/${records.length} payments confirmed. Export the batch backup to keep your receipts.` };
  if (unresolved) return {
    label: 'Receipt check needed', title: 'Recover the unresolved payment first',
    detail: `${confirmed}/${records.length} payments confirmed. Select Reconcile with chain. If a signature is missing, attach it from the relayer. An unresolved payment is never automatically resent.`,
  };
  return {
    label: batch.status === 'reviewed' ? 'Reviewed' : batch.status === 'stopped' ? 'Stopped safely' : 'Needs review',
    title: confirmed ? 'Continue the remaining payments' : batch.authorized ? 'Saved batch authorization available' : 'Next step',
    detail: `${confirmed}/${records.length} payments confirmed; ${remaining} remaining. ${batch.status === 'reviewed' ? 'Select Run or Resume when ready.' : 'Select Review · free before running or resuming.'} ${batch.authorized ? 'This batch is already paid; no additional pass is needed. Confirmed rows are skipped.' : 'Review is free. Running costs 1 pass after preflight checks.'}`,
  };
}
