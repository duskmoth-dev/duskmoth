import { initCommon } from './fx.js';
import { payrollReadiness } from './payroll-readiness.js';
import { payrollProgress } from './payroll-progress.js';
import { createMagicblockPayments } from './magicblock-payments.js';
import { createMagicblockUI } from './magicblock-ui.js';
import { createPremiumTools } from './premium-tools.js';
import { walletHelp } from './wallet-discovery.js';

initCommon('docs');

const $ = (s, r = document) => r.querySelector(s);
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
const fmt = (n) => (n == null || n === '' || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 9 }));
const isSig = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s);
const isAddr = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const utc = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};
const MAX = 20;

const sessionBox = $('[data-session]');
const globalMsg = $('[data-global-msg]');
const announcer = $('[data-announce]');
const aiForm = $('[data-ai-form]');
const aiPrompt = $('#ai-prompt');
const aiGen = $('[data-ai-generate]');
const aiRecover = $('[data-ai-recover]');
const aiOut = $('[data-ai-out]');
const payRoot = $('[data-payroll]');

let ctl = null;
let mbUI = null;
let localErr = '';
let lastAnnounce = '';
const announce = (t) => { if (t && t !== lastAnnounce) { lastAnnounce = t; announcer.textContent = t; } };

async function act(fn, okText) {
  localErr = '';
  lastAnnounce = ''; announcer.textContent = '';
  try {
    const result = await fn();
    if (result !== false && okText) announce(okText);
  } catch (e) {
    localErr = e?.message || String(e) || 'Something went wrong.';
    announce(localErr);
  }
  render(ctl?.state);
}

/* ---------- payroll static input block ---------- */
const payText = el('textarea', { id: 'pay-input', class: 'mono', rows: '8', spellcheck: 'false', 'aria-describedby': 'pay-hint pay-check', placeholder: 'recipient,amount,token\n7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU,0.05,SOL' });
const fileIn = el('input', { type: 'file', accept: '.csv,text/csv,text/plain,application/json,.json', hidden: true, 'aria-label': 'Choose CSV or backup file' });
const checkBox = el('div', { id: 'pay-check', 'aria-live': 'polite' });
const prepBtn = el('button', { class: 'btn primary', type: 'button', text: 'Prepare batch' });
const csvBtn = el('button', { class: 'btn', type: 'button', text: 'Load CSV file' });
const importBtn = el('button', { class: 'btn', type: 'button', text: 'Restore from backup text' });
let fileMode = 'csv';
const inputBlock = el('div', { class: 'pay-input' },
  el('label', { for: 'pay-input', class: 'field-lab', text: 'Recipients (manual lines or CSV)' }),
  payText,
  el('p', { id: 'pay-hint', class: 'hint', text: `One per line: ADDRESS,AMOUNT,TOKEN. Optional header recipient,amount,token. One token per batch, no duplicates, at most ${MAX} recipients.` }),
  checkBox,
  el('div', { class: 'row-actions' }, prepBtn, csvBtn, importBtn, fileIn));
const batchBox = el('div', { class: 'batch', 'aria-live': 'polite' });
payRoot.append(inputBlock, batchBox);

function precheck(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && /^recipient\s*,/i.test(lines[0])) lines.shift();
  const seen = new Set();
  const tokens = new Set();
  const rows = lines.map((l, i) => {
    const [r = '', a = '', t = ''] = l.split(',').map((x) => x.trim());
    const tok = t.toUpperCase();
    const issues = [];
    if (!isAddr(r)) issues.push('invalid address');
    if (!(Number(a) > 0) || !/^\d*\.?\d+$/.test(a)) issues.push('invalid amount');
    if (tok !== 'SOL' && tok !== 'USDC') issues.push('token must be SOL or USDC');
    else tokens.add(tok);
    if (seen.has(r)) issues.push('duplicate recipient');
    seen.add(r);
    return { line: i + 1, r, a, tok, issues };
  });
  const batch = [];
  if (rows.length > MAX) batch.push(`${rows.length} recipients exceeds the ${MAX}-recipient limit.`);
  if (tokens.size > 1) batch.push('Mixed tokens: use one token per batch.');
  return { rows, batch, ok: rows.length > 0 && !batch.length && rows.every((r) => !r.issues.length) };
}

