import { magicblockIntent, magicblockActionMessage } from './magicblock-contract.js';
import { validatePayments } from './payroll.js';
import { b58encode } from './wallet.js?mode=real';
import * as passes from './passes.js';

const KEY = 'dm_magicblock_operation_v1', PASS = 'dm_magicblock_pass_v1';
const uuid = () => [...crypto.getRandomValues(new Uint8Array(16))].map(v => v.toString(16).padStart(2, '0')).join('');
const sigOK = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s);
const unresolved = r => ['signed', 'submitted', 'source-confirmed', 'uncertain'].includes(r.status);
const read = key => { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; };
const put = (key, value) => {
  const text = JSON.stringify(value); localStorage.setItem(key, text);
  if (localStorage.getItem(key) !== text) throw new Error('A durable browser recovery record could not be saved. Nothing new will be submitted.');
};
export function restoreMagicblockOperation(value, imported = false) {
  if (!value) return null;
  const intent = magicblockIntent({ ...value.intent, payments: validatePayments(value.intent?.payments, { USDC: 500, SOL: 5 }) });
  if (!Array.isArray(value.records) || value.records.length !== intent.payments.length) throw new Error('Invalid MagicBlock receipt list.');
  const records = value.records.map((r, index) => {
    if (r.index !== index || r.nonce !== intent.refs[index].nonce || r.clientRefId !== intent.refs[index].clientRefId || !Number.isInteger(r.nonce) || r.nonce < 0 || r.nonce > 4294967295
      || !/^\d{1,20}$/.test(r.clientRefId) || BigInt(r.clientRefId) > 18446744073709551615n
      || !['pending', 'awaiting-wallet', 'signed', 'submitted', 'source-confirmed', 'confirmed', 'uncertain', 'failed'].includes(r.status)
      || r.signature && !sigOK(r.signature) || r.settlementSignature && !sigOK(r.settlementSignature)
      || unresolved(r) && !r.signature || r.status === 'confirmed' && (!r.signature || !r.settlementSignature)
      || r.recipientUnits && !/^\d+$/.test(r.recipientUnits)) throw new Error('Invalid MagicBlock recovery record.');
    return { index, nonce: r.nonce, clientRefId: r.clientRefId,
      status: r.status === 'awaiting-wallet' ? 'pending' : r.status === 'signed' || imported && r.signature ? 'uncertain' : r.status,
      ...(r.signature ? { signature: r.signature, runtime: r.runtime === 'ephemeral' ? 'ephemeral' : 'base',
        recipientUnits: r.recipientUnits || String(Math.round(intent.payments[index].amount * 1e6)) } : {}),
      ...(r.settlementSignature ? { settlementSignature: r.settlementSignature, settlementRuntime: r.settlementRuntime === 'ephemeral' ? 'ephemeral' : 'base' } : {}),
      ...(r.proofMethod === 'tee-private-state-and-closed-shuttle' ? { proofMethod: r.proofMethod } : {}),
      ...(!imported && r.failureKind === 'preflight' ? { failureKind: 'preflight' } : {}),
      ...(Array.isArray(r.failedAttempts) ? { failedAttempts: r.failedAttempts.slice(-20).filter(a => sigOK(a.signature)).map(a => ({ signature: a.signature, runtime: a.runtime === 'ephemeral' ? 'ephemeral' : 'base' })) } : {}) };
  });
  // Explicit whitelist: no private balance, session token, raw transaction,
  // cached quote, pass bearer proof or arbitrary imported fields survive.
  return { intent, records, reserved: !!value.reserved, authorized: !!value.authorized };
}
export async function createMagicblockPayments({ getWallet, onChange = () => {}, loadEngine = () => import('./live/magicblock-engine.js') }) {
  const state = { info: null, busy: false, phase: '', error: '', balance: null, operation: null, quotes: null, reviewed: false };
  let engine = null, engineWallet = null, stop = false;
  let lastStored = localStorage.getItem(KEY);
  const emit = () => { state.passReserved = !!localStorage.getItem(PASS); onChange(state); };
  const unchangedStorage = () => { if (localStorage.getItem(KEY) !== lastStored) throw new Error('This operation changed in another tab. Reload and check the saved receipts before signing.'); };
  const save = () => {
    unchangedStorage();
    if (state.operation) { put(KEY, restoreMagicblockOperation(state.operation)); lastStored = localStorage.getItem(KEY); }
    emit();
  };
  try { state.operation = restoreMagicblockOperation(read(KEY)); } catch { state.error = 'Saved MagicBlock recovery data needs attention. Export browser data before clearing it.'; }
  function wallet() {
    const w = getWallet();
    if (!w || w.demo || w.provider?.publicKey?.toString() !== w.address) throw new Error('Connect a real Solana wallet.');
    if (state.operation && state.operation.intent.owner !== w.address) throw new Error('Reconnect the wallet that owns the saved MagicBlock operation.');
    return w;
  }
  async function api(path, body) {
    const r = await fetch(`/api/engines/magicblock/execution/${path}`, { method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store', signal: AbortSignal.timeout(120000) });
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || 'MagicBlock is unavailable.');
    return data;
  }
  async function signedAction(action, extra = {}) {
    const w = wallet(), ts = Date.now(), intent = state.operation.intent;
    const signature = b58encode(await w.signMessage(magicblockActionMessage(action, intent, ts)));
    if (wallet() !== w) throw new Error('Wallet changed during approval.');
    return api(action, { intent, proof: { ts, signature }, ...extra });
  }
  async function live() {
    const w = wallet();
    if (engineWallet !== w) {
      engine?.clear(); engine = null; engineWallet = w; state.balance = null;
      engine = (await loadEngine()).createMagicblockEngine({ wallet: w, rpcUrl: `${location.origin}/api/rpc`,
        assertWallet: () => { if (getWallet() !== w) throw new Error('Wallet changed. Reconnect the original wallet.'); } });
    }
    return engine;
  }
  async function task(phase, work) {
    if (state.busy) throw new Error('A MagicBlock operation is already running.');
    state.busy = true; state.phase = phase; state.error = ''; emit();
    try { return await work(); }
    catch (e) { state.error = e.message; return false; }
    finally { state.busy = false; state.phase = ''; emit(); }
  }
  async function refresh() {
    const w = getWallet();
    if (w !== engineWallet) { engine?.clear(); engine = null; engineWallet = null; state.balance = null; state.quotes = null; state.reviewed = false; }
    if (!w) { state.info = null; emit(); return; }
    try { state.info = await api(`health?owner=${encodeURIComponent(w.address)}`); }
    catch (error) { state.info = { enabled: false, reason: error.message }; }
    emit();
  }
  function prepare({ kind = 'send', source = 'base', payments }) {
    if (state.busy) throw new Error('Wait for the current operation.');
    if (localStorage.getItem(KEY) && !state.operation) throw new Error('Existing recovery data is unreadable. Do not overwrite it.');
    if (state.operation && !state.operation.records.every(r => r.status === 'confirmed')) throw new Error('Keep or clear your existing MagicBlock operation first.');
    const w = wallet(), rows = validatePayments(payments, { USDC: state.info?.maxBatchUSDC || 500, SOL: 5 });
    const records = rows.map((p, index) => ({ index, status: 'pending',
      nonce: crypto.getRandomValues(new Uint32Array(1))[0],
      clientRefId: new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigUint64(0).toString() }));
    const intent = magicblockIntent({ id: uuid(), owner: w.address, kind, source, payments: rows, refs: records });
    state.operation = { intent, records, authorized: false, reserved: false };
    state.quotes = null; state.reviewed = false; save();
  }
  const readBalance = source => task('Reading private USDC balance — message approval may be required.', async () => {
    state.balance = await (await live()).balance(source || 'ephemeral'); emit(); return state.balance;
  });
  async function review() {
    return task('Screening every recipient. No pass or funds move during review.', async () => {
      wallet(); state.reviewed = false; state.quotes = null;
      if (!state.operation || state.operation.records.some(unresolved)) throw new Error('Check every signed or pending transaction before reviewing a new send.');
      await signedAction('screen');
      const e = await live(), op = state.operation, source = op.intent.kind === 'withdraw' ? 'ephemeral' : op.intent.source;
      const balance = await e.balance(source);
      state.balance = source === 'ephemeral' ? balance : null;
      const needed = op.intent.payments.reduce((n, p, i) => n + (op.records[i].status === 'confirmed' ? 0n : BigInt(Math.round(p.amount * 1e6))), 0n);
      if (BigInt(balance.units) < needed) throw new Error(`Insufficient ${source === 'ephemeral' ? 'MagicBlock private' : 'public wallet'} USDC. No new deposit or pass charge was made.`);
      state.quotes = [];
      for (const [i, p] of op.intent.payments.entries()) {
        if (op.records[i].status === 'confirmed') { state.quotes.push(null); continue; }
        if (op.records[i].status === 'failed' && op.records[i].signature) {
          const result = await e.status(op.records[i], op.intent, p);
          if (result.status !== 'failed') { Object.assign(op.records[i], result); save(); throw new Error('A previous attempt is not proven failed. Check its receipt; nothing was resent.'); }
        }
        state.phase = `Simulating recipient ${i + 1}/${op.records.length} and verifying full upfront costs.`; emit();
        state.quotes.push(await e.quote(op.intent, p, op.records[i]));
      }
      const required = new Map();
      for (const q of state.quotes.filter(Boolean)) required.set(q.runtime, (required.get(q.runtime) || 0n) + BigInt(q.fees.totalLamports));
      for (const [runtime, amount] of required) {
        const solBalance = await e.rpc('getBalance', [op.intent.owner, { commitment: 'confirmed' }], runtime);
        if (BigInt(solBalance?.value ?? 0) < amount) throw new Error('SOL is insufficient for the full reviewed maximum cost. No payment or pass was spent.');
      }
      // Multiple isolated simulations can include the same setup rent. This is
      // a disclosed conservative upper bound, rechecked before every signature.
      state.reviewed = true; emit(); return true;
    });
  }
  async function passForOperation(info) {
    if (!navigator.locks) throw new Error('Safe pass reservation is unavailable in this browser.');
    return navigator.locks.request('dm_pass_spend', { ifAvailable: true }, lock => {
    if (!lock) throw new Error('A pass is being used in another tab. Nothing new was sent.');
    const pending = read(PASS);
    if (pending) {
      if (pending.id !== state.operation.intent.id) throw new Error('Recover the previous MagicBlock pass authorization first.');
      return pending.pass;
    }
    const pass = passes.all().find(p => p.kid === info.kid && p.demo === false);
    if (!pass) throw new Error('Payroll needs 1 Moth Pass. Single sends, deposits and withdrawals do not.');
    put(PASS, { id: state.operation.intent.id, pass });
    const taken = passes.take(pass.kid, false);
    if (taken?.msg !== pass.msg) {
      if (taken) passes.restore(taken);
      throw new Error('Pass storage changed. Recover the original authorization before sending.');
    }
    return pass;
    });
  }
  async function authorize() {
    const op = state.operation;
    if (op.intent.kind !== 'payroll' || op.authorized) return;
    const info = await fetch('/api/pass/info', { cache: 'no-store' }).then(r => r.json());
    const pass = await passForOperation(info);
    const result = await signedAction('authorize', { pass });
    if (result?.ok !== true || !/^[a-f0-9]{64}$/.test(result.grant || '')) throw new Error('Pass authorization was not confirmed. Keep the saved operation and recover the same request.');
    // A response lost after redemption is retried with this same stored pass.
    // Remove only the matching credit; never consume another FIFO credit.
    const existing = passes.all();
    if (existing.some(p => p.msg === pass.msg)) {
      const taken = [];
      while (passes.count(pass.kid, false)) {
        const item = passes.take(pass.kid, false);
        if (item.msg === pass.msg) break;
        taken.push(item);
      }
      if (taken.length) passes.add(taken);
    }
    op.authorized = true; save(); localStorage.removeItem(PASS);
  }
  async function reconcileOne(i, settlementSignature) {
    const op = state.operation, r = op.records[i], e = await live();
    if (!r.signature) return;
    const source = await e.status(r, op.intent, op.intent.payments[i]);
    r.status = source.status; save();
    if (source.status === 'source-confirmed' || source.status === 'confirmed') {
      if (op.intent.kind === 'payroll') await authorize();
      const result = await e.settlement(op.intent, op.intent.payments[i], r, settlementSignature);
      Object.assign(r, result); save();
    }
  }
  async function execute() {
    return task('Starting the reviewed mainnet operation.', async () => {
      wallet();
      if (!navigator.locks) throw new Error('This browser cannot lock a safe mainnet run.');
      if (!state.reviewed || !state.quotes) throw new Error('Review recipients and full costs first.');
      if (!confirm('MAINNET USDC: approve only the recipients and maximum upfront costs shown. MagicBlock uses a TEE, not a ZK pool. Each transaction needs your wallet signature. Payroll costs one pass once funding is confirmed; other actions are free of pass charges.')) return false;
      return navigator.locks.request('dm_magicblock_execution', { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('Another tab is running MagicBlock.');
        const op = state.operation, stored = restoreMagicblockOperation(read(KEY));
        if (!stored || stored.intent.id !== op.intent.id || JSON.stringify(stored.records) !== JSON.stringify(restoreMagicblockOperation(op).records)) throw new Error('This operation changed in another tab. Reload and check receipts.');
        stop = false;
        const info = await fetch('/api/pass/info', { cache: 'no-store' }).then(r => r.json());
        const pass = op.intent.kind === 'payroll' && !op.authorized ? await passForOperation(info) : null;
        await signedAction('reserve', pass ? { pass } : {});
        op.reserved = true; save();
        const e = await live();
        try {
          for (let i = 0; i < op.records.length; i++) {
            if (stop) break;
            wallet();
            const r = op.records[i];
            if (r.status === 'confirmed') continue;
            if (unresolved(r)) throw new Error('An unresolved row must be checked, never resent.');
            const approved = state.quotes[i];
            if (!approved) throw new Error('A fresh quote is required.');
            const q = await e.quote(op.intent, op.intent.payments[i], r);
            if (BigInt(q.fees.totalLamports) > BigInt(approved.fees.totalLamports)
              || BigInt(q.fees.tokenUnits) > BigInt(approved.fees.tokenUnits)) throw new Error('Current costs exceed the approved maximum. Review the remaining payments again.');
            state.phase = `Approve ${i + 1}/${op.records.length} in your wallet. Stop takes effect after this transaction.`; emit();
            await e.signAndSend(q, r, save);
            state.phase = `Checking source transaction ${i + 1}/${op.records.length}. Confirmation is not recipient settlement.`; emit();
            for (let attempt = 0; attempt < 8; attempt++) {
              await reconcileOne(i);
              if (['source-confirmed', 'confirmed', 'failed'].includes(r.status)) break;
              if (stop) break;
              await new Promise(resolve => setTimeout(resolve, 1500));
            }
            if (!['source-confirmed', 'confirmed'].includes(r.status)) break;
          }
        } finally {
          state.reviewed = false; state.quotes = null;
          for (const r of op.records) if (r.status === 'awaiting-wallet') r.status = 'pending';
          save();
        }
        return true;
      });
    });
  }
  const check = (index, signature) => task('Checking saved signatures and recipient settlement. No resend.', async () => {
    wallet();
    if (signature && !sigOK(signature)) throw new Error('Enter a valid settlement signature.');
    const op = state.operation;
    if (!op) throw new Error('No saved MagicBlock operation.');
    if (op.records.some(r => r.signature)) {
      const recovered = await signedAction('recover');
      if (!recovered?.verified) throw new Error('The original payment reservation could not be verified. Nothing was resent.');
      if (recovered.authorized) { op.authorized = true; save(); }
    }
    const indexes = Number.isInteger(index) ? [index] : op.records.map((r, i) => i);
    for (const i of indexes) {
      if (!op.records[i]) throw new Error('Invalid receipt row.');
      if (op.records[i].status === 'confirmed' && !signature) continue;
      await reconcileOne(i, signature);
    }
    return true;
  });
  async function clear() {
    if (state.busy || state.operation?.records.some(unresolved)) throw new Error('Keep signed or unresolved operations until they are reconciled.');
    return task('Checking recovery state before clearing.', async () => {
    unchangedStorage();
    const pending = read(PASS);
    if (pending) {
      if (pending.id !== state.operation?.intent.id) throw new Error('Recover the previous pass authorization first.');
      if (state.operation.records.some(r => r.signature) && !state.operation.authorized) {
        const e = await live();
        for (const r of state.operation.records.filter(r => r.signature)) {
          if ((await e.status(r, state.operation.intent, state.operation.intent.payments[r.index])).status !== 'failed') throw new Error('A source payment is not proven failed. Check it before clearing.');
        }
        const result = await signedAction('pass-state', { pass: pending.pass });
        if (result.spent) { await authorize(); }
        else { passes.restore(pending.pass); localStorage.removeItem(PASS); }
      } else {
        if (!state.operation.authorized) passes.restore(pending.pass);
        localStorage.removeItem(PASS);
      }
    }
    localStorage.removeItem(KEY); lastStored = null; state.operation = null; state.quotes = null; state.reviewed = false; emit();
    return true;
    });
  }
  function importBackup(text) {
    if (state.busy || state.operation) throw new Error('Keep or clear the current operation before restoring another.');
    if (typeof text !== 'string' || text.length > 100000) throw new Error('Invalid MagicBlock backup.');
    const op = restoreMagicblockOperation(JSON.parse(text), true);
    if (!op) throw new Error('The backup is empty.');
    state.operation = op; state.quotes = null; state.reviewed = false; save();
  }
  return { state, prepare, review, execute, check, readBalance, refresh, clear, importBackup,
    stop() { stop = true; state.phase = 'Stopping after the current transaction. Pending signatures will be kept.'; emit(); },
    backup() { if (!state.operation) throw new Error('No operation to export.'); return JSON.stringify(restoreMagicblockOperation(state.operation), null, 2); },
    walletChanged() { engine?.clear(); engine = null; engineWallet = null; state.balance = null; state.quotes = null; state.reviewed = false; void refresh(); },
  };
}
