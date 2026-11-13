// Real backend only. Never manufacture wallet data, scores, or successful submissions.
export const isAddress = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
export const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');

async function call(path, opts = {}, timeout = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`/api${path}`, {
      ...opts, signal: ctrl.signal, cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    const body = await res.json();
    if (!res.ok) {
      const error = new Error(body.error || body.reason || `Request failed (${res.status}).`);
      error.status = res.status; error.body = body; throw error;
    }
    return body;
  } catch (error) {
    if (error.status) throw error;
    throw new Error('The server could not be reached or returned invalid data. No result is available.');
  } finally { clearTimeout(timer); }
}

export const config = () => call('/config', {}, 8000);
export const passInfo = () => call('/pass/info', {}, 25000);
export const issuePasses = body => call('/pass/issue', { method: 'POST', body: JSON.stringify(body) }, 120000);
export const redeemPass = body => call('/pass/redeem', { method: 'POST', body: JSON.stringify(body) }, 30000);
export const premiumAction = (feature, body) => call(feature === 'ai-pack' ? '/ai-pack/plan' : '/payroll/authorize', { method: 'POST', body: JSON.stringify(body) }, 90000);
export const rpcRead = async (method, params) => {
  const body = await call('/rpc', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, 25000);
  if (body.error) throw new Error('Mainnet transaction details are unavailable. No receipt status was changed.');
  return body.result;
};
export const relayerConfig = () => call('/relayer/config', {}, 15000);
export const magicblockInfo = owner => call(`/engines/magicblock/info${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`, {}, 8000);
export const magicblockReview = body => call('/engines/magicblock/review', { method: 'POST', body: JSON.stringify(body) }, 90000);
export const withdrawalPrivacy = body => call('/privacy/withdraw-check', { method: 'POST', body: JSON.stringify(body) }, 35000);
export const intent = (message) => call('/intent', { method: 'POST', body: JSON.stringify({ message }) }, 30000);
export async function screen(payload) {
  // Two parties, each with at most two 6s provider attempts plus short backoff.
  try { return await call('/screen', { method: 'POST', body: JSON.stringify(payload) }, 30000); }
  catch (error) {
    if (error.body?.allowed === false) return error.body;
    return { source: 'off', scope: 'sanctions-only', allowed: false,
      errorCode: error.status === 429 ? 'rate-limited' : 'unavailable',
      reason: 'Sanctions screening is unavailable. Not proceeding.' };
  }
}
export const score = (payload) => call('/score', { method: 'POST', body: JSON.stringify(payload) }, 30000);
export const activity = (address) => call('/activity', { method: 'POST', body: JSON.stringify({ address }) }, 30000);
export const waitlist = (email) => call('/waitlist', { method: 'POST', body: JSON.stringify({ email }) });
export const cardUrl = ({ score, grade }) => `/api/card.svg?score=${encodeURIComponent(score)}&grade=${encodeURIComponent(grade)}`;
