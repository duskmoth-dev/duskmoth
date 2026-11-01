import { initCommon, toast, reduced } from './fx.js';
import * as api from './api.js?mode=real';
import { detectWallets, makeWallet, proveOwnership } from './wallet.js?mode=real';
import { createWalletSession } from './wallet-session.js';
import { AVATAR_SRC } from './cicada.js';
import { validateTransfer, withdrawalQuote } from './transfer.js';

const MASCOT = AVATAR_SRC;

initCommon('app');
const gsap = window.gsap;

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n, d = 4) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });

const state = {
  cfg: null,
  wallet: null,
  publicSol: null,
  shielded: { SOL: null, USDC: null },
  live: null, // lazily loaded live-send module instance
  busy: false,
};
const walletSession = createWalletSession({
  makeWallet,
  storage: {
    getItem: key => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: key => localStorage.removeItem(key),
  },
  onChange(wallet) {
    state.wallet = wallet;
    state.live = null; state.publicSol = null;
    state.shielded = { SOL: null, USDC: null };
    state.activity = null; state.activityLoading = false;
    lastScore = null;
    $('[data-score-source]').textContent = '';
    renderWallet(); renderScoreIdle();
    if (wallet) void loadActivity();
  },
});
addEventListener('focus', () => walletSession.validate());
addEventListener('storage', event => {
  if ((event.key === 'dm_wallet' && event.newValue === null) || event.key === null) walletSession.forget();
});

/* =============== layout / tabs =============== */
const panes = document.querySelectorAll('[data-pane]');
function showPane(name) {
  panes.forEach((p) => p.classList.toggle('show', p.dataset.pane === name));
  document.querySelectorAll('[data-app-tabs] button').forEach((b) => b.classList.toggle('on', b.dataset.to === name));
  if (window.innerWidth > 960) $(`[data-pane="${name}"]`)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
}
document.querySelector('[data-app-tabs]').addEventListener('click', (e) => { const b = e.target.closest('[data-to]'); if (b) showPane(b.dataset.to); });
$('[data-wallet-pill]').addEventListener('click', () => showPane('wallet'));
$('[data-wallet-disconnect]').addEventListener('click', disconnect);

/* =============== chat =============== */
const feed = $('[data-feed]');
function scrollFeed() { feed.scrollTop = feed.scrollHeight; }
function addMsg(who, html) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.innerHTML = who === 'ai' ? `<div class="who micro"><img class="ava" src="${MASCOT}" alt="">Duskmoth</div>${html}` : html;
  feed.appendChild(el); scrollFeed();
  return el;
}
function typing() { return addMsg('ai', '<span class="typing" aria-label="Duskmoth is typing"><span></span><span></span><span></span></span>'); }

const CHIPS = [
  'Send 1 SOL privately',
  'Shield 2 SOL',
  'Check my privacy score',
  'Send 25 USDC later',
  'Withdraw from my private balance',
];
const CHIP_LABELS = ['Send 1 SOL privately', 'Shield 2 SOL', 'Check my privacy score', 'Send 25 USDC later', 'Withdraw private balance'];
const chips = $('[data-chips]');
CHIPS.forEach((c, i) => {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = CHIP_LABELS[i];
  b.addEventListener('click', () => submit(c)); chips.appendChild(b);
});