function renderCheck() {
  const c = precheck(payText.value);
  checkBox.replaceChildren();
  if (!c.rows.length) return c;
  const bad = c.rows.filter((r) => r.issues.length);
  c.batch.forEach((b) => checkBox.append(el('p', { class: 'err-line', text: b })));
  if (bad.length) {
    checkBox.append(el('div', { class: 'ledger-wrap' }, el('table', { class: 'ledger' },
      el('caption', { text: `${bad.length} line${bad.length > 1 ? 's' : ''} need attention` }),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: 'Line' }), el('th', { scope: 'col', text: 'Recipient' }), el('th', { scope: 'col', text: 'Issue' }))),
      el('tbody', {}, bad.map((r) => el('tr', {}, el('td', { class: 'idx', text: String(r.line) }), el('td', { class: 'addr', text: r.r ? short(r.r) : '—' }), el('td', { text: r.issues.join(', ') })))))));
  } else if (!c.batch.length) {
    checkBox.append(el('p', { class: 'ok-line', text: `${c.rows.length} line${c.rows.length > 1 ? 's' : ''} look valid locally. Server checks run on prepare.` }));
  }
  return c;
}
payText.addEventListener('input', () => { renderCheck(); render(ctl?.state); });

prepBtn.addEventListener('click', () => act(() => ctl.preparePayroll(payText.value), 'Batch prepared. Review fees next.'));
csvBtn.addEventListener('click', () => { fileMode = 'csv'; fileIn.click(); });
importBtn.addEventListener('click', () => act(() => ctl.importPayroll(payText.value), 'Batch restored from backup text.'));
fileIn.addEventListener('change', async () => {
  const f = fileIn.files?.[0];
  fileIn.value = '';
  if (!f) return;
  const text = await f.text();
  if (fileMode === 'json') return act(() => ctl.importPayroll(text), 'Batch restored from backup file.');
  payText.value = text;
  renderCheck();
  render(ctl?.state);
  announce(`Loaded ${f.name}.`);
});

/* ---------- AI ---------- */
aiForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const p = aiPrompt.value.trim();
  if (!p) { localErr = 'Write a prompt with explicit addresses and amounts first.'; render(ctl?.state); aiPrompt.focus(); return; }
  act(() => ctl.generateAI(p), 'Plan generated.');
});
aiRecover.addEventListener('click', () => act(() => ctl.recoverAI(), 'Recovery checked.'));

/* ---------- rendering ---------- */
function renderSession(s) {
  sessionBox.setAttribute('aria-busy', s.loading || s.connecting ? 'true' : 'false');
  if (s.loading && !s.wallet && !s.config) {
    sessionBox.replaceChildren(el('div', { class: 'sk' }), el('div', { class: 'sk short' }));
    return;
  }
  const kids = [];
  if (s.wallet) {
    kids.push(el('div', { class: 'who' }, el('small', { text: `Connected · ${s.wallet.name || 'Wallet'}` }), el('span', { text: short(s.wallet.address), title: s.wallet.address })));
  } else {
    kids.push(el('div', { class: 'who' }, el('small', { text: 'Wallet' }), el('span', { text: s.wallets.length ? 'Connect to use the tools. Keys stay in your wallet.' : 'No Solana wallet detected in this browser.' })));
  }
  kids.push(el('div', { class: 'stat' }, el('b', { text: String(s.credits ?? 0) }), el('small', { text: 'passes in this browser' })));
  const acts = el('div', { class: 'acts' });
  if (s.wallet) {
    acts.append(el('button', { class: 'btn', type: 'button', disabled: s.loading, text: 'Refresh', onclick: () => act(() => ctl.refresh(), 'Refreshed.') }),
      el('button', { class: 'btn', type: 'button', disabled: !!s.payroll?.busy, text: 'Disconnect', onclick: () => act(() => ctl.disconnect(), 'Wallet disconnected.') }));
  } else {
    s.wallets.forEach((w) => acts.append(el('button', { class: 'btn primary', type: 'button', disabled: s.loading || s.connecting, text: s.connecting ? 'Approve in wallet…' : `Connect ${w.name}`, onclick: () => act(() => ctl.connect(w.id), `Connected ${w.name}.`) })));
    if (!s.wallets.length) kids.push(walletHelp());
  }
  if (!s.credits) acts.append(el('a', { class: 'btn', href: '/pass', style: 'display:inline-flex;align-items:center;text-decoration:none', text: 'Get passes' }));
  kids.push(acts);
  sessionBox.replaceChildren(...kids);
}

