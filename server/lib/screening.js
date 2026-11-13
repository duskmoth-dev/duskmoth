import bs58 from 'bs58';
import { randomUUID } from 'node:crypto';

// Accept on- and off-curve Solana public keys, but never a merely base58-looking string.
export function isSolanaAddress(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try { return bs58.decode(value).length === 32; } catch { return false; }
}

export function parseSanctionsResponse(body) {
  const entry = Array.isArray(body) && body.length === 1 ? body[0] : body;
  if (!entry || Array.isArray(entry) || typeof entry.isSanctioned !== 'boolean') {
    throw new Error('invalid-response');
  }
  return { isSanctioned: entry.isSanctioned };
}

/** Dependencies are injectable for deterministic failure-path tests. No sample-data fallback. */
export function createScreening({
  getKey = () => process.env.SCORECHAIN_API_KEY,
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = 6000,
  retryDelayMs = 250,
  log = (event) => console.warn(JSON.stringify(event)),
} = {}) {
  return async function screenTransfer({ sender, recipient } = {}) {
    const out = {
      source: 'scorechain',
      scope: 'sanctions-only',
      allowed: false,
      notice: 'Sanctions-list checks only. Not a full risk assessment or proof that funds are safe.',
    };
    for (const [role, address] of Object.entries({ recipient, sender })) {
      if (role === 'sender' && (address === null || address === undefined)) continue;
      if (!isSolanaAddress(address)) {
        return { ...out, errorCode: 'invalid-address', reason: `Invalid ${role} Solana address.` };
      }
    }
    if (!getKey()) {
      return { ...out, source: 'off', errorCode: 'not-configured', reason: 'Scorechain sanctions screening is not configured. Not proceeding.' };
    }
    // No caching of wallet addresses or provider responses. Each result is a fresh lookup.
    for (const [role, address] of Object.entries({ recipient, sender })) {
      if (!address) continue;
      // Identical sender/recipient needs only one request against the limited free quota.
      if (role === 'sender' && address === recipient) { out.sender = { ...out.recipient }; continue; }
      const requestId = randomUUID();
      // Read-only retry, at most once per address. Never retry a match,
      // malformed result, rejected credential or exhausted provider quota.
      for (let attempt = 0; attempt < 2; attempt++) {
      let failure = 'network-error', upstreamStatus = null;
      const signal = AbortSignal.timeout(timeoutMs), started = Date.now();
      try {
        const response = await fetchImpl(`https://sanctions.api.scorechain.com/v1/addresses/${encodeURIComponent(address)}`, {
          headers: { 'x-api-key': getKey(), Accept: 'application/json' },
          signal,
          redirect: 'error',
        });
        if (!response.ok) {
          upstreamStatus = response.status;
          failure = response.status === 429 ? 'rate-limited'
            : [401, 403].includes(response.status) ? 'authentication'
            : response.status >= 500 ? 'provider-unavailable' : 'provider-rejected';
          throw new Error('provider-error');
        }
        failure = 'invalid-response';
        out[role] = { ...parseSanctionsResponse(await response.json()), checkedAt: new Date().toISOString() };
        break;
      } catch {
        if (signal.aborted) failure = 'timeout';
        const retry = attempt === 0 && ['network-error', 'timeout', 'provider-unavailable'].includes(failure);
        // Never log addresses, response bodies, request URLs, or credentials.
        log({ event: retry ? 'sanctions_check_retry' : 'sanctions_check_failed', provider: 'scorechain',
          code: failure, role, attempt: attempt + 1, upstreamStatus, durationMs: Date.now() - started, requestId });
        if (retry) { await new Promise(resolve => setTimeout(resolve, retryDelayMs)); continue; }
        return {
          ...out, errorCode: failure, failedRole: role, requestId,
          reason: failure === 'rate-limited'
            ? 'Scorechain request limit reached. Screening is incomplete; not proceeding. Try again later.'
            : 'Scorechain screening could not be completed. Not proceeding. Try again later.',
        };
      }
      }
    }
    out.allowed = !out.recipient.isSanctioned && !out.sender?.isSanctioned;
    if (!out.allowed) out.reason = 'Scorechain reports a sanctions-list match for one of these addresses. This transfer is blocked.';
    return out;
  };
}

export const screenTransfer = createScreening();
