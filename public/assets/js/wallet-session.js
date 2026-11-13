import { providerAddress } from './wallet.js?mode=real';

// Preference storage is optional. Access inside the session's guarded calls so
// browsers that deny localStorage do not crash the whole wallet interface.
export const walletPreferences = {
  getItem: key => globalThis.localStorage.getItem(key),
  setItem: (key, value) => globalThis.localStorage.setItem(key, value),
  removeItem: key => globalThis.localStorage.removeItem(key),
};

// Persist only the chosen provider name, never a cached identity or signing key.
export function createWalletSession({ makeWallet, storage, onChange, onConnectingChange = () => {}, timeout = 120000 }) {
  let current = null, revision = 0, pending = null, cleanup = () => {};
  function remember(id) {
    try { if (id) storage.setItem('dm_wallet', id); else storage.removeItem('dm_wallet'); } catch {}
  }
  function saved() {
    try { return storage.getItem('dm_wallet'); } catch { return null; }
  }
  function clear(forget = true) {
    revision++;
    cleanup(); cleanup = () => {};
    current = null;
    pending = null;
    onConnectingChange(false);
    if (forget) remember(null);
    onChange(null);
  }
  function adopt(wallet) {
    cleanup();
    current = wallet;
    remember(wallet.id);
    const provider = wallet.provider;
    const changed = key => {
      if (current !== wallet) return;
      try {
        const next = makeWallet(wallet.id);
        if (!next || next.provider !== provider) throw new Error('Wallet provider changed.');
        next.address = providerAddress(provider, key);
        if (next.address === wallet.address) return;
        revision++;
        adopt(next); // New object prevents stale requests from overwriting this account.
      } catch { clear(); }
    };
    const disconnected = () => { if (current === wallet) clear(); };
    provider.on?.('accountChanged', changed);
    provider.on?.('disconnect', disconnected);
    cleanup = () => {
      const remove = provider.off || provider.removeListener;
      remove?.call(provider, 'accountChanged', changed);
      remove?.call(provider, 'disconnect', disconnected);
    };
    onChange(wallet);
  }
  function connect(id, trusted = false) {
    if (pending) {
      if (trusted) return Promise.resolve(false);
      if (!pending.trusted) {
        if (pending.id === id) return pending.promise;
        return Promise.reject(new Error('A wallet connection is already pending. Approve or reject it in your wallet first.'));
      }
    }
    const ticket = ++revision;
    const wallet = makeWallet(id);
    if (!wallet) return Promise.resolve(false);
    const attempt = { id, trusted, ticket, promise: null };
    pending = attempt;
    attempt.promise = (async () => {
      let timer;
      try {
        if (!trusted) onConnectingChange(true, id);
        await Promise.race([
          wallet.connect(trusted ? { onlyIfTrusted: true } : undefined),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Wallet connection timed out. Open your wallet and try again.')), trusted ? Math.min(timeout, 8000) : timeout); }),
        ]);
        if (ticket !== revision) return false;
        adopt(wallet);
        return true;
      } catch (error) {
        if (ticket !== revision || trusted) return false;
        throw error;
      } finally {
        clearTimeout(timer);
        if (pending === attempt) {
          pending = null;
          if (!trusted) onConnectingChange(false);
        }
      }
    })();
    return attempt.promise;
  }
  return {
    connect,
    async restore({ waitMs = 2000 } = {}) {
      const id = saved();
      if (!['phantom', 'solflare', 'backpack'].includes(id)) { if (id) remember(null); return false; }
      const ticket = revision;
      const end = Date.now() + waitMs;
      while (!makeWallet(id) && Date.now() < end) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (ticket !== revision) return false;
      }
      if (ticket !== revision || saved() !== id) return false;
      return connect(id, true); // Never fall back to a prompting connect on refresh.
    },
    async disconnect() {
      const previous = current;
      clear(); // Clear UI and preference even when the extension refuses/hangs.
      if (previous) {
        let timer;
        try { await Promise.race([previous.disconnect(), new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); }
        finally { clearTimeout(timer); }
      }
    },
    validate() {
      if (!current) return;
      try {
        const address = providerAddress(current.provider);
        if (address !== current.address) {
          const next = makeWallet(current.id);
          if (!next || next.provider !== current.provider) throw new Error('Wallet provider changed.');
          next.address = address;
          revision++; adopt(next);
        }
      } catch { clear(); }
    },
    forget() { clear(); },
  };
}