function disabledReason(s) {
  if (!ctl) return 'Tools are loading.';
  if (s.passInfo && s.passInfo.enabled === false) return s.passInfo.reason || 'Moth Pass features are currently unavailable.';
  if (!s.wallet) return 'Connect a wallet first.';
  return '';
}

function aiReason(s) {
  if (!ctl) return 'Tools are loading.';
  if (s.passInfo && s.passInfo.enabled === false) return s.passInfo.reason || 'Moth Pass features are currently unavailable.';
  if (s.passInfo?.features?.['ai-pack']?.enabled === false) return s.passInfo.features['ai-pack'].reason || 'AI Pack is currently unavailable.';
  return '';
}

function renderAI(s) {
  const why = aiReason(s);
  const ai = s.ai || {};
  aiPrompt.disabled = !!ai.busy;
  aiGen.disabled = !!why || ai.busy || s.credits < 1;
  aiGen.textContent = ai.busy ? 'Generating…' : 'Generate plan · 1 pass';
  aiRecover.disabled = !!ai.busy || !ctl;
  const out = [];
  if (why) out.push(el('p', { class: 'hint', text: why }));
  else if (s.credits < 1) out.push(el('p', { class: 'hint', text: 'You need 1 pass to generate a plan. No wallet needed. Recovery is free.' }));
  if (ai.busy) out.push(el('p', { class: 'working' }, el('i'), 'Structuring your prompt. A pass is spent only if a plan comes back.'));
  if (ai.error) out.push(el('p', { class: 'err-line', role: 'alert', text: ai.error }));
  const r = ai.result;
  if (r) {
    const token = r.payments?.[0]?.token || '';
    const total = (r.payments || []).reduce((t, p) => t + Number(p.amount || 0), 0);
    out.push(el('div', { class: 'plan' },
      el('h3', { text: `Generated plan · ${r.payments.length} recipient${r.payments.length === 1 ? '' : 's'} · ${fmt(total)} ${token}` }),
      r.summary ? el('p', { class: 'summary', text: r.summary }) : null,
      payTable(r.payments, null, null, 'Generated payments'),
      el('p', { class: 'meta', text: `Created ${utc(r.createdAt)} · Server recovery until ${utc(r.expiresAt)} · Draft only, verify every address.` }),
      el('div', { class: 'row-actions' }, el('button', {
        class: 'btn primary', type: 'button', disabled: !s.wallet || !!s.payroll?.busy || hasUnresolved(s.payroll),
        text: s.wallet ? 'Use in Payroll review' : 'Connect a wallet to use in Payroll', onclick: () => act(async () => { const result = await ctl.useAIPlan(); $('#payroll').scrollIntoView({ behavior: 'smooth' }); return result; }, 'Plan moved into Payroll and reviewed. Check fees before running.'),
      }))));
  }
  aiOut.replaceChildren(...out);
}

function payTable(payments, quotes, records, caption, sigCtx = null) {
  const recMap = new Map((records || []).map((r) => [r.index, r]));
  const head = ['#', 'Recipient', 'Amount'];
  if (quotes) head.push('Fee', 'Recipient gets');
  if (records) head.push('Status');
  return el('div', { class: 'ledger-wrap', tabindex: '0', role: 'region', 'aria-label': 'Payment details. Scroll horizontally for more columns.' }, el('table', { class: 'ledger' },
    el('caption', { text: caption }),
    el('thead', {}, el('tr', {}, head.map((h, i) => el('th', { scope: 'col', class: i >= 2 && i < 5 && h !== 'Status' ? 'n' : '', text: h })))),
    el('tbody', {}, payments.map((p, i) => {
      const q = quotes?.[i];
      const rec = recMap.get(i);
      const cells = [el('td', { class: 'idx', text: String(i + 1) }), el('td', { class: 'addr', title: p.recipient, text: p.recipient }), el('td', { class: 'n', text: `${fmt(p.amount)} ${p.token}` })];
      if (quotes) cells.push(el('td', { class: 'n', text: q ? fmt(q.fee) : '—' }), el('td', { class: 'n', text: q ? `${fmt(q.receive)} ${p.token}` : '—' }));
      if (records) {
        const st = rec?.status || 'pending';
        cells.push(el('td', {}, el('span', { class: `st ${st}`, text: st }),
          rec?.signature && isSig(rec.signature) ? el('a', { class: 'row-err', href: `https://solscan.io/tx/${rec.signature}`, target: '_blank', rel: 'noopener', text: `Solscan ${short(rec.signature)}` }) : null,
          rec?.error ? el('span', { class: 'row-err', text: rec.error }) : null,
          st === 'uncertain' && sigCtx ? sigField(i, sigCtx) : null));
      }
      return el('tr', {}, cells);
    }))));
}

