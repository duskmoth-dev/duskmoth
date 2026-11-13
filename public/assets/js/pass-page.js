import { initCommon } from './fx.js';
import * as api from './api.js';
import { detectWallets, makeWallet } from './wallet.js?mode=real';
import { createWalletSession, walletPreferences } from './wallet-session.js';
import { observeWallets, walletHelp, walletConnectionError } from './wallet-discovery.js';
import * as passes from './passes.js';
import { purchase, resumePurchase, pendingPurchase } from './pass-purchase.js';

initCommon('docs');

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  kids.flat().forEach((c) => c != null && n.append(c));
  return n;
};
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });
const isSig = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s);

const getBox = $('[data-get]');
const msgBox = $('[data-msg]');
const storeMsg = $('[data-store-msg]');
const timeline = $('[data-timeline]');
const badge = $('[data-net-badge]');

const state = { info: null, wallet: null, connecting: false, balance: null, balanceState: 'idle', qty: 1, busy: false, pending: null, accountChanged: false };
let balanceTicket = 0;

const session = createWalletSession({
  makeWallet, storage: walletPreferences,
  onConnectingChange(connecting) { state.connecting = connecting; render(); },
  onChange(w) {
    if (state.busy && state.wallet && (!w || w.address !== state.wallet.address)) state.accountChanged = true;
    if (state.wallet && !w && !state.busy) showMsg(msgBox, 'Wallet disconnected. Connect a wallet to continue.');
    state.wallet = w; state.balance = null; state.balanceState = 'idle';
    render(); if (w) loadBalance();
  },
});

function setBadge(text, cls) {
  badge.className = `badge ${cls || ''}`;
  badge.lastElementChild.textContent = text;
}

