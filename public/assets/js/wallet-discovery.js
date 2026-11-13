import { detectWallets } from './wallet.js?mode=real';

// Refresh when an extension injects after the initial page render.
export function observeWallets(onChange, root = globalThis.window) {
  if (!root?.addEventListener) return () => {};
  let previous = null;
  const refresh = (force = false) => {
    const next = detectWallets(root);
    if (force || !previous || next.length !== previous.length || next.some((w, i) => w.id !== previous[i]?.id || w.provider !== previous[i]?.provider)) {
      previous = next; onChange(next);
    }
  };
  const check = () => refresh();
  const force = () => refresh(true);
  const events = ['focus', 'pageshow', 'phantom#initialized', 'solana#initialized'];
  events.forEach(event => root.addEventListener(event, check));
  root.addEventListener('duskmoth:wallets-refresh', force);
  root.document?.addEventListener('visibilitychange', check);
  const timer = setInterval(check, 250);
  timer.unref?.();
  const stopTimer = setTimeout(() => clearInterval(timer), 30000);
  stopTimer.unref?.();
  refresh();
  return () => {
    clearInterval(timer); clearTimeout(stopTimer);
    events.forEach(event => root.removeEventListener(event, check));
    root.removeEventListener('duskmoth:wallets-refresh', force);
    root.document?.removeEventListener('visibilitychange', check);
  };
}

export function walletBrowserLinks(root = globalThis.window) {
  const mobile = /Android|iPhone|iPad|iPod/i.test(root?.navigator?.userAgent || '')
    || (root?.navigator?.platform === 'MacIntel' && root?.navigator?.maxTouchPoints > 1);
  const origin = root.location.origin;
  // No query tokens, private-operation data or browser storage are forwarded.
  const page = encodeURIComponent(`${origin}${root.location.pathname}`);
  const ref = encodeURIComponent(origin);
  return mobile ? [
    { label: 'Open in Phantom', href: `https://phantom.com/ul/browse/${page}?ref=${ref}` },
    { label: 'Open in Solflare', href: `https://solflare.com/ul/v1/browse/${page}?ref=${ref}` },
  ] : [
    { label: 'Get Phantom', href: 'https://phantom.com/' },
    { label: 'Get Solflare', href: 'https://solflare.com/' },
    { label: 'Get Backpack', href: 'https://backpack.app/' },
  ];
}

export function walletHelp(root = window) {
  const doc = root.document, fragment = doc.createDocumentFragment();
  const note = doc.createElement('p'); note.className = 'micro mute';
  note.textContent = 'On mobile, open this page in your wallet’s browser. Passes stay in the browser where you acquired them; back them up before switching browsers.';
  const links = doc.createElement('div'); links.className = 'wallet-list';
  for (const item of walletBrowserLinks(root)) {
    const a = doc.createElement('a'); a.className = 'btn'; a.textContent = item.label;
    a.href = item.href; a.rel = 'noopener noreferrer'; links.append(a);
  }
  if (root.top !== root) {
    const a = doc.createElement('a'); a.className = 'btn'; a.textContent = 'Open page in a new tab';
    a.href = `${root.location.origin}${root.location.pathname}`; a.target = '_blank'; a.rel = 'noopener noreferrer'; links.append(a);
  }
  const retry = doc.createElement('button'); retry.type = 'button'; retry.className = 'btn';
  retry.textContent = 'Refresh wallet detection';
  retry.addEventListener('click', () => root.dispatchEvent(new root.Event('duskmoth:wallets-refresh')));
  links.append(retry); fragment.append(note, links); return fragment;
}

export function walletConnectionError(error) {
  const message = String(error?.message || '');
  if (error?.code === 4001 || /reject|denied|declin|cancel/i.test(message)) return 'Connection declined. Select your wallet to try again.';
  if (error?.code === -32002 || /already.*(pending|processing)|connection is already pending/i.test(message)) return 'A connection request is already open. Approve or reject it in your wallet first.';
  if (/timed out/i.test(message)) return 'Connection timed out. Unlock your wallet, then reconnect and approve the request.';
  if (/valid|verified|account/i.test(message)) return 'Your wallet account is not available yet. Unlock the wallet and connect again.';
  return 'Could not connect. Unlock your wallet and approve the connection. On mobile, use the wallet’s built-in browser.';
}