const sigDraft = new Map();
function sigField(i, ctx) {
  const id = `sig-${i}`;
  const inp = el('input', { id, type: 'text', class: 'sig-in', autocomplete: 'off', spellcheck: 'false', placeholder: 'Transaction signature', 'data-sig': String(i), disabled: ctx.busy });
  inp.value = sigDraft.get(i) || '';
  inp.addEventListener('input', () => sigDraft.set(i, inp.value.trim()));
  const go = el('button', { class: 'btn', type: 'button', disabled: ctx.busy, text: 'Check signature' });
  go.addEventListener('click', () => {
    const v = (sigDraft.get(i) || '').trim();
    if (!isSig(v)) { localErr = `Row ${i + 1}: that is not a valid Solana signature.`; render(ctl.state); return; }
    act(async () => { await ctl.recordSignature(i, v); sigDraft.delete(i); }, `Row ${i + 1} signature checked against chain.`);
  });
  return el('div', { class: 'sig-box' },
    el('label', { for: id, class: 'field-lab', text: `Attach known signature for row ${i + 1}` }), inp, go,
    el('span', { class: 'row-err', text: 'Read-only check of recipient, token and net amount. Nothing is resent.' }));
}

const hasUnresolved = (p) => !!p && (p.busy || (p.records || []).some((r) => r.status === 'submitting' || r.status === 'uncertain'));

