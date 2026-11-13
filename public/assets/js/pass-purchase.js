import * as api from './api.js?mode=real';
import * as passes from './passes.js';
import { b58encode } from './wallet.js';
const PENDING = 'dm_pass_pending';
const rpcUrl = () => `${location.origin}/api/rpc`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const engine = () => import('./live/moth-pass.js');
function read() {
  try { return JSON.parse(localStorage.getItem(PENDING) || 'null'); }
  catch { throw new Error('Saved purchase data is unreadable. Do not clear this browser or burn again.'); }
}
function save(value) {
  const serialized = JSON.stringify(value);
  localStorage.setItem(PENDING, serialized);
  if (localStorage.getItem(PENDING) !== serialized) throw new Error('Purchase recovery could not be saved. No new burn will be requested.');
}
export function pendingPurchase() {
  const value = read();
  return value ? { burnSignature: value.burnSignature || null, count: value.count, demo: value.demo } : null;
}
async function locked(task) {
  if (!navigator.locks) throw new Error('This browser cannot safely coordinate pass purchases. Use a browser supporting Web Locks.');
  return navigator.locks.request('dm_pass_purchase', { ifAvailable: true }, lock => {
    if (!lock) throw new Error('A pass purchase is active in another tab.');
    return task();
  });
}
async function finish(saved, info, wallet, onStep) {
  if (!info.enabled || saved.kid !== info.kid || saved.publicKey !== info.publicKey || saved.demo !== info.demo || saved.mint !== info.mint || saved.price !== info.price) throw new Error('Issuer configuration changed. Keep this saved purchase and contact the operator; do not burn again.');
  const L = await engine(), pk = await L.importPublicKey(saved.publicKey);
  if (!saved.demo && !saved.burnSignature) {
    try {
      saved.burnSignature = await L.burnDmoth({
        rpcUrl: rpcUrl(), wallet, mint: saved.mint, amountUi: saved.count * saved.price, onStep,
        onSigned({ signature, blockhash, lastValidBlockHeight }) {
          saved.burnSignature = signature; saved.blockhash = blockhash; saved.lastValidBlockHeight = lastValidBlockHeight; save(saved);
        },
      });
      save(saved);
    } catch (error) {
      if (!saved.burnSignature) localStorage.removeItem(PENDING);
      throw error;
    }
  } else if (!saved.demo) {
    await L.confirmBurn({ rpcUrl: rpcUrl(), signature: saved.burnSignature, blockhash: saved.blockhash, lastValidBlockHeight: saved.lastValidBlockHeight, onStep });
  }
  onStep({ step: 3, detail: saved.demo ? 'Requesting development-only blind signatures.' : 'Sign a no-cost claim proving you authorized this burn. Your passes remain blinded.' });
  const request = { blinded: saved.blinded };
  if (saved.demo) request.demo = true;
  else {
    if (!wallet || wallet.provider?.publicKey?.toString() !== wallet.address) throw new Error('Reconnect the wallet that authorized this burn.');
    const batchBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(saved.blinded)));
    const batch = Array.from(new Uint8Array(batchBytes), byte => byte.toString(16).padStart(2, '0')).join('');
    const ts = Date.now();
    const message = `Duskmoth Moth Pass\nBurn: ${saved.burnSignature}\nBatch: ${batch}\nTimestamp: ${ts}\nThis signs a pass claim only. It does not move funds.`;
    const address = wallet.address, signature = b58encode(await wallet.signMessage(message));
    if (wallet.provider?.publicKey?.toString() !== address || wallet.address !== address) throw new Error('The wallet changed during the claim. Resume with the burn wallet.');
    request.burnSignature = saved.burnSignature; request.proof = { address, ts, signature };
  }
  let result;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { result = await api.issuePasses(request); break; }
    catch (error) {
      if (error.status !== 404 || attempt === 4) throw error;
      onStep({ step: 3, detail: 'The burn is confirmed but not indexed yet. Retrying the same saved purchase.' });
      await sleep(2500);
    }
  }
  if (result.kid !== saved.kid || result.demo !== saved.demo || result.count !== result.signatures?.length || result.count !== saved.count) throw new Error('The issuer returned an unexpected result. Keep the saved purchase; do not burn again.');
  onStep({ step: 4, detail: 'Unblinding and verifying every pass in your browser.' });
  const finalized = await L.finalizePasses(pk, saved.items, result.signatures, result.kid, result.demo);
  passes.add(finalized);
  localStorage.removeItem(PENDING);
  onStep({ step: 5, detail: 'Passes saved in this browser. Back them up now.' });
  return { passes: finalized, burnSignature: saved.burnSignature || null, demo: saved.demo };
}
export async function purchase({ info, wallet, count, onStep = () => {} }) {
  return locked(async () => {
    if (read()) throw new Error('A saved purchase needs recovery. Resume it instead of burning again.');
    if (!info.enabled || !Number.isInteger(count) || count < 1 || count > info.maxPerBurn || !Number.isSafeInteger(count * info.price)) throw new Error('Moth Pass is unavailable or the quantity is invalid.');
    if (passes.all().length + count > 1000) throw new Error('Back up and use your existing passes before purchasing more.');
    onStep({ step: 0, detail: 'Blinding passes and saving recovery data before any irreversible burn.' });
    const L = await engine(), pk = await L.importPublicKey(info.publicKey);
    const batch = await L.blindPasses(pk, count);
    const saved = { ...batch, kid: info.kid, publicKey: info.publicKey, mint: info.mint, price: info.price, demo: info.demo, count };
    save(saved);
    return finish(saved, info, wallet, onStep);
  });
}
export async function resumePurchase({ info, wallet, onStep = () => {} }) {
  return locked(async () => {
    const saved = read();
    if (!saved) throw new Error('There is no saved purchase to resume.');
    return finish(saved, info, wallet, onStep);
  });
}
