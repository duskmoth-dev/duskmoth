// Only public phase names/counters reach the UI. Never forward SDK log payloads.
let listener = () => {};
let scanContext = null;
// SDK pagination writes its offset before finishing the scan. A failed scan must
// not skip discovered notes next time: persist the offset only after the note cache.
export function scanStorage(storage) {
  const offsets = new Map();
  return {
    getItem(key) { return offsets.has(key) ? offsets.get(key) : storage.getItem(key); },
    setItem(key, value) {
      value = String(value);
      if (key.startsWith('fetch_offset')) { offsets.set(key, value); return; }
      storage.setItem(key, value);
      if (key.startsWith('encrypted_outputs')) {
        const offsetKey = 'fetch_offset' + key.slice('encrypted_outputs'.length);
        if (offsets.has(offsetKey)) { storage.setItem(offsetKey, offsets.get(offsetKey)); offsets.delete(offsetKey); }
      }
    },
    removeItem(key) { offsets.delete(key); storage.removeItem(key); },
  };
}
export function report(phase, detail = '') { listener({ phase, detail }); }
export async function withProgress(onProgress, operation) {
  const previous = listener;
  listener = onProgress || (() => {});
  try { return await operation(); } finally { listener = previous; }
}
export async function sdkFetch(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(45000) }); }
  catch { throw new Error('Privacy service request timed out or could not connect. Check your balance and transaction history before retrying.'); }
  if (!response.ok) throw new Error(`Privacy service request failed (${response.status}). Check your balance before retrying.`);
  return response;
}
export function scanBatch(data) {
  scanContext = Number.isFinite(data?.start) && Number.isFinite(data?.total)
    ? { start: data.start, total: data.total } : null;
}
export async function scanYield(processed, total) {
  const position = scanContext ? Math.min(scanContext.start + processed, scanContext.total) : processed;
  const count = scanContext?.total ?? total;
  report('scan', `Checking pool records: ${position.toLocaleString('en-US')} of ${count.toLocaleString('en-US')}. First-time scans can take several minutes.`);
  await new Promise(resolve => setTimeout(resolve, 0));
}
export function sdkLog(level, message) {
  if (level !== 'info') return;
  if (message === 'generating ZK proof...') report('proof', 'Generating the privacy proof in your browser. No deposit signature has been requested yet.');
  else if (message === 'submitting transaction to relayer...') report('submit', 'Submitting the signed transaction. Do not repeat the deposit.');
  else if (message === 'Waiting for transaction confirmation...') report('confirm', 'Waiting for on-chain confirmation and private-balance indexing.');
}