function renderPayroll(s) {
  const why = disabledReason(s);
  const p = s.payroll;
  const locked = !!p;
  payText.disabled = locked;
  const check = precheck(payText.value);
  prepBtn.disabled = !!why || locked || !check.ok;
  csvBtn.disabled = locked;
  importBtn.disabled = locked || !payText.value.trim() || !ctl;
  inputBlock.hidden = locked;

  const out = [];
  if (why) out.push(el('p', { class: 'hint', text: why }));
  if (!p) {
    out.push(el('div', { class: 'empty-state' }, el('b', { text: 'No batch in progress' }),
      'Paste recipients above, load a CSV, or restore an exported batch. Preparing and reviewing are free; 1 pass is spent per batch when you run it, after balance, sanctions and live fee checks and your confirmation.',
      el('div', { class: 'file-row', style: 'margin-top:12px' }, el('button', { class: 'btn', type: 'button', disabled: !ctl, text: 'Restore backup file', onclick: () => { fileMode = 'json'; fileIn.click(); } }))));
    batchBox.replaceChildren(...out);
    return;
  }
  const recs = p.records || [];
  const confirmed = recs.filter((r) => r.status === 'confirmed').length;
  const uncertain = recs.filter((r) => r.status === 'uncertain').length;
  const failed = recs.filter((r) => r.status === 'failed').length;
  const allDone = p.payments.length > 0 && confirmed === p.payments.length;
  const unresolved = hasUnresolved(p);
  const reviewed = p.status === 'reviewed' || (p.busy && p.operation === 'run');
  const priced = p.quotes?.length === p.payments.length && p.quotes.every(Boolean);
  const stage = allDone ? 3 : recs.some((r) => r.status !== 'pending') ? 2 : reviewed ? 1 : 0;
  const busy = !!p.busy || !!s.magicblock?.busy;
  const readiness = payrollReadiness(s, !!ctl);
  const activity = payrollProgress(p);
  const total = p.payments.reduce((t, x) => t + Number(x.amount || 0), 0);
  const fees = (p.quotes || []).reduce((t, q) => t + Number(q?.fee || 0), 0);
  const net = (p.quotes || []).reduce((t, q) => t + Number(q?.receive || 0), 0);

  out.push(el('ol', { class: 'steps-strip', 'aria-label': 'Batch progress' },
    ['Prepared', 'Reviewed', 'Sending', 'Complete'].map((t, i) => el('li', { class: i < stage ? 'done' : i === stage ? 'on' : '', 'aria-current': i === stage ? 'step' : false }, el('b', { text: String(i + 1) }), t))));
  out.push(el('div', { class: 'batch-head' },
    el('div', { class: 'batch-sum' },
      el('span', {}, 'Token ', el('b', { text: p.token })),
      el('span', {}, 'Recipients ', el('b', { text: String(p.payments.length) })),
      el('span', {}, 'Gross ', el('b', { text: `${fmt(total)} ${p.token}` })),
      priced ? el('span', {}, 'Quoted fees ', el('b', { text: fmt(fees) })) : null,
      priced ? el('span', {}, 'Quoted net ', el('b', { text: `${fmt(net)} ${p.token}` })) : null,
      el('span', { role: 'status', 'aria-live': 'polite' }, 'Status ', el('b', { text: busy ? (p.status || activity.label) : activity.label })))));
  out.push(el('div', { class: 'run-readiness', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    el('b', { text: activity.title }), el('p', { text: activity.detail })));
  if (recs.length) {
    out.push(el('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Confirmed payments', 'aria-valuemin': '0', 'aria-valuemax': String(p.payments.length), 'aria-valuenow': String(confirmed) },
      el('i', { style: `transform:scaleX(${p.payments.length ? confirmed / p.payments.length : 0})` })));
  }
  if (p.error) out.push(el('p', { class: 'err-line', role: 'alert', text: p.error }));
  const funding = s.privateBalanceCheck?.batchId === p.id ? s.privateBalanceCheck : null;
  if (funding) {
    const card = el('div', { class: 'run-readiness', role: 'status', 'aria-live': 'polite' },
      el('b', { text: 'Private balance check · not your public-wallet balance' }),
      el('p', { text: `Verified private balance: ${funding.available === null ? 'Unavailable — not assumed to be zero' : `${fmt(funding.available)} ${funding.token}`}` }),
      el('p', { text: `Required for remaining payments: ${fmt(funding.required)} ${funding.token}. Relayer fees are already included in the gross amount.` }),
      el('p', { class: 'hint', text: `Checked ${funding.checkedAt.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}. This is the last read, not a live balance.` }));
    if (funding.shortfall > 0) card.append(
      el('p', { text: `Additional private balance needed: ${fmt(funding.shortfall)} ${funding.token}. Shield funds with the same wallet first. Buying passes does not fund private payments.` }),
      el('a', { class: 'btn', href: '/app', text: `Open app to shield ${funding.token}` }));
    out.push(card);
  }
  if (uncertain) out.push(el('p', { class: 'err-line', text: `${uncertain} payment${uncertain > 1 ? 's have' : ' has'} an uncertain outcome. Do not resend. Reconcile reads chain status only and never submits a transaction.` }));
  if (failed && !uncertain) out.push(el('p', { class: 'hint', text: `${failed} payment${failed > 1 ? 's' : ''} failed. Review again before resuming; confirmed rows will not be replayed.` }));
  const caption = allDone ? 'Completed batch: confirmed payment receipts'
    : stage === 2 ? 'Payment receipts and remaining payments'
    : reviewed ? 'Review: fees (rent included) and amounts each recipient receives'
    : 'Prepared batch, not yet reviewed';
  out.push(payTable(p.payments, p.quotes, recs.length || reviewed ? recs : null, caption, { busy }));
  if (!reviewed && !allDone && !busy) out.push(el('p', { class: 'hint', text: 'Review is free and shows fees and net amounts. After a reload or a stop, review again before running or resuming.' }));
  if (reviewed && !p.authorized && !allDone && !busy) out.push(el('p', { class: 'hint', text: 'After your confirmation, Run checks balance, sanctions for every recipient and live fees, then spends 1 pass for this batch, even if you later stop part-way. Your wallet unlocks private balance; relayed withdrawals run in order.' }));
  if (!allDone) out.push(el('div', { id: 'payroll-run-readiness', class: 'run-readiness', role: 'status', 'aria-live': 'polite' },
    el('b', { text: p.authorized ? 'Batch already paid · no additional pass needed' : `Available Moth Passes: ${s.creditError ? 'unavailable' : s.credits} · this batch costs 1 pass` }),
    readiness.reasons.length
      ? el('ul', {}, readiness.reasons.map(text => el('li', { text })))
      : el('p', { text: 'Ready to run. Check the recipients and net amounts above before confirming.' })));

  const btn = (text, cls, disabled, fn, ok) => el('button', { class: `btn ${cls}`, type: 'button', disabled, text, onclick: () => act(fn, ok) });
  const acts = el('div', { class: 'row-actions' });
  if (!allDone) {
    acts.append(btn(reviewed ? 'Review again · free' : 'Review · free', reviewed ? '' : 'primary',
      !!why || busy || unresolved, () => ctl.reviewPayroll(), 'Review complete.'));
    const runLabel = p.authorized ? (confirmed ? 'Resume batch · already paid' : 'Run batch · already paid') : 'Run batch · 1 pass';
    const busyLabel = activity.label;
    const runButton = btn(busy ? busyLabel : runLabel, 'primary',
      !readiness.canRun || busy, () => ctl.runPayroll(), 'Batch completed. All payments confirmed.');
    runButton.setAttribute('aria-describedby', 'payroll-run-readiness');
    acts.append(runButton);
    if (!p.authorized && s.credits < 1) acts.append(el('a', { class: 'btn', href: '/pass', style: 'display:inline-flex;align-items:center;text-decoration:none', text: 'Get a pass to run' }));
  }
  if (busy && p.operation === 'run') acts.append(el('button', { class: 'btn danger', type: 'button', text: stage === 2 ? 'Stop after current payment' : p.phase === 'authorize' ? 'Stop after authorization' : 'Stop preparation', onclick: () => { try { ctl.stopPayroll(); announce('Stopping safely. No further payments will be started.'); } catch (e) { localErr = e.message; render(ctl.state); } } }));
  if (uncertain || recs.some((r) => r.status === 'submitting')) acts.append(btn('Reconcile with chain', '', busy, () => ctl.reconcilePayroll(), 'Reconciliation finished.'));
  acts.append(el('button', { class: 'btn', type: 'button', text: 'Export backup (.json)', onclick: exportBatch }));
  acts.append(btn('Clear batch', 'danger', unresolved || busy, () => ctl.clearPayroll(), 'Batch updated.'));
  out.push(acts);
  if (unresolved) out.push(el('p', { class: 'hint', text: 'Clear is locked while a payment is in flight or unresolved.' }));
  out.push(el('p', { class: 'hint', text: 'The backup links your wallet to these recipients and amounts. Keep it private. It never contains private keys.' }));
  batchBox.replaceChildren(...out);
}

