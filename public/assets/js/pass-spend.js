import * as passes from './passes.js';
import { redeemPass, premiumAction } from './api.js?mode=real';
const JOURNAL = 'dm_pass_redemption';
export function pendingPremium() {
  const value = localStorage.getItem(JOURNAL);
  if (!value) return null;
  try { return JSON.parse(value); } catch { throw new Error('The saved pass request is unreadable. Keep your browser data and backup.'); }
}
export async function requestPremium(info, feature, payload = {}, save = () => {}) {
  if (!info?.enabled || !navigator.locks) throw new Error('Safe pass redemption is unavailable in this browser.');
  return navigator.locks.request('dm_pass_spend', { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('A pass is being spent in another tab.');
    let saved;
    try { saved = pendingPremium(); } catch { throw new Error('An earlier pass redemption needs recovery. Keep your browser data.'); }
    if (saved && (saved.pass.kid !== info.kid || saved.pass.demo !== info.demo)) throw new Error('An earlier pass redemption belongs to a different issuer. Keep your browser data.');
    if (saved && ((saved.feature || 'split-withdraw') !== feature || JSON.stringify(saved.payload || {}) !== JSON.stringify(payload))) throw new Error('An earlier premium request needs recovery first. Use its original plan; no new pass was spent.');
    if (!saved) {
      const pass = passes.all().find(pass => pass.kid === info.kid && pass.demo === info.demo);
      if (!pass) throw new Error('A Moth Pass is required. Get passes at /pass.');
      saved = { pass, feature, payload, requestId: Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('') };
      const serialized = JSON.stringify(saved);
      localStorage.setItem(JOURNAL, serialized);
      if (localStorage.getItem(JOURNAL) !== serialized) throw new Error('A safe pass recovery record could not be saved.');
    }
    const stored = passes.all().find(pass => pass.msg === saved.pass.msg);
    if (stored) {
      // take() is FIFO; recovered records are normally oldest. Do not take a
      // different credit if a backup changed the list order.
      const next = passes.all().find(pass => pass.kid === info.kid && pass.demo === info.demo);
      if (next?.msg !== saved.pass.msg) throw new Error('Pass order changed during recovery. Keep the backup and contact the operator.');
      passes.take(info.kid, info.demo);
    }
    try {
      let response;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const pass = { kid: saved.pass.kid, msg: saved.pass.msg, sig: saved.pass.sig, requestId: saved.requestId, feature };
          response = feature === 'split-withdraw' ? await redeemPass(pass) : await premiumAction(feature, { ...payload, pass });
          break;
        }
        catch (error) { if (error.status || attempt === 1) throw error; }
      }
      if (response.ok !== true || response.feature !== feature || !/^[a-f0-9]{64}$/.test(response.grant)) throw new Error('Pass redemption could not be verified. Retry the same saved credit.');
      // The caller persists the delivered result BEFORE the retry journal is
      // cleared. If saving fails, the same pass/request can recover it.
      await save(response, saved);
      localStorage.removeItem(JOURNAL); return response;
    } catch (error) {
      if (![409, 410].includes(error.status)) passes.restore(saved.pass);
      if (error.status === 409 || (error.status >= 400 && error.status < 500)) localStorage.removeItem(JOURNAL);
      throw error;
    }
  });
}
export const spendSplitPass = info => requestPremium(info, 'split-withdraw');