const composer = $('[data-composer]');
const ta = $('#say');
ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(140, ta.scrollHeight)}px`; });
ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); composer.requestSubmit(); } });
composer.addEventListener('submit', (e) => { e.preventDefault(); const v = ta.value.trim(); if (!v) { ta.focus(); return; } ta.value = ''; ta.style.height = 'auto'; submit(v); });

async function submit(text) {
  if (state.busy) { toast('One thing at a time. Finish the current step first.'); return; }
  addMsg('me', esc(text));
  const t = typing();
  try {
    const res = await api.intent(text);
    t.remove();
    addMsg('ai', esc(res.reply));
    const a = res.action;
    if (!a) return;
    if (['send', 'shield', 'withdraw'].includes(a.type)) renderPreview(a);
    else if (a.type === 'score') { showPane('score'); if (state.wallet) runScore(); }
    else if (a.type === 'balance') showPane('wallet');
  } catch (err) {
    t.remove();
    addMsg('ai', esc(err.message || 'Something went wrong. Try again.'));
  }
}

/* =============== preview + execution =============== */
function privacyStrength(a) {
  const tips = [];
  let s = 35;
  const round = Number.isInteger(a.amount) || Number.isInteger(a.amount * 10);
  if (round) s += 20; else tips.push('Use a round amount, like 1.0 instead of 1.137.');
  if (a.type === 'shield' || a.delay === 'later') s += 30; else tips.push('Shield now and send later. Time between the two steps hides the link.');
  const small = a.token === 'SOL' ? a.amount <= 2 : a.amount <= 200;
  if (small) s += 15; else tips.push('Smaller amounts blend into the pool more easily.');
  return { score: Math.min(100, s), tips };
}

function renderPreview(a) {
  try { validateTransfer(a, state.cfg?.limits); }
  catch (e) { addMsg('sys', esc(e.message)); return; }
  const isWithdrawal = a.type === 'withdraw';
  const isSend = a.type === 'send' || isWithdrawal;
  const withdrawalNeeded = isWithdrawal || (a.type === 'send' && a.delay !== 'later');
  const walletAtPreview = state.wallet?.address;
  const ps = privacyStrength(a);
  const card = document.createElement('div');
  card.className = 'preview glass';
  card.innerHTML = `
    <h4>${isWithdrawal ? 'Withdraw from existing private balance' : isSend ? 'Private send' : 'Shield to private balance'}</h4>
    <div class="amount-big">${fmt(a.amount)} <span style="font-size:20px">${a.token}</span></div>
    <dl class="kv">
      ${isSend ? `<dt>To</dt><dd class="addr" title="${esc(a.recipient)}">${esc(api.short(a.recipient))}</dd>` : ''}
      <dt>Route</dt><dd>Privacy Cash shielded pool</dd>
      <dt>Funding</dt><dd>${isWithdrawal ? 'Existing private balance — no new deposit' : 'Your public wallet'}</dd>
      ${withdrawalNeeded ? '<dt>Relayer fee</dt><dd data-quote-fee>Loading current fees…</dd><dt>Recipient receives</dt><dd data-quote-receive>Loading…</dd>' : '<dt>Withdrawal</dt><dd>Not requested — funds stay in your private balance</dd>'}
      <dt>Network fee</dt><dd>${isWithdrawal ? 'Included in relayer pricing' : 'Additional; review in your wallet before signing'}</dd>
      ${isSend ? `<dt>Timing</dt><dd>${a.delay === 'later' ? 'Shield now, send later' : 'Right away'}</dd>` : ''}
    </dl>
    <div class="meter">
      <div class="bar"><i style="width:0%"></i></div>
      <div class="lab micro"><span>Privacy strength</span><span>${ps.score}/100</span></div>
    </div>
    <p class="micro mute">Privacy estimate only; not a guarantee of anonymity.</p>
    ${ps.tips.length ? `<p class="micro mute" style="margin:8px 0 0">${ps.tips.map(esc).join(' ')}</p>` : ''}
    <div class="check" data-check role="status" aria-live="polite"><span class="ic"></span><span>Checking ${isSend ? 'available sender and recipient addresses' : 'your wallet'} against sanctions lists with Scorechain…</span></div>
    <div class="actions">
      <button class="btn primary" type="button" data-go disabled>${isWithdrawal ? 'Confirm withdrawal' : isSend ? (a.delay === 'later' ? 'Shield now' : 'Confirm and sign') : 'Shield and sign'}</button>
      ${a.type === 'send' && a.delay !== 'later' ? '<button class="btn" type="button" data-later disabled>Shield now, send later</button>' : ''}
      <button class="btn" type="button" data-cancel>Cancel</button>
    </div>`;
  feed.appendChild(card); scrollFeed();
  requestAnimationFrame(() => { $('.bar i', card).style.width = `${ps.score}%`; });

  const check = $('[data-check]', card);
  const go = $('[data-go]', card);
  let cancelled = false;
  let previewQuote = null;
  const cancel = () => { cancelled = true; card.querySelectorAll('button').forEach((b) => (b.disabled = true)); card.style.opacity = '.5'; addMsg('sys', 'Cancelled. Nothing was sent.'); };
  $('[data-cancel]', card).addEventListener('click', cancel);

  const screenTarget = isSend ? a.recipient : state.wallet?.address;
  const screening = screenTarget && walletAtPreview
    ? api.screen({ sender: state.wallet?.address || null, recipient: screenTarget })
    : Promise.resolve({ allowed: false, reason: 'Connect your real wallet before checking its address. Nothing was submitted.' });
  const quote = withdrawalNeeded ? api.relayerConfig().then(c => withdrawalQuote(a, c)) : Promise.resolve(null);
  Promise.all([screening, quote])
    .then(([r, q]) => {
      if (cancelled) return;
      if (q) {
        previewQuote = q;
        $('[data-quote-fee]', card).textContent = `${fmt(q.fee, 9)} ${a.token} (deducted from amount)`;
        $('[data-quote-receive]', card).textContent = `${fmt(q.receive, 9)} ${a.token}`;
      }
      if (r.allowed === true && r.source === 'scorechain' && r.scope === 'sanctions-only') {
        check.className = 'check ok';
        check.lastElementChild.textContent = `Scorechain: no sanctions-list match${r.sender ? ' for either checked address' : ' for the recipient; sender not checked'}. Sanctions only, not a full risk assessment.`;
        go.disabled = !state.cfg?.liveSend;
        card.querySelectorAll('[data-later]').forEach((b) => (b.disabled = !state.cfg?.liveSend));
        if (!state.cfg?.liveSend) {
          check.lastElementChild.textContent += ' Live transfers are disabled; nothing will be simulated.';
          go.textContent = 'Live transfers unavailable';
        }
      } else {
        check.className = 'check bad';
        check.lastElementChild.textContent = r.reason || 'Blocked by screening.';
        card.querySelectorAll('[data-later]').forEach((b) => (b.disabled = true));
      }
    })
    .catch((e) => {
      if (cancelled) return;
      check.className = 'check bad';
      check.lastElementChild.textContent = e.message || 'Screening unavailable. Not proceeding.';
      card.querySelectorAll('[data-quote-fee], [data-quote-receive]').forEach(el => { el.textContent = 'Unavailable — see the error below'; });
    });

  const run = async (mode) => {
    if (state.busy) { toast('A transaction is already in progress.'); return; }
    if (!state.wallet) {
      toast('Connect your wallet first.');
      showPane('wallet');
      return;
    }
    if (state.wallet.address !== walletAtPreview) { toast('Wallet changed. Create a new preview before signing.'); return; }
    const approved = window.confirm(`${mode === 'withdraw' ? 'Withdraw from your existing private balance' : 'Deposit from your public wallet'}: ${fmt(a.amount, 9)} ${a.token}.${mode === 'send' || mode === 'withdraw' ? ` Recipient: ${a.recipient}. Relayer fees are deducted from this amount.` : ''} Mainnet funds are real. Continue?`);
    if (!approved) return;
    card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    await execute({ ...a, mode, approvedQuote: previewQuote }, card);
  };
  go.addEventListener('click', () => run(isWithdrawal ? 'withdraw' : isSend ? (a.delay === 'later' ? 'shield-only' : 'send') : 'shield-only'));
  $('[data-later]', card)?.addEventListener('click', () => run('shield-only'));
}

async function execute(a, card) {
  if (!state.cfg?.liveSend || !state.wallet || state.wallet.demo) {
    addMsg('sys', state.cfg?.transferBlockReason || 'Live transfers are unavailable. Nothing was sent.');
    return;
  }
  state.busy = true;
  const isSend = a.mode === 'send';
  const withdrawOnly = a.mode === 'withdraw';
  const steps = withdrawOnly ? ['Unlocking and scanning private balance', 'Generating privacy proof', 'Submitting withdrawal', 'Confirmed']
    : isSend
    ? ['Unlocking private balance, scanning records and preparing proof', 'Signing and submitting deposit', 'Shielded', 'Preparing private withdrawal', 'Delivered']
    : ['Unlocking private balance, scanning records and preparing proof', 'Signing and submitting deposit', 'Shielded'];
  const ol = document.createElement('ol');
  ol.className = 'timeline';
  ol.innerHTML = steps.map((s) => `<li><span class="node"></span><span>${s}</span></li>`).join('');
  card.appendChild(ol); scrollFeed();
  const progress = document.createElement('p');
  progress.className = 'transfer-progress';
  progress.setAttribute('role', 'status');
  progress.setAttribute('aria-live', 'polite');
  card.append(progress);
  const onProgress = ({ phase, detail }) => {
    progress.textContent = detail;
    if (withdrawOnly) {
      if (phase === 'proof') step(1);
      else if (phase === 'submit' || phase === 'confirm') step(2);
    } else if (phase === 'preflight' || phase === 'sign') step(1);
  };
  progress.textContent = 'Checking services and loading the privacy engine…';
  const lis = [...ol.children];
  let cur = -1;
  const step = (i) => { lis.forEach((li, k) => { li.classList.toggle('done', k < i); li.classList.toggle('active', k === i); }); cur = i; scrollFeed(); };
  const fail = (msg) => { if (cur >= 0) { lis[cur].classList.remove('active'); lis[cur].classList.add('fail'); } addMsg('ai', esc(msg)); };

  let depositSig, withdrawSig;
  const initiatingWallet = state.wallet;
  const assertCurrentWallet = () => {
    if (state.wallet !== initiatingWallet || initiatingWallet.provider?.publicKey?.toString() !== initiatingWallet.address) {
      throw new Error('Wallet changed or disconnected. Review a new request before continuing.');
    }
  };
  try {
    assertCurrentWallet();
    validateTransfer(a, state.cfg.limits);
    if (state.wallet.provider?.publicKey?.toString() !== state.wallet.address) throw new Error('Wallet account changed. Disconnect and reconnect before signing.');
    const recipient = a.mode === 'shield-only' ? state.wallet.address : a.recipient;
    const screening = await api.screen({ sender: state.wallet.address, recipient });
    if (!screening.allowed || screening.source !== 'scorechain' || screening.scope !== 'sanctions-only') throw new Error(screening.reason || 'Sanctions check incomplete. Nothing was submitted.');
    // Recheck the live relayer minimum before depositing: do not strand a send too small to withdraw.
    const checkQuote = async () => {
      const latest = withdrawalQuote(a, await api.relayerConfig());
      if (!a.approvedQuote || latest.fee > a.approvedQuote.fee + 1e-12) throw new Error('Relayer fees increased. Review a new preview before proceeding; do not repeat any confirmed deposit.');
    };
    if (isSend || withdrawOnly) await checkQuote();
    if (!withdrawOnly) {
      const activity = await api.activity(state.wallet.address);
      if (!Number.isFinite(activity.sol) || activity.sol <= 0) throw new Error('SOL is required for network fees.');
      if (a.amount > (a.token === 'SOL' ? activity.sol : activity.usdc)) throw new Error('Insufficient public balance. Nothing was submitted.');
    }
    const L = await loadLive();
    assertCurrentWallet();
    step(0);
    if (!withdrawOnly) depositSig = await L.shield({ token: a.token, amount: a.amount, onStep: (k) => step(k), onProgress });
    if (isSend || withdrawOnly) {
      const privateBalance = await L.balance(a.token, onProgress);
      if (!Number.isFinite(privateBalance[a.token]) || privateBalance[a.token] + 1e-12 < a.amount) throw new Error('Private balance is insufficient or not indexed yet. No withdrawal was submitted; check the deposit before retrying.');
      const freshScreening = await api.screen({ sender: state.wallet.address, recipient: a.recipient });
      if (!freshScreening.allowed || freshScreening.source !== 'scorechain' || freshScreening.scope !== 'sanctions-only') throw new Error(freshScreening.reason || 'Withdrawal screening incomplete. Deposited funds remain in your private balance.');
      await checkQuote();
      assertCurrentWallet();
      withdrawSig = await L.withdraw({ token: a.token, amount: a.amount, recipient: a.recipient, onStep: (k) => step(withdrawOnly ? k - 1 : k), onProgress });
    }
    lis.forEach((li) => { li.classList.remove('active'); li.classList.add('done'); });
    const rec = document.createElement('div');
    rec.className = 'receipt';
    const link = (sig) => `<a href="https://solscan.io/tx/${encodeURIComponent(sig)}" target="_blank" rel="noopener">${esc(api.short(sig))}</a>`;
    rec.innerHTML = `${depositSig ? `Deposit ${link(depositSig)}` : ''}${depositSig && withdrawSig ? ' · ' : ''}${withdrawSig ? `Withdrawal ${link(withdrawSig)}` : ''}. Verify the on-chain results using these links.`;
    card.appendChild(rec);
    addMsg('ai', esc(isSend || withdrawOnly
      ? `Confirmed on-chain: ${fmt(a.amount)} ${a.token} withdrawn before relayer fees to ${api.short(a.recipient)}. Review the transaction links; privacy is not guaranteed.`
      : `Shielded ${fmt(a.amount)} ${a.token}. To use this existing balance without another deposit, choose Withdraw private balance in Wallet.`));
    try { state.shielded = { ...state.shielded, ...await L.balance(a.token) }; }
    catch { state.shielded[a.token] = null; addMsg('sys', 'Transaction confirmed, but the updated private balance is unavailable. Do not repeat the transaction just to refresh it.'); }
    renderWallet();
    await loadActivity();
  } catch (err) {
    const submitted = depositSig || (err.operation === 'deposit' ? err.submittedSignature : null);
    if (submitted) {
      const receipt = document.createElement('p');
      const anchor = document.createElement('a');
      anchor.href = `https://solscan.io/tx/${encodeURIComponent(submitted)}`;
      anchor.target = '_blank'; anchor.rel = 'noopener'; anchor.textContent = 'View submitted deposit on Solscan';
      receipt.append(anchor); card.append(receipt);
    }
    const submittedWithdrawal = withdrawSig || (err.operation === 'withdrawal' ? err.submittedSignature : null);
    if (submittedWithdrawal) {
      const link = document.createElement('a');
      link.href = `https://solscan.io/tx/${encodeURIComponent(submittedWithdrawal)}`;
      link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Check submitted withdrawal on Solscan before retrying';
      card.append(link);
    }
    fail(err?.message?.toLowerCase().includes('reject') && !submitted && !submittedWithdrawal ? 'You rejected the signature. No confirmed transaction is recorded; inspect your wallet before retrying.' : `Stopped: ${err.message || 'unknown error'}. Do not repeat a deposit. Use Withdraw private balance for any funds already deposited.`);
  } finally {
    progress.textContent = '';
    state.busy = false;
  }
}

