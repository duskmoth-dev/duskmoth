const KEY = 'dm_passes';
const MAX = 1000;
globalThis.addEventListener?.('storage', event => { if (event.key === KEY || event.key === null) dispatchEvent(new Event('passes:change')); });
const b64 = (value, min, max) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try { const raw = atob(value); return raw.length >= min && raw.length <= max && btoa(raw) === value; } catch { return false; }
};
function checked(pass) {
  if (!pass || !/^[a-f0-9]{16}$/.test(pass.kid) || !b64(pass.msg, 32, 128) || !b64(pass.sig, 256, 256) || typeof pass.demo !== 'boolean') throw new Error('The backup contains invalid pass data. Nothing was changed.');
  return { kid: pass.kid, msg: pass.msg, sig: pass.sig, demo: pass.demo, at: Number.isFinite(pass.at) ? pass.at : Date.now() };
}
export function all() {
  let records;
  try { records = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { throw new Error('Stored passes could not be read. Do not clear this browser; restore a backup.'); }
  if (!Array.isArray(records) || records.length > MAX) throw new Error('Stored pass data is invalid. Keep a backup before making changes.');
  return records.map(checked);
}
function write(records) {
  if (records.length > MAX) throw new Error('This browser holds too many passes. Back up and use existing passes first.');
  const serialized = JSON.stringify(records);
  try { localStorage.setItem(KEY, serialized); if (localStorage.getItem(KEY) !== serialized) throw Error(); }
  catch { throw new Error('Passes could not be saved in this browser. Keep the purchase recovery data and try again.'); }
  dispatchEvent(new Event('passes:change'));
}
export const count = (kid, demo = false) => all().filter(pass => (!kid || pass.kid === kid) && pass.demo === demo).length;
export function add(list) {
  const current = all(), map = new Map(current.map(pass => [pass.msg, pass]));
  for (const item of list.map(checked)) {
    const existing = map.get(item.msg);
    if (existing && (existing.sig !== item.sig || existing.kid !== item.kid || existing.demo !== item.demo)) throw new Error('Conflicting pass records. Nothing was changed.');
    map.set(item.msg, item);
  }
  write([...map.values()]); return list.length;
}
export function take(kid, demo = false) {
  const current = all(), index = current.findIndex(pass => (!kid || pass.kid === kid) && pass.demo === demo);
  if (index < 0) return null;
  const [pass] = current.splice(index, 1); write(current); return pass;
}
export function restore(pass) { add([pass]); }
export const exportBlob = () => new Blob([JSON.stringify({ type: 'duskmoth-moth-pass', version: 1, passes: all() }, null, 2)], { type: 'application/json' });
export async function importFile(file) {
  if (!file || file.size > 1024 * 1024) throw new Error('Choose a pass backup smaller than 1 MB.');
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error('This is not a valid JSON backup.'); }
  if (data.type !== 'duskmoth-moth-pass' || data.version !== 1 || !Array.isArray(data.passes) || data.passes.length > MAX) throw new Error('This is not a supported Moth Pass backup.');
  const records = data.passes.map(checked);
  const { passInfo } = await import('./api.js?mode=real');
  const info = await passInfo();
  if (!info.enabled || !info.publicKey) throw new Error('Pass verification is unavailable. Keep the backup and try again later.');
  const { importPublicKey, verifyPass } = await import('./live/moth-pass.js');
  const pk = await importPublicKey(info.publicKey);
  for (const pass of records) {
    if (pass.kid !== info.kid || pass.demo !== info.demo || !await verifyPass(pk, pass)) throw new Error('A pass could not be verified with the current issuer key. Nothing was imported; keep your backup.');
  }
  add(records); return records.length;
}