function exportBatch() {
  try {
    const json = ctl.exportPayroll();
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = el('a', { href: url, download: `duskmoth-payroll-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    announce('Backup downloaded.');
  } catch (e) {
    localErr = e?.message || 'Export failed.';
    render(ctl.state);
  }
}

function render(s) {
  if (!s) return;
  const f = document.activeElement;
  const keep = f && f.dataset && f.dataset.sig != null ? { i: f.dataset.sig, a: f.selectionStart, b: f.selectionEnd } : null;
  renderSession(s);
  renderAI(s);
  renderPayroll(s);
  if (mbUI) { mbUI.syncWallet(); mbUI.render(); }
  const msgs = [s.error, localErr].filter(Boolean);
  globalMsg.replaceChildren(...[...new Set(msgs)].map((m) => el('p', { class: 'err', text: m })));
  if (keep) {
    const n = document.querySelector(`[data-sig="${keep.i}"]`);
    if (n && !n.disabled) { n.focus(); try { n.setSelectionRange(keep.a, keep.b); } catch { /* ignore */ } }
  }
}

renderCheck();
createPremiumTools({ onChange: (s) => render(s) })
  .then(async (c) => {
    ctl = c;
    try {
      const mb = await createMagicblockPayments({ getWallet: () => ctl.getMagicblockWallet(), onChange: () => mbUI?.render() });
      mbUI = createMagicblockUI({ root: $('[data-magicblock]'), mb, getWallet: () => ctl.getMagicblockWallet(),
        getAIPayments: () => ctl.state.ai?.result?.payments || null, announce });
    } catch (e) {
      $('[data-magicblock]').replaceChildren(el('p', { class: 'err-line', role: 'alert', text: `MagicBlock could not load: ${e?.message || 'unknown error'}` }));
    }
    render(c.state);
  })
  .catch((e) => {
    sessionBox.setAttribute('aria-busy', 'false');
    sessionBox.replaceChildren(el('p', { class: 'note-s', text: 'Tools could not load.' }),
      el('button', { class: 'btn', type: 'button', text: 'Retry', onclick: () => location.reload() }));
    globalMsg.replaceChildren(el('p', { class: 'err', text: e?.message || 'Failed to start tools.' }));
    aiGen.disabled = true; aiRecover.disabled = true; prepBtn.disabled = true; importBtn.disabled = true;
  });
aiGen.disabled = true; aiRecover.disabled = true; prepBtn.disabled = true; importBtn.disabled = true;