async function loadLive() {
  if (state.live) return state.live;
  const wallet = state.wallet;
  // Route relayer traffic through this host (avoids CORS, keeps the user's IP away from the relayer)
  if (state.cfg?.relayerProxy) globalThis.__DM_RELAYER__ = `${location.origin}/api/relayer`;
  const mod = await import('./live/privacy-cash.js');
  const live = await mod.createLive({ rpcUrl: `${location.origin}/api/rpc`, wallet });
  if (state.wallet !== wallet) throw new Error('Wallet changed. Connect again before continuing.');
  state.live = live;
  return state.live;
}

/* =============== wallet pane =============== */
const walletEl = $('[data-wallet]');
function renderWallet() {
  const pill = $('[data-wallet-pill]');
  $('[data-wallet-disconnect]').hidden = !state.wallet;
  pill.title = state.wallet ? `${state.wallet.name}: ${state.wallet.address}` : 'Connect wallet';
  pill.setAttribute('aria-label', state.wallet ? `Connected ${state.wallet.name} wallet. Open wallet details` : 'Connect wallet');
  if (!state.wallet) {
    pill.textContent = 'Connect wallet';
    const found = detectWallets();
    walletEl.innerHTML = `
      <p class="micro mute" style="margin:0">Choose a wallet. Duskmoth only asks for signatures, never your keys.</p>
      <div class="wallet-list">
        ${found.map((w) => `<button class="btn" type="button" data-connect="${w.id}"><span>${w.name}</span><span class="micro mute">Detected</span></button>`).join('')}
        ${found.length ? '' : '<p class="micro mute" style="margin:4px 0">No wallet extension found. Install Phantom, Solflare or Backpack. No demo wallet is available.</p>'}
      </div>`;
    walletEl.querySelectorAll('[data-connect]').forEach((b) => b.addEventListener('click', () => connect(b.dataset.connect)));
    return;
  }
  const w = state.wallet;
  pill.textContent = api.short(w.address);
  const A = state.activity;
  const loading = state.activityLoading;
  const solscan = `https://solscan.io/account/${encodeURIComponent(w.address)}`;
  const stat = (label, value, sub = '') => `<div class="stat"><span class="micro mute">${label}</span><b>${value}</b>${sub ? `<span class="micro mute">${sub}</span>` : ''}</div>`;
  const dash = loading ? '…' : '–';
  const st = A?.stats;
  walletEl.innerHTML = `
    <div class="w-id">
      <div>
        <p class="micro mute" style="margin:0 0 4px">${esc(w.name)}${w.demo ? ' · demo, no real funds' : ' · Solana mainnet'}</p>
        <p class="addr" style="margin:0" title="${esc(w.address)}">${esc(api.short(w.address))}</p>
      </div>
      <div class="w-links">
        <button class="icon-btn" type="button" data-copy-addr aria-label="Copy address" title="Copy address"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg></button>
        ${w.demo ? '' : `<a class="icon-btn" href="${solscan}" target="_blank" rel="noopener" aria-label="View on Solscan" title="View on Solscan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg></a>`}
      </div>
    </div>
    <div class="stats-grid">
      ${stat('Public SOL', A?.sol == null ? dash : fmt(A.sol, 3))}
      ${stat('Public USDC', A?.usdc == null ? dash : fmt(A.usdc, 2))}
      ${stat('Shielded', state.shielded.SOL == null ? 'Not loaded' : fmt(state.shielded.SOL, 3), state.shielded.USDC == null ? 'USDC not loaded' : `SOL · ${fmt(state.shielded.USDC, 2)} USDC`)}
      ${stat('Txs, 30 days', st ? (st.last30d >= st.sampled ? `${st.sampled}+` : st.last30d) : dash)}
      ${stat('Active days', st ? `${st.activeDays30d}/30` : dash)}
      ${stat('Last active', st?.lastActive ? ago(st.lastActive) : dash, st?.failed ? `${st.failed} failed recently` : '')}
    </div>
    <div class="act-head">
      <span class="micro micro-strong">Recent activity</span>
      <button class="link-btn micro" type="button" data-refresh ${loading ? 'disabled' : ''}>${loading ? 'Loading…' : 'Refresh'}</button>
    </div>
    ${historyHtml(A, loading)}
    <p class="micro mute src-line">${A ? sourceLabel(A) : ''}</p>
    <div class="actions">
      <button class="btn" type="button" data-score-now>Score this wallet</button>
      ${state.cfg?.liveSend && !w.demo ? '<button class="btn" type="button" data-unlock>Show private balance</button>' : ''}
      <button class="btn" type="button" data-disconnect>Disconnect</button>
    </div>
    ${state.cfg?.liveSend ? `<details class="withdrawal-panel"><summary>Withdraw private balance</summary>
      <p class="withdrawal-help">Use funds already deposited. This does not make another deposit. Relayer fees are deducted from the amount.</p>
      <form data-withdraw-form class="withdrawal-form">
        <label class="withdrawal-field">Token <select class="withdrawal-control" name="token" required><option>SOL</option><option>USDC</option></select></label>
        <label class="withdrawal-field">Amount before relayer fees <input class="withdrawal-control" name="amount" type="number" min="0.000000001" step="any" required placeholder="0.02"></label>
        <label class="withdrawal-field">Recipient Solana address <input class="withdrawal-control" name="recipient" type="text" required value="${esc(w.address)}" spellcheck="false" autocomplete="off"></label>
        <button class="btn primary withdrawal-submit" type="submit">Review withdrawal</button>
      </form></details>` : ''}`;
  $('[data-withdraw-form]', walletEl)?.addEventListener('submit', e => {
    e.preventDefault();
    if (state.busy) { toast('A transaction is already in progress.'); return; }
    const values = new FormData(e.currentTarget);
    const action = { type: 'withdraw', token: values.get('token'), amount: Number(values.get('amount')), recipient: String(values.get('recipient')).trim() };
    showPane('chat');
    renderPreview(action);
  });
  $('[data-disconnect]', walletEl).addEventListener('click', disconnect);
  $('[data-score-now]', walletEl).addEventListener('click', () => { showPane('score'); runScore(); });
  $('[data-refresh]', walletEl).addEventListener('click', loadActivity);
  $('[data-copy-addr]', walletEl).addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(w.address); toast('Address copied'); } catch { toast('Copy failed'); }
  });
  $('[data-unlock]', walletEl)?.addEventListener('click', async () => {
    if (state.busy) { toast('A private-balance operation is already in progress. Please wait.'); return; }
    state.busy = true;
    const button = $('[data-unlock]', walletEl);
    button.disabled = true;
    const status = document.createElement('p');
    status.className = 'transfer-progress';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'Loading the privacy engine…';
    button.after(status);
    const account = state.wallet.address;
    try {
      const L = await loadLive();
      const balances = await L.balance(undefined, ({ detail }) => { status.textContent = detail; });
      if (state.wallet?.address === account) { state.shielded = balances; renderWallet(); }
    }
    catch (e) { toast(e.message || 'Could not read the private balance.'); }
    finally { state.busy = false; button.disabled = false; status.remove(); }
  });
}

const TYPE_LABEL = { receive: 'Received', send: 'Sent', shield: 'Shielded', unshield: 'Private payout', program: 'App interaction', unknown: 'Transaction' };
const TYPE_ICON = {
  receive: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
  unshield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  program: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  unknown: '<circle cx="12" cy="12" r="8"/>',
};
function ago(ts) {
  const d = Math.max(0, Date.now() / 1000 - ts);
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) + ' UTC';
}
function amountHtml(h) {
  if (h.detailsAvailable === false) return '<span class="mute">Details unavailable</span>';
  const parts = [];
  if (h.usdc) parts.push(`${h.usdc > 0 ? '+' : '−'}${fmt(Math.abs(h.usdc), 2)} USDC`);
  if (h.sol && Math.abs(h.sol) >= 0.000001) parts.push(`${h.sol > 0 ? '+' : '−'}${fmt(Math.abs(h.sol), 4)} SOL`);
  if (!parts.length) return '<span class="mute">–</span>';
  const pos = (h.usdc || h.sol) > 0;
  return `<span class="${pos ? 'pos' : 'neg'}">${parts.join('<br>')}</span>`;
}
function historyHtml(A, loading) {
  if (loading && !A) return '<ul class="history">' + Array.from({ length: 4 }, () => '<li class="skel"><i></i><span></span><span></span></li>').join('') + '</ul>';
  if (!A) return '';
  if (A.error) return `<p class="empty">${esc(A.error)}</p>`;
  if (!A.history.length) return '<p class="empty">No transactions yet on mainnet.</p>';
  return `<ul class="history">${A.history.map((h) => {
    const link = A.source === 'demo' ? null : `https://solscan.io/tx/${encodeURIComponent(h.signature)}`;
    const inner = `
      <span class="h-ic t-${h.type}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${TYPE_ICON[h.type] || TYPE_ICON.unknown}</svg></span>
      <span class="h-main"><b>${TYPE_LABEL[h.type] || 'Transaction'}${h.ok ? '' : ' <em class="fail">failed</em>'}</b><span class="micro mute">${h.time ? ago(h.time) : 'pending'} · ${esc(h.signature.slice(0, 6))}…</span></span>
      <span class="h-amt">${amountHtml(h)}</span>`;
    return `<li>${link ? `<a href="${link}" target="_blank" rel="noopener">${inner}</a>` : `<div>${inner}</div>`}</li>`;
  }).join('')}</ul>`;
}
function sourceLabel(A) {
  if (A.source === 'demo') return 'Demo data. Connect a real wallet to read Solana mainnet.';
  if (A.source === 'unavailable') return 'Solana mainnet RPC unavailable.';
  const st = A.stats;
  return `Live from Solana mainnet${A.source === 'helius-rpc' ? ' via Helius' : ''} · stats from the last ${st?.sampled ?? 0} transactions`;
}

async function connect(id) {
  try {
    if (await walletSession.connect(id)) toast(`Connected ${api.short(state.wallet.address)}`);
    else toast('That wallet is not available in this browser.');
  } catch (e) {
    toast(e?.message?.includes('rejected') ? 'Connection rejected.' : 'Could not connect the wallet.');
  }
}
async function disconnect() {
  await walletSession.disconnect();
  toast('Wallet disconnected. Pending transactions are not cancelled.');
}
async function loadActivity() {
  const w = state.wallet;
  if (!w) return;
  state.activityLoading = true; renderWallet();
  try {
    const activity = await api.activity(w.address);
    if (state.wallet !== w) return;
    state.activity = activity;
    state.publicSol = activity.sol;
  } catch (e) {
    if (state.wallet !== w) return;
    state.activity = { error: e.message || 'Could not load wallet activity.', history: [] };
  }
  if (state.wallet !== w) return; // disconnected meanwhile
  state.activityLoading = false; renderWallet();
}

/* =============== score pane =============== */
const scoreEl = $('[data-score]');
const R = 80, C = 2 * Math.PI * R;
function gaugeHtml() {
  return `<div class="gauge"><svg viewBox="0 0 190 190" aria-hidden="true">
      <circle cx="95" cy="95" r="${R}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="12"/>
      <circle class="arc" cx="95" cy="95" r="${R}" fill="none" stroke="url(#sg)" stroke-width="12" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}"/>
      <defs><linearGradient id="sg" x1="0" x2="1"><stop offset="0" stop-color="#ff6b2c"/><stop offset=".5" stop-color="#e9c46a"/><stop offset="1" stop-color="#9fd27a"/></linearGradient></defs>
    </svg><div class="val"><div><b data-num>–</b><span class="micro mute" data-grade>Not scored</span></div></div></div>`;
}
function renderScoreIdle() {
  $('[data-score-source]').textContent = '';
  if (!state.wallet) {
    scoreEl.innerHTML = `${gaugeHtml()}<p class="empty">How loud is your wallet? Connect it and sign a free message to prove it is yours. We only score wallets you own.</p>
      <div class="actions" style="justify-content:center"><button class="btn primary" type="button" data-go-wallet>Connect wallet</button></div>`;
    $('[data-go-wallet]', scoreEl).addEventListener('click', () => showPane('wallet'));
    return;
  }
  scoreEl.innerHTML = `${gaugeHtml()}<p class="empty">Ready to score ${esc(api.short(state.wallet.address))}. You will sign a message that costs nothing.</p>
    <div class="actions" style="justify-content:center"><button class="btn primary" type="button" data-run>Get my score</button></div>`;
  $('[data-run]', scoreEl).addEventListener('click', runScore);
}

let lastScore = null;
async function runScore() {
  if (!state.wallet) { renderScoreIdle(); return; }
  const wallet = state.wallet;
  if (!$('.gauge', scoreEl)) renderScoreIdle();
  const btn = $('[data-run]', scoreEl);
  if (btn) { btn.disabled = true; btn.textContent = 'Waiting for signature…'; }
  try {
    const proof = await proveOwnership(wallet);
    if (state.wallet !== wallet) return;
    if (btn) btn.textContent = 'Reading the chain…';
    const s = await api.score(proof);
    if (state.wallet !== wallet) return;
    lastScore = s;
    $('[data-score-source]').textContent = 'Live data · heuristic estimate';
    scoreEl.innerHTML = `${gaugeHtml()}
      <ul class="signals">${s.signals.map((g) => `<li class="${g.detected ? (g.impact < 0 ? 'hit' : 'good') : ''}"><span>${esc(g.label)}</span><span>${g.detected === null ? 'unavailable' : g.detected ? (g.impact > 0 ? '+' : '') + g.impact : 'not detected'}</span></li>`).join('')}</ul>
      <p class="score-summary">${esc(s.summary)}</p>
      ${s.fixes?.length ? `<p class="micro" style="margin:14px 0 6px">How to get quieter</p><ul class="micro mute" style="margin:0;padding-left:18px">${s.fixes.map((f) => `<li style="margin-bottom:6px;text-transform:none;letter-spacing:0;font-size:12px">${esc(f)}</li>`).join('')}</ul>` : ''}
      <div class="actions"><button class="btn primary" type="button" data-share>Share my score</button><button class="btn" type="button" data-rerun>Score again</button></div>`;
    const arc = $('circle.arc', scoreEl), num = $('[data-num]', scoreEl), grade = $('[data-grade]', scoreEl);
    requestAnimationFrame(() => { arc.style.strokeDashoffset = String(C * (1 - s.score / 100)); });
    grade.textContent = `Grade ${s.grade}`;
    if (gsap && !reduced) { const o = { v: 0 }; gsap.to(o, { v: s.score, duration: 1.4, ease: 'expo.out', onUpdate: () => (num.textContent = Math.round(o.v)) }); gsap.from($('.signals', scoreEl).children, { opacity: 0, x: -10, stagger: 0.06, duration: 0.6, ease: 'expo.out' }); }
    else num.textContent = s.score;
    $('[data-share]', scoreEl).addEventListener('click', () => openShare(s));
    $('[data-rerun]', scoreEl).addEventListener('click', runScore);
    addMsg('ai', esc(`Your privacy estimate is ${s.score}/100 using ${s.coverage?.checked ?? '?'} of ${s.coverage?.total ?? '?'} checks. Unavailable checks are not proof of safety. ${s.fixes?.[0] ? 'First fix: ' + s.fixes[0] : ''}`));
  } catch (e) {
    if (state.wallet !== wallet) return;
    toast(e?.message?.includes('rejected') ? 'Signature rejected. No score.' : e.message || 'Could not score this wallet.');
    renderScoreIdle();
  }
}

/* =============== share card =============== */
const modal = $('[data-modal]');
function drawCard(s) {
  const c = document.createElement('canvas'); c.width = 1200; c.height = 630;
  const g = c.getContext('2d');
  g.fillStyle = '#050505'; g.fillRect(0, 0, 1200, 630);
  const cx = 360, cy = 315, r = 160;
  g.lineWidth = 24; g.lineCap = 'round';
  g.strokeStyle = '#1c1c1c'; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  const grad = g.createLinearGradient(cx - r, 0, cx + r, 0); grad.addColorStop(0, '#ff6b2c'); grad.addColorStop(0.5, '#e9c46a'); grad.addColorStop(1, '#9fd27a');
  g.strokeStyle = grad; g.beginPath(); g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * s.score) / 100); g.stroke();
  const eye = g.createRadialGradient(cx - 18, cy - 20, 4, cx, cy, 70);
  eye.addColorStop(0, '#fff6d6'); eye.addColorStop(0.25, '#f0c34c'); eye.addColorStop(0.55, '#e2401f'); eye.addColorStop(1, '#3d5a20');
  g.fillStyle = eye; g.beginPath(); g.arc(cx, cy, 66, 0, 7); g.fill();
  g.fillStyle = '#0d0604'; g.beginPath(); g.arc(cx, cy, 22, 0, 7); g.fill();
  const chrome = g.createLinearGradient(0, 160, 0, 260); chrome.addColorStop(0, '#fff'); chrome.addColorStop(0.45, '#b9b9c2'); chrome.addColorStop(0.55, '#55555e'); chrome.addColorStop(1, '#eee');
  g.fillStyle = chrome; g.font = '400 92px "Bodoni Moda", Georgia, serif'; g.fillText('Duskmoth', 610, 240);
  g.fillStyle = '#9a9890'; g.font = '600 20px "Inter Tight", Arial, sans-serif'; g.fillText('PRIVACY SCORE', 614, 290);
  g.fillStyle = '#f2efe8'; g.font = '300 150px "Inter Tight", Arial, sans-serif'; g.fillText(String(s.score), 606, 440);
  const w = g.measureText(String(s.score)).width;
  g.fillStyle = '#6f6d68'; g.font = '300 48px "Inter Tight", Arial, sans-serif'; g.fillText('/100', 616 + w, 440);
  g.fillStyle = '#e9c46a'; g.font = '600 28px "Inter Tight", Arial, sans-serif'; g.fillText(`GRADE ${s.grade}`, 614, 500);
  g.fillStyle = '#6f6d68'; g.font = '400 20px "Inter Tight", Arial, sans-serif'; g.fillText('HOW LOUD IS YOUR WALLET?', 614, 570);
  return c;
}
function shareText(s) { return `My wallet's privacy score is ${s.score}/100 (grade ${s.grade}). How loud is yours? Checked with @duskmoth`; }
function openShare(s) {
  const c = drawCard(s);
  const url = c.toDataURL('image/png');
  $('[data-modal-body]').innerHTML = `<img src="${url}" alt="Privacy score card: ${s.score} out of 100, grade ${s.grade}"><p class="micro mute" style="margin:12px 0 0">No address is printed on the card.</p>`;
  $('[data-share-dl]').href = url;
  modal.classList.add('open');
}
$('[data-modal-close]').addEventListener('click', () => modal.classList.remove('open'));
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.classList.remove('open'); });
$('[data-share-copy]').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(shareText(lastScore)); toast('Copied. Paste it anywhere.'); } catch { toast('Copy is blocked here. Select the text manually.'); }
});
$('[data-share-x]').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = `https://x.com/intent/post?text=${encodeURIComponent(shareText(lastScore))}`; a.target = '_blank'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
});

