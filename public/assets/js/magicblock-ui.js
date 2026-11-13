// MagicBlock executor presentation. Renders controller state only; never
// renders or persists tokens, raw transactions or private balances.
import { MAGICBLOCK_TRUST, formatMagicblockUnits as fu } from './magicblock-contract.js';
import { parsePayroll } from './payroll.js';

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  kids.flat().forEach((c) => c != null && c !== false && n.append(c));
  return n;
};
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
const utc = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`; };
const units = (amount) => BigInt(Math.round(Number(amount) * 1e6));
const usdc = (u) => `${fu(String(u), 6)} USDC`;
const sol = (l) => `${fu(String(l), 9)} SOL`;
const sigOK = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s);
const UNRESOLVED = ['signed', 'submitted', 'source-confirmed', 'uncertain'];
const STATUS = {
  pending: ['Not sent', 'Nothing submitted for this row.'],
  'awaiting-wallet': ['Awaiting wallet', 'Approve or reject in your wallet.'],
  signed: ['Signed', 'Signed but not proven submitted. Check only, never resend.'],
  submitted: ['Submitted', 'Sent to the network. Not yet confirmed.'],
  'source-confirmed': ['Source confirmed', 'Your transaction landed. Recipient is NOT paid until settlement is proven.'],
  confirmed: ['Confirmed', 'Settlement to the recipient is proven.'],
  uncertain: ['Uncertain', 'Outcome unknown. Check only. Do not resend.'],
  failed: ['Failed', 'Not paid. Review again before retrying.'],
};
const KINDS = {
  send: ['Private send', 'One recipient. No pass.'],
  payroll: ['Payroll batch', 'Multiple recipients. 1 pass per batch.'],
  deposit: ['Deposit', 'Public USDC into your own private balance. No pass.'],
  withdraw: ['Withdraw', 'Private USDC back to your own wallet. No pass.'],
};

export function createMagicblockUI({ root, mb, getWallet, getAIPayments, announce }) {
  let err = '';
  let lastWallet;
  const settleDraft = new Map();
  const say = (t) => announce?.(t);

  async function run(fn, ok) {
    err = '';
    try {
      const r = await fn();
      if (r === false) { if (mb.state.error) say(mb.state.error); }
      else if (ok) say(ok);
    } catch (e) { err = e?.message || 'Something went wrong.'; say(err); }
    render();
  }

  /* ---------- static form (built once so focus and drafts survive renders) ---------- */
  let kind = 'send', source = 'base';
  const kindGroup = el('div', { class: 'mb-seg', role: 'radiogroup', 'aria-label': 'Operation type' });
  const kindBtns = Object.entries(KINDS).map(([k, [label, sub]]) => {
    const b = el('button', { type: 'button', role: 'radio', class: 'mb-seg-b', 'data-kind': k }, el('b', { text: label }), el('small', { text: sub }));
    b.addEventListener('click', () => { kind = k; if (k === 'deposit') source = 'base'; if (k === 'withdraw') source = 'ephemeral'; err = ''; render(); });
    kindGroup.append(b); return b;
  });
  const srcSel = el('select', { id: 'mb-source', class: 'mb-in', tabindex: '0' },
    el('option', { value: 'base', text: 'Public wallet USDC (base)' }),
    el('option', { value: 'ephemeral', text: 'Private MagicBlock USDC (ephemeral)' }));
  srcSel.addEventListener('change', () => { source = srcSel.value; });
  const recIn = el('input', { id: 'mb-recipient', class: 'mb-in mono', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'Recipient Solana address' });
  const amtIn = el('input', { id: 'mb-amount', class: 'mb-in mono', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00' });
  const batchIn = el('textarea', { id: 'mb-batch', class: 'mono', rows: '6', spellcheck: 'false', 'aria-describedby': 'mb-batch-hint', placeholder: 'recipient,amount,token\n7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU,12.50,USDC' });
  const recWrap = el('div', { class: 'mb-field' }, el('label', { for: 'mb-recipient', class: 'field-lab', text: 'Recipient' }), recIn);
  const ownWrap = el('p', { class: 'hint mb-own' });
  const amtWrap = el('div', { class: 'mb-field' }, el('label', { for: 'mb-amount', class: 'field-lab', text: 'Amount (USDC)' }), amtIn);
  const srcWrap = el('div', { class: 'mb-field' }, el('label', { for: 'mb-source', class: 'field-lab', text: 'Pay from' }), srcSel);
  const batchWrap = el('div', { class: 'mb-field' }, el('label', { for: 'mb-batch', class: 'field-lab', text: 'Recipients (USDC only)' }), batchIn,
    el('p', { id: 'mb-batch-hint', class: 'hint', text: 'One per line: ADDRESS,AMOUNT,USDC. Optional header recipient,amount,token. No duplicates.' }));
  const prepBtn = el('button', { class: 'btn primary', type: 'button', text: 'Prepare · free' });
  const aiBtn = el('button', { class: 'btn', type: 'button', text: 'Load AI Pack USDC plan' });
  const restoreIn = el('textarea', { id: 'mb-restore', class: 'mono', rows: '3', spellcheck: 'false', placeholder: 'Paste an exported MagicBlock backup' });
  const restoreBtn = el('button', { class: 'btn', type: 'button', text: 'Restore backup' });
  const formMsg = el('div', { 'aria-live': 'polite' });
  const form = el('div', { class: 'mb-form' }, kindGroup,
    el('div', { class: 'mb-grid' }, recWrap, ownWrap, amtWrap, srcWrap), batchWrap, formMsg,
    el('div', { class: 'row-actions' }, prepBtn, aiBtn),
    el('details', { class: 'mb-restore' }, el('summary', { text: 'Restore an exported MagicBlock backup' }),
      el('label', { for: 'mb-restore', class: 'field-lab', text: 'Backup JSON' }), restoreIn, el('div', { class: 'row-actions' }, restoreBtn)));

  prepBtn.addEventListener('click', () => run(() => {
    const w = getWallet();
    let payments;
    if (kind === 'payroll') payments = parsePayroll(batchIn.value, { USDC: mb.state.info?.maxBatchUSDC || 500, SOL: 0 });
    else {
      const a = amtIn.value.trim();
      if (!/^\d+(\.\d{1,6})?$/.test(a) || !(Number(a) > 0)) throw new Error('Enter a USDC amount with at most 6 decimals.');
      const recipient = kind === 'deposit' || kind === 'withdraw' ? w?.address : recIn.value.trim();
      if (!recipient) throw new Error('Enter a recipient address.');
      payments = [{ recipient, amount: Number(a), token: 'USDC' }];
    }
    if (payments.some((p) => p.token !== 'USDC')) throw new Error('MagicBlock accepts USDC only.');
    mb.prepare({ kind, source: kind === 'deposit' ? 'base' : kind === 'withdraw' ? 'ephemeral' : source, payments });
  }, 'Operation prepared. Review next. Nothing has moved.'));
  aiBtn.addEventListener('click', () => run(() => {
    const p = getAIPayments();
    if (!p?.length) throw new Error('No AI Pack plan is loaded on this page.');
    if (p.some((x) => x.token !== 'USDC')) throw new Error('The AI Pack plan is not USDC. MagicBlock accepts USDC only.');
    const k = p.length === 1 ? 'send' : 'payroll';
    kind = k;
    mb.prepare({ kind: k, source, payments: p.map((x) => ({ recipient: x.recipient, amount: Number(x.amount), token: 'USDC' })) });
  }, 'AI Pack plan loaded into MagicBlock. Private Payroll was not changed.'));
  restoreBtn.addEventListener('click', () => run(() => { mb.importBackup(restoreIn.value); restoreIn.value = ''; }, 'Backup restored. Check receipts before any new action.'));

  const statusBox = el('div', { class: 'mb-live' });
  const errBox = el('div', { class: 'mb-err', role: 'alert', 'aria-live': 'assertive' });
  root.append(el('div', { class: 'mb-trust' },
    el('b', { text: 'Trust model' }), el('p', { text: MAGICBLOCK_TRUST }),
    el('p', { class: 'hint', text: 'Data disclosure: your wallet address, every recipient and every amount are sent to Scorechain for sanctions screening and to MagicBlock to build and settle transactions.' })),
    errBox, el('div', { class: 'mb-gate' }), form, statusBox);
  const gate = root.querySelector('.mb-gate');

  /* ---------- dynamic ---------- */
  function availability(s, w) {
    if (!w) return 'Connect a wallet to check MagicBlock beta eligibility.';
    if (w.demo) return 'MagicBlock needs a real Solana wallet, not demo mode.';
    if (!s.info) return 'Eligibility could not be confirmed for this wallet. MagicBlock stays off until it is.';
    if (!s.info.enabled) return s.info.reason || 'This internal mainnet beta is limited to allowlisted wallets. Your wallet is not enabled. Private Payroll above is unaffected.';
    return '';
  }

  function costRows(op, quotes) {
    let gross = 0n, net = 0n, tok = 0n, opL = 0n, netL = 0n, setL = 0n, totL = 0n, n = 0;
    op.intent.payments.forEach((p, i) => {
      const q = quotes?.[i]; if (!q) return;
      n++; gross += units(p.amount); net += BigInt(q.recipientUnits);
      tok += BigInt(q.fees.tokenUnits); opL += BigInt(q.fees.operationLamports); netL += BigInt(q.fees.networkLamports);
      setL += BigInt(q.fees.setupLamports); totL += BigInt(q.fees.totalLamports);
    });
    const at = quotes.filter(Boolean).map((q) => q.reviewedAt).sort()[0];
    const separated = quotes.filter(Boolean).every(q => q.fees.operationFeeSeparated !== false);
    const row = (k, v, strong) => el('div', { class: strong ? 'mb-cost-row total' : 'mb-cost-row' }, el('dt', { text: k }), el('dd', { text: v }));
    return el('div', { class: 'mb-cost', role: 'region', 'aria-label': 'Reviewed maximum costs' },
      el('h3', { text: `Reviewed · ${n} payment${n === 1 ? '' : 's'}${at ? ` · ${utc(at)}` : ''}` }),
      el('dl', {}, row('Gross', usdc(gross)), row('MagicBlock token fee', usdc(tok)), row('Recipients receive (net)', usdc(net), true),
        row('Operation fee', separated ? sol(opL) : 'Included in combined maximum'),
        row('Network fee maximum', sol(netL)), row(separated ? 'Account setup / rent' : 'Program fees / setup combined', sol(setL + (separated ? 0n : opL))), row('Maximum upfront SOL', sol(totL), true),
        row('Duskmoth fee', 'None'), row('Moth Pass', op.intent.kind === 'payroll' ? (op.authorized ? 'Already paid' : mb.state.passReserved ? '1 pass reserved for this operation' : '1 pass on execute') : 'None')),
      el('p', { class: 'hint', text: 'Conservative maximum across isolated simulations. Rent and setup may be counted more than once and are rechecked before each signature. Not a guaranteed final charge.' }));
  }

  function recordCell(op, r, i, busy) {
    const [label, detail] = r.status === 'confirmed' && op.intent.kind === 'deposit'
      ? ['Deposit processed', 'Verified source, closed-shuttle TEE receipt and authenticated private state. Read the current balance separately. Not a public recipient-payment receipt.']
      : STATUS[r.status] || [r.status, ''];
    const links = [];
    const sigLink = (sig, rt, what) => {
      if (!sig) return null;
      if (rt === 'base') return el('a', { href: `https://solscan.io/tx/${sig}`, target: '_blank', rel: 'noopener', text: `${what} on Solscan ${short(sig)}` });
      return el('button', { class: 'mb-copy', type: 'button', text: `Copy private ${what.toLowerCase()} signature ${short(sig)}`,
        onclick: () => navigator.clipboard?.writeText(sig).then(() => say('Signature copied.'), () => say('Copy failed.')) });
    };
    links.push(sigLink(r.signature, r.runtime, 'Source'), sigLink(r.settlementSignature, r.settlementRuntime, 'Settlement'));
    const canCheck = r.signature && r.status !== 'confirmed';
    const id = `mb-set-${i}`;
    const inp = el('input', { id, class: 'sig-in', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'Settlement signature (optional)', 'data-mbsig': String(i), disabled: busy });
    inp.value = settleDraft.get(i) || '';
    inp.addEventListener('input', () => settleDraft.set(i, inp.value.trim()));
    return el('td', {},
      el('span', { class: `st mb-${r.status}`, text: label }), el('span', { class: 'mb-detail', text: detail }),
      el('span', { class: 'mb-links' }, links),
      canCheck ? el('div', { class: 'sig-box' },
        el('label', { for: id, class: 'field-lab', text: `Known settlement signature for row ${i + 1}` }), inp,
        el('button', { class: 'btn', type: 'button', disabled: busy, text: 'Check row · no resend', onclick: () => {
          const v = settleDraft.get(i) || '';
          if (v && !sigOK(v)) { err = `Row ${i + 1}: not a valid signature.`; say(err); render(); return; }
          run(async () => { const r2 = await mb.check(i, v || undefined); if (r2 !== false) settleDraft.delete(i); return r2; }, `Row ${i + 1} checked. Nothing was resent.`);
        } })) : null);
  }

  function renderOp(s, ready, w) {
    const op = s.operation;
    const recs = op.records;
    const busy = s.busy;
    const unresolved = recs.some((r) => UNRESOLVED.includes(r.status));
    const allDone = recs.every((r) => r.status === 'confirmed');
    const owner = op.intent.owner;
    const walletOK = w?.address === owner;
    const counts = Object.entries(recs.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {}));
    const gross = op.intent.payments.reduce((t, p) => t + units(p.amount), 0n);
    const out = [];
    out.push(el('div', { class: 'batch-sum' },
      el('span', {}, 'Type ', el('b', { text: KINDS[op.intent.kind][0] })),
      el('span', {}, 'From ', el('b', { text: op.intent.source === 'base' ? 'Public wallet' : 'Private balance' })),
      el('span', {}, 'Recipients ', el('b', { text: String(recs.length) })),
      el('span', {}, 'Gross ', el('b', { text: usdc(gross) })),
      el('span', {}, 'Owner ', el('b', { text: short(owner), title: owner }))));
    out.push(el('p', { class: 'mb-counts', text: counts.map(([k, n]) => `${n} ${(STATUS[k] || [k])[0].toLowerCase()}`).join(' · ') }));
    if (!walletOK) out.push(el('p', { class: 'err-line', text: `This operation belongs to ${short(owner)}. Reconnect that wallet to review, execute or check.` }));
    if (busy) out.push(el('p', { class: 'working', role: 'status' }, el('i'), s.phase || 'Working…'));
    if (unresolved) out.push(el('p', { class: 'err-line', text: 'Some rows are signed, submitted, source-confirmed or uncertain. Duskmoth never resends automatically. Use Check to read chain status; reviews and new sends stay locked until every row is resolved.' }));
    if (s.reviewed && s.quotes) out.push(costRows(op, s.quotes));
    out.push(el('div', { class: 'ledger-wrap', tabindex: '0', role: 'region', 'aria-label': 'MagicBlock receipts. Scroll horizontally for more columns.' },
      el('table', { class: 'ledger' }, el('caption', { text: s.reviewed ? 'Reviewed payments and receipts' : 'Prepared payments and receipts' }),
        el('thead', {}, el('tr', {}, ['#', 'Recipient', 'Amount', 'Max fee', 'Receives', 'Status'].map((h, i) => el('th', { scope: 'col', class: i >= 2 && i <= 4 ? 'n' : '', text: h })))),
        el('tbody', {}, op.intent.payments.map((p, i) => {
          const q = s.quotes?.[i]; const r = recs[i];
          const rec = q?.recipientUnits || r.recipientUnits;
          return el('tr', {}, el('td', { class: 'idx', text: String(i + 1) }), el('td', { class: 'addr', title: p.recipient, text: p.recipient }),
            el('td', { class: 'n', text: usdc(units(p.amount)) }), el('td', { class: 'n', text: q ? usdc(q.fees.tokenUnits) : '—' }),
            el('td', { class: 'n', text: rec ? usdc(rec) : '—' }), recordCell(op, r, i, busy));
        })))));
    const canExec = ready && walletOK && s.reviewed && !!s.quotes && !busy && !unresolved && !allDone;
    const execWhy = !ready ? 'MagicBlock is not available for this wallet.' : !walletOK ? 'Connect the owning wallet.' : busy ? 'Wait for the current step.'
      : unresolved ? 'Resolve every row with Check first.' : allDone ? 'All rows are confirmed.' : !s.reviewed ? 'Review first. Reviews are free and move no funds or passes.' : '';
    out.push(el('p', { id: 'mb-exec-why', class: 'hint', role: 'status', text: execWhy || 'Ready. Each transaction needs your wallet signature. Stop takes effect after the current transaction.' }));
    const acts = el('div', { class: 'row-actions' });
    if (!allDone) acts.append(el('button', { class: s.reviewed ? 'btn' : 'btn primary', type: 'button', disabled: !ready || !walletOK || busy || unresolved,
      text: s.reviewed ? 'Review again · free' : 'Review · free, nothing moves', onclick: () => run(() => mb.review(), 'Review complete. Check maximum costs before executing.') }));
    if (!allDone) acts.append(el('button', { class: 'btn primary', type: 'button', disabled: !canExec, 'aria-describedby': 'mb-exec-why',
      text: op.intent.kind === 'payroll' && !op.authorized ? 'Execute on mainnet · 1 pass' : 'Execute on mainnet', onclick: () => run(() => mb.execute(), 'Execution finished. Check each row status.') }));
    if (busy) acts.append(el('button', { class: 'btn danger', type: 'button', text: 'Stop after current transaction', onclick: () => { mb.stop(); say('Stopping after the current transaction.'); } }));
    if (recs.some((r) => r.signature && r.status !== 'confirmed')) acts.append(el('button', { class: 'btn', type: 'button', disabled: busy || !walletOK, text: 'Check all · no resend', onclick: () => run(() => mb.check(), 'All rows checked. Nothing was resent.') }));
    acts.append(el('button', { class: 'btn', type: 'button', text: 'Export backup (.json)', onclick: exportBackup }));
    acts.append(el('button', { class: 'btn danger', type: 'button', disabled: busy || unresolved, text: 'Clear operation', onclick: () => run(() => mb.clear(), 'Operation cleared.') }));
    out.push(acts);
    out.push(el('p', { class: 'hint', text: 'The backup links your wallet to these recipients, amounts and signatures, which can be public on-chain. Keep it private. It never contains tokens, keys or private balances.' }));
    return out;
  }

  function exportBackup() {
    try {
      const url = URL.createObjectURL(new Blob([mb.backup()], { type: 'application/json' }));
      const a = el('a', { href: url, download: `duskmoth-magicblock-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
      say('MagicBlock backup downloaded.');
    } catch (e) { err = e?.message || 'Export failed.'; say(err); render(); }
  }

  function render() {
    const s = mb.state, w = getWallet();
    const f = document.activeElement;
    const keep = f?.dataset?.mbsig != null ? { i: f.dataset.mbsig, a: f.selectionStart, b: f.selectionEnd } : null;
    const why = availability(s, w);
    const ready = !why;
    gate.replaceChildren(why ? el('p', { class: 'hint mb-why', text: why })
      : el('div', { class: 'mb-bal' },
        el('span', {}, 'Private USDC ', el('b', { text: s.balance?.units != null ? usdc(s.balance.units) : 'Not read' })),
        el('button', { class: 'btn', type: 'button', disabled: s.busy, text: 'Read private balance', onclick: () => run(() => mb.readBalance('ephemeral'), 'Private balance read. Held in memory only.') }),
        el('button', { class: 'btn', type: 'button', disabled: s.busy, text: 'Refresh eligibility', onclick: () => run(() => mb.refresh(), 'Eligibility refreshed.') })));
    kindBtns.forEach((b) => { const on = b.dataset.kind === kind; b.setAttribute('aria-checked', on ? 'true' : 'false'); b.classList.toggle('on', on); });
    const own = kind === 'deposit' || kind === 'withdraw';
    recWrap.hidden = own || kind === 'payroll'; amtWrap.hidden = kind === 'payroll'; batchWrap.hidden = kind !== 'payroll';
    srcWrap.hidden = own; ownWrap.hidden = !own;
    ownWrap.textContent = own ? `Returns to your connected wallet only: ${w ? short(w.address) : 'not connected'}.` : '';
    srcSel.value = source;
    const hasOp = !!s.operation;
    form.hidden = hasOp;
    const ai = getAIPayments();
    prepBtn.disabled = !ready || s.busy;
    aiBtn.disabled = !ready || s.busy || !ai?.length || ai.some((x) => x.token !== 'USDC');
    aiBtn.title = !ai?.length ? 'Generate an AI Pack plan above first.' : ai.some((x) => x.token !== 'USDC') ? 'Plan is not USDC.' : '';
    restoreBtn.disabled = s.busy;
    formMsg.replaceChildren(...(ready ? [el('p', { class: 'hint', text: 'Preparing and reviewing are free. Execute submits real mainnet USDC transactions after your confirmation.' })] : []));
    errBox.replaceChildren(...[...new Set([s.error, err].filter(Boolean))].map((m) => el('p', { class: 'err-line', text: m })));
    statusBox.replaceChildren(...(hasOp ? renderOp(s, ready, w) : [el('div', { class: 'empty-state' }, el('b', { text: 'No MagicBlock operation' }),
      ready ? 'Choose a type above, or load an AI Pack USDC plan. Nothing is sent until you review and execute.' : 'Nothing is prepared or running on MagicBlock for this browser.')]));
    if (keep) { const n = root.querySelector(`[data-mbsig="${keep.i}"]`); if (n && !n.disabled) { n.focus(); try { n.setSelectionRange(keep.a, keep.b); } catch { /* ignore */ } } }
  }

  // Called from the page render callback: cheap compare, network only on change.
  function syncWallet() {
    const w = getWallet();
    const addr = w && !w.demo ? (w.provider?.publicKey?.toString() || w.address) : '';
    if (addr === lastWallet) return;
    const first = lastWallet === undefined;
    lastWallet = addr;
    if (first) void mb.refresh(); else mb.walletChanged();
  }

  window.addEventListener('beforeunload', (e) => {
    const s = mb.state;
    if (s.busy || s.operation?.records.some((r) => UNRESOLVED.includes(r.status) || r.status === 'awaiting-wallet')) { e.preventDefault(); e.returnValue = ''; }
  });

  return { render, syncWallet };
}