function knownBurn() {
  try { const p = pendingPurchase(); return p && isSig(p.burnSignature) ? p.burnSignature : null; } catch { return null; }
}
function friendly(err) {
  const m = String(err?.message || '');
  if (err?.code === 4001 || /reject|denied|declined|cancel/i.test(m)) {
    return knownBurn() ? 'A signed burn transaction is saved. Check its status, then use Resume purchase; do not burn again.' : 'You rejected the request. Nothing was burned.';
  }
  if (!m || m.length > 220 || /[{<]/.test(m)) return 'The operation failed. No details are available.';
  return m;
}

function showMsg(box, text, kind = 'err', extra) {
  box.replaceChildren(el('p', { class: kind, text }), extra || '');
}

function setStep(i, failed = false) {
  timeline.hidden = false;
  [...timeline.children].forEach((li, k) => {
    li.classList.toggle('done', k < i || (!failed && i >= 6));
    li.classList.toggle('active', k === i && !failed);
    li.classList.toggle('failed', k === i && failed);
    if (k === i) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
}
let currentStep = -1;
const detailEl = $('[data-step-detail]');
const onStep = ({ step, detail } = {}) => {
  if (Number.isInteger(step) && step >= 0 && step <= 5) { currentStep = step; setStep(step); }
  detailEl.textContent = typeof detail === 'string' ? detail.slice(0, 200) : '';
};
function burnLink(sig) {
  return el('a', { href: `https://solscan.io/tx/${sig}`, target: '_blank', rel: 'noopener', text: `View burn ${short(sig)} on Solscan` });
}
function readPending() {
  try { state.pending = pendingPurchase(); state.pendingError = false; }
  catch { state.pending = null; state.pendingError = true; }
}

async function loadBalance() {
  const w = state.wallet, info = state.info;
  if (!w || !info?.mint) return;
  const t = ++balanceTicket;
  state.balanceState = 'loading'; render();
  try {
    const { tokenBalance } = await import('./live/moth-pass.js');
    const res = await tokenBalance({ rpcUrl: `${location.origin}/api/rpc`, owner: w.address, mint: info.mint });
    if (t !== balanceTicket || state.wallet !== w) return;
    const total = Number(res?.total);
    if (!Number.isFinite(total)) throw new Error('bad');
    state.balance = total; state.balanceState = 'ok';
  } catch {
    if (t !== balanceTicket) return;
    state.balance = null; state.balanceState = 'error';
  }
  render();
}

function updateCount() {
  const info = state.info;
  try {
    const n = info?.kid ? passes.count(info.kid, !!info.demo) : passes.all().length;
    if (!Number.isFinite(n)) throw new Error('bad');
    $('[data-count]').textContent = String(n);
    if (state.countError) { state.countError = false; storeMsg.replaceChildren(); }
  } catch {
    state.countError = true;
    $('[data-count]').textContent = 'Unavailable';
    showMsg(storeMsg, 'Stored passes could not be read in this browser. Do not clear browser data; if you have a backup file, keep it safe and try Restore backup.');
  }
}

function walletValid() {
  if (!state.wallet) return false;
  const before = state.wallet;
  session.validate();
  return state.wallet === before && !state.accountChanged;
}

async function run(kind) {
  const info = state.info;
  if (state.busy || !info?.enabled) return;
  const demo = !!info.demo;
  if (!demo && !walletValid()) { showMsg(msgBox, 'Your active wallet account changed or disconnected. Reconnect before continuing.'); return; }
  if (kind === 'new' && state.pendingError) { showMsg(msgBox, 'Saved recovery data could not be read. A new burn is blocked to protect an earlier purchase.'); return; }
  if (kind === 'new' && state.pending) { showMsg(msgBox, 'Finish the pending purchase before starting another burn.'); return; }
  state.busy = true; state.accountChanged = false; currentStep = -1;
  msgBox.replaceChildren(el('p', { class: 'ok', text: 'Working. Keep this tab open; this can take up to two minutes.' }));
  render();
  try {
    const wallet = demo && !state.wallet ? null : state.wallet;
    const res = kind === 'resume'
      ? await resumePurchase({ info, wallet, onStep })
      : await purchase({ info, wallet, count: state.qty, onStep });
    setStep(6); detailEl.textContent = '';
    const got = Array.isArray(res?.passes) ? res.passes.length : 0;
    const receipt = el('div', { class: 'receipt' },
      el('p', { class: 'ok', text: `${got} ${got === 1 ? 'pass' : 'passes'} saved in this browser.` }));
    if (!res?.demo && isSig(res?.burnSignature)) {
      receipt.append(burnLink(res.burnSignature));
    } else if (res?.demo) {
      receipt.append(el('p', { class: 'note-s', text: 'Development demo passes. Nothing was burned and they only work on this development server.' }));
    }
    receipt.append(el('p', { class: 'note-s', text: 'Back up your passes now.' }));
    msgBox.replaceChildren(receipt);
  } catch (err) {
    if (currentStep >= 0) setStep(currentStep, true);
    const sig = knownBurn();
    showMsg(msgBox, `Stopped: ${friendly(err)}`, 'err', sig ? el('div', { class: 'receipt' },
      el('p', { class: 'note-s', text: 'Your burn is recorded in this browser. Resume purchase to claim the passes; do not burn again.' }), burnLink(sig)) : null);
  } finally {
    state.busy = false;
    readPending();
    updateCount(); render();
    if (state.wallet) loadBalance();
  }
}

function renderDisabled(info) {
  getBox.replaceChildren(el('div', { class: 'disabled-box' },
    el('h3', { text: 'Moth Pass is not available on this server' }),
    el('p', { text: info?.reason || 'The host has not configured the $DMOTH mint, the pass signing key, or durable ledger storage.' }),
    el('p', { class: 'note-s', text: 'Duskmoth works fully without passes. Sending, shielding and withdrawing are unaffected.' })));
}

function render() {
  getBox.setAttribute('aria-busy', String(state.connecting));
  const info = state.info;
  if (!info) return;
  if (!info.enabled) { renderDisabled(info); return; }
  const demo = !!info.demo;
  const price = Number(info.price) || 0;
  const max = Math.max(1, Math.min(demo ? 3 : Number(info.maxPerBurn) || 1, Number(info.maxPerBurn) || 3));
  state.qty = Math.min(Math.max(1, state.qty), max);
  const nodes = [];

  if (state.pendingError) {
    nodes.push(el('div', { class: 'disabled-box' }, el('h3', { text: 'Recovery data could not be read' }),
      el('p', { text: 'This browser holds purchase recovery data that is unreadable. New burns are blocked so an earlier burn is not lost. Do not clear browser data; reload to try again.' })));
  }
  if (state.pending) {
    nodes.push(el('div', { class: 'total' },
      el('b', { text: 'A purchase is pending' }),
      el('p', { text: `${state.pending.count || 'Some'} passes from an earlier ${state.pending.demo ? 'demo request' : 'burn'} were not finished. Resume to collect them. No new burn will start until this is done.` }),
      isSig(state.pending.burnSignature) && !state.pending.demo ? burnLink(state.pending.burnSignature) : null,
      el('button', { class: 'btn primary wide', type: 'button', disabled: state.busy || (!state.pending.demo && !state.wallet), onclick: () => run('resume'), text: state.busy ? 'Working…' : 'Resume purchase' })));
    if (!state.pending.demo && !state.wallet) nodes.push(el('p', { class: 'note-s', text: 'Connect a wallet to resume.' }));
  }

  if (!state.wallet) {
    const list = detectWallets();
    if (!demo || info.mint) {
      nodes.push(el('p', { class: 'note-s', text: 'For the best privacy, use a different wallet from the one you send with.' }));
      if (list.length) {
        nodes.push(el('div', { class: 'wallet-list' }, list.map((w) => el('button', {
          class: 'btn', type: 'button', disabled: state.busy || state.connecting,
          onclick: async () => {
            try {
              if (!await session.connect(w.id)) showMsg(msgBox, 'Wallet not available. Refresh wallet detection and try again.');
              else showMsg(msgBox, 'Wallet connected.', 'ok');
            } catch (e) { showMsg(msgBox, walletConnectionError(e)); }
          },
        }, el('span', { text: w.name }), el('span', { class: 'micro mute', text: state.connecting ? 'Approve in wallet' : 'Connect' })))));
      } else nodes.push(el('p', { class: 'note-s', text: 'No Solana wallet detected in this browser.' }), walletHelp());
    }
  } else {
    const bal = state.balanceState === 'ok' ? `${fmt(state.balance)} $DMOTH`
      : state.balanceState === 'loading' ? 'Loading…' : state.balanceState === 'error' ? 'Unavailable' : '—';
    const dl = el('dl', { class: 'kv-list' },
      el('div', { class: 'kv-row' }, el('dt', { text: 'Wallet' }), el('dd', { title: state.wallet.address, text: `${state.wallet.name} · ${short(state.wallet.address)}` })),
      el('div', { class: 'kv-row' }, el('dt', { text: 'Balance' }), el('dd', { text: bal })),
      el('div', { class: 'kv-row' }, el('dt', { text: 'Price per pass' }), el('dd', { text: `${fmt(price)} $DMOTH` })));
    nodes.push(dl, el('div', { class: 'pass-actions' },
      state.balanceState === 'error' ? el('button', { class: 'btn', type: 'button', onclick: loadBalance, text: 'Retry balance' }) : null,
      el('button', { class: 'btn', type: 'button', disabled: state.busy, onclick: () => session.disconnect(), text: 'Disconnect wallet' })));
  }

  const canQty = demo || state.wallet;
  if (canQty) {
    const input = el('input', { id: 'qty', type: 'number', inputmode: 'numeric', min: 1, max, value: state.qty, disabled: state.busy });
    input.addEventListener('change', () => { const v = Math.floor(Number(input.value)); state.qty = Number.isFinite(v) ? v : 1; render(); });
    const bump = (d) => { state.qty += d; render(); };
    nodes.push(el('div', {},
      el('label', { for: 'qty', class: 'micro mute', text: `Passes (1 to ${max})` }),
      el('div', { class: 'stepper' },
        el('button', { type: 'button', 'aria-label': 'Fewer passes', disabled: state.busy || state.qty <= 1, onclick: () => bump(-1), text: '−' }),
        input,
        el('button', { type: 'button', 'aria-label': 'More passes', disabled: state.busy || state.qty >= max, onclick: () => bump(1), text: '+' }))));

    const total = state.qty * price;
    if (demo && !info.mint) {
      nodes.push(el('div', { class: 'total' }, el('b', { text: 'Development demo passes' }),
        el('p', { text: 'Nothing is burned. Demo passes exist only on this development server, at most 3 per request.' })));
    } else {
      nodes.push(el('div', { class: 'total' }, el('b', { text: `You burn ${fmt(total)} $DMOTH` }),
        el('p', { text: 'Burning is permanent. The tokens are destroyed, not sent to anyone.' })));
    }

    let reason = '';
    const useDemo = demo && !info.mint;
    if (state.pendingError) reason = 'Recovery data is unreadable, so new burns are blocked.';
    else if (state.pending) reason = 'Resume the pending purchase first.';
    else if (state.busy) reason = '';
    else if (!useDemo) {
      if (!state.wallet) reason = 'Connect a wallet.';
      else if (state.accountChanged) reason = 'Your wallet account changed. Reconnect.';
      else if (state.balanceState !== 'ok') reason = state.balanceState === 'error' ? 'Balance unavailable, so the burn is disabled.' : 'Checking balance…';
      else if (state.balance < total) reason = 'Not enough $DMOTH for this many passes.';
    }
    const label = state.busy ? 'Working…' : useDemo ? `Get ${state.qty} demo ${state.qty === 1 ? 'pass' : 'passes'}` : `Burn and get ${state.qty} ${state.qty === 1 ? 'pass' : 'passes'}`;
    nodes.push(el('button', { class: 'btn primary wide', type: 'button', disabled: state.busy || !!reason, 'aria-describedby': reason ? 'burn-why' : null, onclick: () => run('new'), text: label }));
    if (reason) nodes.push(el('p', { id: 'burn-why', class: 'note-s', text: reason }));
    nodes.push(el('p', { class: 'warn-box', text: 'Back up your passes after every purchase. They live only in this browser.' }));
  }
  getBox.replaceChildren(...nodes);
}

async function boot() {
  updateCount();
  try {
    state.info = await api.passInfo();
  } catch (e) {
    setBadge('Unavailable', 'warn');
    getBox.replaceChildren(el('div', { class: 'disabled-box' },
      el('h3', { text: 'Could not load Moth Pass status' }),
      el('p', { text: e?.status ? friendly(e) : 'The server could not be reached.' }),
      el('button', { class: 'btn', type: 'button', onclick: () => { getBox.replaceChildren(el('div', { class: 'sk' })); boot(); }, text: 'Try again' })));
    return;
  }
  const info = state.info;
  if (!info.enabled) setBadge('Not configured', 'warn');
  else if (info.mint && !info.demo) setBadge('Mainnet', 'live');
  else if (info.demo) setBadge('Demo passes', '');
  else setBadge('Mainnet', 'live');
  readPending();
  updateCount();
  render();
  if (info.enabled) session.restore().catch(() => {});
}

observeWallets(() => {
  if (state.info && !state.wallet && !state.connecting) {
    render(); if (state.info.enabled) void session.restore({ waitMs: 0 });
  }
});
window.addEventListener('passes:change', updateCount);
window.addEventListener('focus', () => { if (state.wallet) session.validate(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.wallet) session.validate(); });

$('[data-backup]').addEventListener('click', () => {
  try {
    let list; try { list = passes.all(); } catch { showMsg(storeMsg, 'Stored passes could not be read, so no backup was made. Do not clear browser data.'); return; }
    if (!list.length) { showMsg(storeMsg, 'There are no passes to back up yet.'); return; }
    const blob = passes.exportBlob();
    const url = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([JSON.stringify(blob)], { type: 'application/json' }));
    const a = el('a', { href: url, download: `moth-passes-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showMsg(storeMsg, 'Backup downloaded. Keep the file private: anyone with it can spend these passes.', 'ok');
  } catch { showMsg(storeMsg, 'The backup could not be created.'); }
});
const fileInput = $('[data-restore-file]');
$('[data-restore]').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0]; fileInput.value = '';
  if (!f) return;
  try {
    let before = null; try { before = passes.all().length; } catch {}
    await passes.importFile(f);
    let after = null; try { after = passes.all().length; } catch {}
    const added = before != null && after != null ? after - before : null;
    showMsg(storeMsg, added == null ? 'Backup imported, but the stored count could not be read.' : added > 0 ? `Restored ${added} ${added === 1 ? 'pass' : 'passes'}.` : 'No new passes found in that file.', 'ok');
    updateCount();
  } catch { showMsg(storeMsg, 'That file is not a valid Moth Pass backup.'); }
});

boot();