/* =============== boot =============== */
(async function boot() {
  renderWallet(); renderScoreIdle();
  const restoring = walletSession.restore();
  const greet = addMsg('ai', esc("Evening. Tell me what to move and to whom, in plain words. I'll show you a preview, screen both addresses, and nothing happens until you sign in your own wallet."));
  try { state.cfg = await api.config(); }
  catch {
    $('[data-mode-badge]').lastElementChild.textContent = 'Service unavailable';
    addMsg('sys', 'The server is unavailable. No wallet data, scores, or transactions will be simulated.');
    await restoring;
    return;
  }
  renderWallet(); renderScoreIdle(); // re-render now that we know whether the demo wallet is allowed
  const badge = $('[data-mode-badge]');
  if (state.cfg.liveSend) { badge.classList.add('live'); badge.lastElementChild.textContent = 'Mainnet'; }
  else { badge.lastElementChild.textContent = 'Transfers unavailable'; }
  if (state.cfg.screening === 'off') addMsg('sys', 'Sanctions screening is not configured on this server, so transfers are disabled.');
  if (state.cfg.screening === 'scorechain') addMsg('sys', `Scorechain checks sanctions lists only, not full AML risk. ${state.cfg.liveSend ? 'Mainnet transfers require your confirmation and wallet approval.' : 'Live transfers are unavailable.'} No transactions are simulated.`);
  await restoring;
  if (location.hash === '#score') showPane('score');
  addEventListener('hashchange', () => { if (location.hash === '#score') showPane('score'); });
  void greet;
})();
