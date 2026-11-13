import * as api from './api.js?mode=real';
import { detectWallets, makeWallet, providerAddress, b58encode } from './wallet.js?mode=real';
import { observeWallets, walletConnectionError } from './wallet-discovery.js';
import { createWalletSession, walletPreferences } from './wallet-session.js';
import * as passes from './passes.js';
import { requestPremium, pendingPremium } from './pass-spend.js';
import { parsePayroll, validatePayments, payrollTotal, runPayroll, payrollAddress, requirePayrollScreening } from './payroll.js';
import { withdrawalQuote } from './transfer.js';
import { receiptMatches } from './payroll-receipt.js';
import { magicblockReviewMessage } from './magicblock-contract.js';

const BATCH = 'dm_payroll_v1', AI = 'dm_ai_pack_v1';
const signatureOK = value => /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value || '');
const id = () => [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
function write(key, value) {
  const text = JSON.stringify(value);
  localStorage.setItem(key, text);
  if (localStorage.getItem(key) !== text) throw new Error('Recovery data could not be saved. Nothing new will be submitted.');
}
function read(key) {
  const value = localStorage.getItem(key);
  if (!value) return null;
  try { return JSON.parse(value); } catch { throw new Error('Saved tool data is unreadable. Keep your browser data and recovery backup.'); }
}
export async function createPremiumTools({ onChange = () => {} } = {}) {
  const state = { wallet: null, wallets: [], connecting: false, config: null, passInfo: null, credits: 0, creditError: '', loading: true, error: '',
    ai: { busy: false, error: '', result: null }, payroll: null, privateBalanceCheck: null,
    magicblock: { info: null, busy: false, error: '', result: null } };
  let wallet = null, engine = null, stopped = false, active = false, reviewed = false, initializing = true;
  let balanceAbort = null;
  const emit = () => { state.wallets = detectWallets().map(({ id, name }) => ({ id, name })); onChange(state); };
  const save = () => { write(BATCH, state.payroll); emit(); };
  const session = createWalletSession({ makeWallet, storage: walletPreferences, onConnectingChange(connecting) { state.connecting = connecting; emit(); }, onChange(next) {
    state.privateBalanceCheck = null;
    state.magicblock.result = null; state.magicblock.error = '';
    balanceAbort?.abort(new Error('Wallet changed during balance preparation. Review again with the batch owner wallet.'));
    wallet = next; engine = null; reviewed = false; stopped = true;
    if (state.payroll?.status === 'reviewed') state.payroll.status = 'needs-review';
    state.wallet = next ? { address: next.address, name: next.name } : null;
    state.magicblock.info = null;
    if (!initializing) void loadMagicblockInfo();
    emit();
  } });
  function syncCredits() {
    try {
      state.credits = state.passInfo ? passes.count(state.passInfo.kid, !!state.passInfo.demo) : 0;
      state.creditError = '';
    } catch (error) {
      state.credits = 0;
      state.creditError = error.message;
    }
  }
  const assertWallet = () => {
    if (!wallet || !state.config?.liveSend || wallet.demo) throw new Error('Connect a real wallet with mainnet transfers available.');
    if (providerAddress(wallet.provider) !== wallet.address || state.payroll?.owner !== wallet.address) throw new Error('The connected wallet does not own this payroll batch.');
  };
  const idle = () => { if (active || state.ai.busy || state.magicblock.busy) throw new Error('Another premium action is in progress.'); };
  const getEngine = async () => {
    assertWallet();
    if (!engine) {
      const current = wallet;
      if (state.config.relayerProxy) globalThis.__DM_RELAYER__ = `${location.origin}/api/relayer`;
      const live = await import('./live/privacy-cash.js');
      const instance = await live.createLive({ rpcUrl: `${location.origin}/api/rpc`, wallet: current });
      if (wallet !== current) throw new Error('Wallet changed while unlocking private balance.');
      engine = instance;
    }
    return engine;
  };
  const refresh = async () => {
    state.error = '';
    try {
      [state.config, state.passInfo] = await Promise.all([api.config(), api.passInfo()]);
      syncCredits();
    } catch (error) { state.error = error.message; state.loading = initializing; emit(); return false; }
    state.loading = initializing; emit();
  };
  function checkedBatch(value, imported = false) {
    if (!value || typeof value.id !== 'string' || !/^[a-f0-9]{32}$/.test(value.id) || !payrollAddress(value.owner)) throw new Error('Invalid payroll backup.');
    const payments = validatePayments(value.payments, state.config?.limits);
    if (!Array.isArray(value.records) || value.records.length !== payments.length) throw new Error('Invalid payroll receipt list.');
    const records = value.records.map((row, index) => {
      if (row.index !== index || !['pending', 'submitting', 'confirmed', 'uncertain', 'failed'].includes(row.status)) throw new Error('Invalid payment status.');
      if (row.signature && !signatureOK(row.signature)) throw new Error('Invalid transaction signature.');
      if (row.status === 'confirmed' && !row.signature) throw new Error('A confirmed payment needs a transaction receipt.');
      return { index, status: row.status === 'submitting' || (imported && row.status === 'confirmed') ? 'uncertain' : row.status, ...(row.signature ? { signature: row.signature } : {}) };
    });
    return { id: value.id, owner: value.owner, token: payments[0].token, payments, records,
      authorized: !!value.authorization, authorization: value.authorization || null,
      quotes: Array.isArray(value.quotes) && value.quotes.length === payments.length
        ? value.quotes.map(quote => quote && ['fee', 'receive', 'rate', 'rent'].every(key => Number.isFinite(quote[key]) && quote[key] >= 0) ? quote : null)
        : null,
      busy: false, error: '', status: records.some(row => row.status === 'uncertain') ? 'uncertain' : records.every(row => row.status === 'confirmed') ? 'completed' : 'needs-review' };
  }
  async function generate(prompt, recovering = false) {
    idle(); state.ai.busy = true; state.ai.error = ''; emit();
    try {
      await refresh();
      if (!state.passInfo?.features?.['ai-pack']?.enabled) throw new Error('AI Pack is unavailable. No pass was spent.');
      const pending = recovering ? pendingPremium() : null;
      if (recovering && pending?.feature !== 'ai-pack') throw new Error('No AI request is awaiting recovery.');
      const payload = recovering ? pending.payload : { prompt: String(prompt).trim() };
      await requestPremium(state.passInfo, 'ai-pack', payload, response => {
        const result = response.result;
        validatePayments(result?.payments, state.config.limits);
        if (result.engine !== 'claude') throw new Error('A genuine AI plan was not returned.');
        write(AI, result); state.ai.result = result;
      });
    } catch (error) { state.ai.error = error.message; return false; }
    finally { state.ai.busy = false; await refresh(); }
  }
  function preparePayments(payments) {
    idle();
    if (!wallet) throw new Error('Connect the wallet whose existing private balance will fund this batch.');
    if (state.payroll && state.payroll.status !== 'completed') throw new Error('Keep or clear your existing batch before creating another.');
    const rows = validatePayments(payments, state.config.limits);
    const batch = { id: id(), owner: wallet.address, token: rows[0].token, payments: rows,
      records: rows.map((_, index) => ({ index, status: 'pending' })), status: 'prepared', error: '', quotes: null, authorized: false, busy: false };
    write(BATCH, batch); state.payroll = batch; state.magicblock.result = null; state.magicblock.error = ''; reviewed = false; emit();
  }
  async function reviewPayroll() {
    idle(); assertWallet();
    const batch = state.payroll; active = true; batch.busy = true; batch.operation = 'review'; batch.phase = 'fees';
    batch.error = ''; batch.status = 'Reading current withdrawal fees. Review is free; no pass or payment is submitted.'; reviewed = false; emit();
    try {
      if (batch.records.some(row => ['submitting', 'uncertain'].includes(row.status))) throw new Error('Reconcile the uncertain payment before resuming.');
      const config = await api.relayerConfig();
      batch.quotes = batch.payments.map((payment, index) => batch.records[index].status === 'confirmed'
        ? batch.quotes?.[index] || null : withdrawalQuote({ ...payment, type: 'withdraw' }, config));
      for (const [index, payment] of batch.payments.entries()) {
        if (batch.records[index].status === 'confirmed') continue;
        batch.phase = 'screen'; batch.status = `Reviewing recipient ${index + 1}/${batch.payments.length} with Scorechain. No pass is spent.`; emit();
        const screen = await api.screen({ sender: wallet.address, recipient: payment.recipient });
        assertWallet();
        requirePayrollScreening(screen, index);
      }
      assertWallet(); batch.status = 'reviewed'; reviewed = true; save();
    } catch (error) { batch.error = error.message; batch.status = 'needs-review'; save(); return false; }
    finally { active = false; batch.busy = false; batch.operation = null; batch.phase = null; save(); }
  }
  async function executePayroll() {
    idle(); assertWallet();
    if (!navigator.locks) throw new Error('This browser cannot safely lock a payroll run.');
    const batch = state.payroll;
    if (!reviewed || !batch.quotes) throw new Error('Review this batch and its current fees first.');
    syncCredits();
    if (!batch.authorized && state.creditError) throw new Error(state.creditError);
    if (!batch.authorized && state.credits < 1) throw new Error('This batch needs 1 available Moth Pass. AI Pack and Payroll each cost a separate pass. No payments were sent.');
    if (!window.confirm(`MAINNET: withdraw from existing private balance to ${batch.payments.length} recipient(s). Gross batch total ${payrollTotal(batch.payments)} ${batch.token}. Each payment pays a relayer fee. ${batch.authorized ? 'This batch is already authorized; no additional pass.' : 'Costs 1 Moth Pass after preflight; the pass is not refunded if execution later stops.'} No new deposit. Keep this tab open, do not run other transfers concurrently, and confirm all recipients before continuing.`)) return false;
    return navigator.locks.request('dm_payroll_run', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('A payroll run is already active in another tab.');
      // The durable marker is authoritative if another tab changed the batch.
      const stored = read(BATCH);
      if (stored?.id !== batch.id || JSON.stringify(stored.records) !== JSON.stringify(batch.records)) throw new Error('This batch changed in another tab. Reload before continuing.');
      active = true; stopped = false; batch.busy = true; batch.operation = 'run'; batch.phase = 'initializing';
      state.privateBalanceCheck = null;
      batch.status = 'Loading the privacy engine. No payment has been sent.'; batch.error = ''; emit();
      balanceAbort = new AbortController();
      try {
        const live = await getEngine(); assertWallet();
        const currentInfo = await api.passInfo();
        if (batch.authorized) {
          batch.phase = 'recover'; batch.status = 'Verifying the saved authorization for this batch. No new pass is selected.'; emit();
          const proof = batch.authorization?.proof;
          if (!proof) throw new Error('The saved batch authorization is missing. Keep its backup.');
          const receipt = await api.premiumAction('private-payroll', { payments: batch.payments, pass: proof });
          if (receipt.grant !== batch.authorization.grant || receipt.binding !== batch.authorization.binding) throw new Error('Batch authorization does not match.');
        }
        await runPayroll({ batch, engine: live, save, assertWallet,
          balanceSignal: balanceAbort.signal,
          screen: recipient => api.screen({ sender: wallet.address, recipient }), config: api.relayerConfig,
          cancelled: () => stopped,
          onStatus: text => { batch.status = text; emit(); },
          onPhase: phase => { if (batch.phase !== phase) { batch.phase = phase; emit(); } },
          // Keep the wallet's full private balance in memory only, not in the
          // batch journal, exported recovery file, logs or API requests.
          onBalance: check => { state.privateBalanceCheck = { ...check, batchId: batch.id }; emit(); },
          authorize: async () => {
            await requestPremium(currentInfo, 'private-payroll', { payments: batch.payments }, (response, journal) => {
              batch.authorization = { grant: response.grant, binding: response.binding, proof: { ...journal.pass, requestId: journal.requestId } };
              batch.authorized = true; save();
            });
          },
        });
      } catch (error) {
        batch.error = error.message;
        batch.status = batch.records.some(row => ['submitting', 'uncertain'].includes(row.status)) ? 'uncertain' : 'stopped';
        save();
        return false;
      } finally { balanceAbort = null; active = false; reviewed = false; batch.busy = false; batch.operation = null; batch.phase = null; save(); await refresh(); }
    });
  }
  async function reconcilePayroll() {
    idle(); assertWallet();
    const batch = state.payroll; batch.busy = true; batch.operation = 'reconcile'; batch.phase = 'reconcile';
    batch.error = ''; active = true; emit();
    try {
      // A saved quote is the receipt's original comparison data. Recovery must
      // not depend on today's relayer availability when that quote is present.
      let config;
      for (const row of batch.records.filter(row => ['uncertain', 'submitting', 'confirmed'].includes(row.status))) {
        batch.status = `Checking saved receipt ${row.index + 1}/${batch.payments.length} on Solana. Read-only; nothing is resent.`; emit();
        if (!row.signature) {
          row.status = 'uncertain';
          row.error = 'Obtain this payment’s transaction signature from the relayer and attach it below. Nothing is resent.';
          continue;
        }
        const tx = await api.rpcRead('getTransaction', [row.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
        let quote = batch.quotes?.[row.index];
        if (!quote) {
          config ??= await api.relayerConfig();
          quote = withdrawalQuote({ ...batch.payments[row.index], type: 'withdraw' }, config);
        }
        if (receiptMatches(tx, batch.payments[row.index], quote)) { row.status = 'confirmed'; delete row.error; }
        else { row.status = 'uncertain'; row.error = 'No matching confirmed receipt found. This payment will not be retried.'; }
        save();
      }
      batch.status = batch.records.every(row => row.status === 'confirmed') ? 'completed' : batch.records.some(row => row.status === 'uncertain') ? 'uncertain' : 'needs-review';
      batch.error = batch.status === 'uncertain' ? 'Unresolved payment: obtain its transaction signature from the relayer, then reconcile. Never resend it blindly.' : '';
      reviewed = false; save();
    } catch (error) {
      batch.error = error.message;
      batch.status = batch.records.some(row => ['uncertain', 'submitting'].includes(row.status)) ? 'uncertain' : 'needs-review';
      return false;
    }
    finally { active = false; reviewed = false; batch.busy = false; batch.operation = null; batch.phase = null; save(); }
  }
  async function reviewMagicblock() {
    idle(); assertWallet();
    const batch = state.payroll, currentWallet = wallet;
    if (!state.magicblock.info?.reviewEnabled) throw new Error('MagicBlock internal review is disabled.');
    if (batch.records.some(row => row.status !== 'pending')) throw new Error('Use a fresh, unsent batch for this internal engine review.');
    const payments = validatePayments(batch.payments, { SOL: 5, USDC: state.magicblock.info.maxBatchUSDC });
    if (payments.some(row => row.token !== 'USDC')) throw new Error('MagicBlock internal review supports USDC only.');
    state.magicblock.busy = true; state.magicblock.error = ''; state.magicblock.result = null; emit();
    try {
      const ts = Date.now();
      const signature = b58encode(await wallet.signMessage(magicblockReviewMessage(wallet.address, ts, payments)));
      assertWallet();
      if (wallet !== currentWallet) throw new Error('Wallet changed. Review again with the original wallet.');
      const result = await api.magicblockReview({ owner: wallet.address, payments, proof: { ts, signature } });
      assertWallet();
      if (wallet !== currentWallet || state.payroll?.id !== batch.id) throw new Error('The wallet or batch changed. Discarding this review.');
      if (result.mode !== 'unsigned-review-only' || result.totalCostVerified !== false || result.approvalReady !== false
        || result.transactionSubmitted !== false || result.passSpent !== false || result.depositMade !== false
        || !['operationTokenUnits', 'operationLamports'].every(key => typeof result[key] === 'string' && /^\d{1,24}$/.test(result[key]))
        || !Number.isFinite(Date.parse(result.checkedAt))) throw new Error('An invalid internal review was returned.');
      // Fee observations stay in memory. Never add engine payloads or unsigned
      // transactions to the existing Privacy Cash recovery/export journal.
      state.magicblock.result = result;
    } catch (error) { state.magicblock.error = error.message; return false; }
    finally { state.magicblock.busy = false; emit(); }
  }
  async function loadMagicblockInfo() {
    const owner = wallet?.address || '';
    try {
      const info = await api.magicblockInfo(owner);
      if ((wallet?.address || '') === owner) state.magicblock.info = info;
    } catch { if ((wallet?.address || '') === owner) state.magicblock.info = null; }
    emit();
  }
  const controller = {
    get state() { return state; },
    getMagicblockWallet: () => wallet,
    async connect(id) {
      idle();
      try { if (!await session.connect(id)) throw new Error('Wallet account is unavailable.'); }
      catch (error) { throw new Error(walletConnectionError(error)); }
    },
    async disconnect() { stopped = true; await session.disconnect(); },
    refresh,
    loadMagicblockInfo,
    reviewMagicblock,
    generateAI: prompt => generate(prompt),
    recoverAI: () => generate('', true),
    async useAIPlan() {
      idle();
      if (!state.ai.result || new Date(state.ai.result.expiresAt).getTime() <= Date.now()) throw new Error('The saved AI plan is unavailable or expired. No payment was made.');
      if (state.payroll && state.payroll.status !== 'completed' && state.payroll.owner === wallet?.address
        && JSON.stringify(state.payroll.payments) === JSON.stringify(validatePayments(state.ai.result.payments, state.config.limits))) {
        return reviewPayroll();
      }
      preparePayments(state.ai.result.payments);
      return reviewPayroll();
    },
    async preparePayroll(text) { preparePayments(parsePayroll(text, state.config?.limits)); return reviewPayroll(); },
    reviewPayroll, runPayroll: executePayroll,
    stopPayroll() {
      stopped = true;
      balanceAbort?.abort(new Error('Private-balance preparation stopped. No new payment was sent. Close any pending wallet message before resuming.'));
      if (state.payroll?.busy) {
        state.payroll.status = 'Stopping safely. An in-flight payment, if any, must finish before the batch stops.';
        emit();
      }
    },
    reconcilePayroll,
    async recordSignature(index, signature) {
      idle(); const row = state.payroll?.records[index];
      if (!row || row.status !== 'uncertain' || !signatureOK(signature)) throw new Error('Choose an uncertain payment and enter a valid transaction signature.');
      row.signature = signature; save(); return reconcilePayroll();
    },
    async clearPayroll() {
      idle();
      if (state.payroll?.records.some(row => ['uncertain', 'submitting'].includes(row.status))) throw new Error('Do not clear an unresolved payment. Export recovery data and reconcile first.');
      if (!window.confirm('Remove this local batch and its receipt list? Export a backup first. On-chain transactions and used passes are not undone.')) return false;
      localStorage.removeItem(BATCH); state.payroll = null; state.magicblock.result = null; state.magicblock.error = ''; reviewed = false; emit();
    },
    exportPayroll() { if (!state.payroll) throw new Error('No batch to export.'); return JSON.stringify({ ...state.payroll, busy: false }, null, 2); },
    async importPayroll(text) {
      idle(); if (typeof text !== 'string' || text.length > 50000) throw new Error('Invalid payroll backup.');
      if (state.payroll) throw new Error('Keep your existing batch. Clear only a resolved batch before importing another.');
      const batch = checkedBatch(JSON.parse(text), true); write(BATCH, batch); state.payroll = batch; reviewed = false; emit();
    },
  };
  try {
    const saved = read(BATCH);
    // Limits are loaded before validating any recovered batch.
    await refresh();
    if (saved) { state.payroll = checkedBatch(saved); save(); }
    const result = read(AI);
    if (result && new Date(result.expiresAt).getTime() > Date.now()) { validatePayments(result.payments, state.config?.limits); state.ai.result = result; }
    else if (result) localStorage.removeItem(AI);
  } catch (error) { state.error = error.message; }
  await session.restore();
  observeWallets(() => { emit(); if (!wallet && !state.connecting) void session.restore({ waitMs: 0 }); });
  window.addEventListener('passes:change', () => { syncCredits(); emit(); });
  window.addEventListener('focus', () => { session.validate(); syncCredits(); emit(); });
  window.addEventListener('beforeunload', event => {
    if (active) { event.preventDefault(); event.returnValue = ''; }
  });
  initializing = false; state.loading = false; emit(); return controller;
}
