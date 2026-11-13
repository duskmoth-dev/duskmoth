import test from 'node:test';
import assert from 'node:assert/strict';
import { createScreening, isSolanaAddress, parseSanctionsResponse } from './screening.js';

const recipient = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const sender = '11111111111111111111111111111111';
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const service = (fetchImpl, extra = {}) => createScreening({
  getKey: () => 'test-credential-not-real', fetchImpl, log: () => {}, ...extra,
});

test('Solana validation requires exactly 32 decoded bytes', () => {
  assert.equal(isSolanaAddress(recipient), true);
  assert.equal(isSolanaAddress(sender), true);
  for (const value of [null, {}, 'not-a-wallet', '1'.repeat(33), '1'.repeat(44), ` ${recipient}`]) {
    assert.equal(isSolanaAddress(value), false);
  }
});

test('accepts strict object and single-entry array responses', () => {
  assert.deepEqual(parseSanctionsResponse({ isSanctioned: false }), { isSanctioned: false });
  assert.deepEqual(parseSanctionsResponse([{ isSanctioned: true }]), { isSanctioned: true });
  for (const body of [null, {}, [], [{ isSanctioned: false }, { isSanctioned: true }], { isSanctioned: 'false' }, { isSanctioned: 0 }]) {
    assert.throws(() => parseSanctionsResponse(body));
  }
});

test('checks both parties using documented endpoint and private header', async () => {
  const urls = [];
  const check = service(async (url, init) => {
    urls.push(url);
    assert.equal(init.headers['x-api-key'], 'test-credential-not-real');
    assert.equal(init.redirect, 'error');
    return response({ isSanctioned: false, details: null });
  });
  const result = await check({ recipient, sender });
  assert.equal(result.allowed, true);
  assert.equal(result.source, 'scorechain');
  assert.equal(result.scope, 'sanctions-only');
  assert.equal(result.sender.isSanctioned, false);
  assert.ok(result.recipient.checkedAt.endsWith('Z'));
  assert.equal(urls.length, 2);
  assert.ok(urls.every(url => url.startsWith('https://sanctions.api.scorechain.com/v1/addresses/')));
  assert.equal('score' in result.recipient, false);
});

test('recipient-only check does not claim a checked sender', async () => {
  const result = await service(async () => response({ isSanctioned: false }))({ recipient });
  assert.equal(result.allowed, true);
  assert.equal('sender' in result, false);
});

test('identical parties use one lookup', async () => {
  let calls = 0;
  const result = await service(async () => { calls++; return response({ isSanctioned: false }); })({ recipient, sender: recipient });
  assert.equal(calls, 1);
  assert.deepEqual(result.sender, result.recipient);
});

for (const role of ['sender', 'recipient']) {
  test(`sanctioned ${role} is blocked (mocked provider match)`, async () => {
    const result = await service(async url => response([{ isSanctioned: url.endsWith(role === 'sender' ? sender : recipient) }]))({ recipient, sender });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /sanctions-list match/);
  });
}

test('rejects invalid sender rather than silently skipping it', async () => {
  const result = await service(() => { throw new Error('Must not call upstream'); })({ recipient, sender: '1'.repeat(33) });
  assert.equal(result.errorCode, 'invalid-address');
  assert.equal(result.allowed, false);
});

test('missing recipient fails closed before upstream', async () => {
  const result = await service(() => { throw new Error('Must not call upstream'); })({ sender });
  assert.equal(result.errorCode, 'invalid-address');
  assert.equal(result.allowed, false);
});

test('missing credential never returns demo results', async () => {
  const result = await service(() => { throw new Error('Must not call upstream'); }, { getKey: () => '' })({ recipient });
  assert.equal(result.source, 'off');
  assert.equal(result.allowed, false);
  assert.equal(result.errorCode, 'not-configured');
});

for (const status of [401, 403, 429, 500]) {
  test(`provider HTTP ${status} fails closed`, async () => {
    const result = await service(async () => response({ isSanctioned: false }, status))({ recipient });
    assert.equal(result.allowed, false);
    assert.ok(result.errorCode);
    assert.equal(JSON.stringify(result).includes('test-credential-not-real'), false);
  });
}

test('malformed provider data fails closed', async () => {
  for (const body of [{}, { isSanctioned: 'false' }, []]) {
    const result = await service(async () => response(body))({ recipient });
    assert.equal(result.allowed, false);
    assert.equal(result.errorCode, 'invalid-response');
  }
});

test('one transient retry can recover, but credentials, quota, malformed results and matches are not retried', async () => {
  for (const status of [401, 403, 429, 400, 200]) {
    let calls = 0;
    const check = service(async () => { calls++; return response(status === 200 ? {} : { isSanctioned: false }, status); }, { retryDelayMs: 0 });
    const result = await check({ recipient });
    assert.equal(result.allowed, false); assert.equal(calls, 1);
  }
  let calls = 0;
  const recovered = await service(async () => {
    calls++; return calls === 1 ? response({}, 503) : response({ isSanctioned: false });
  }, { retryDelayMs: 0 })({ recipient });
  assert.equal(recovered.allowed, true); assert.equal(calls, 2);
  calls = 0;
  const failed = await service(async () => { calls++; throw new Error('private upstream failure'); }, { retryDelayMs: 0 })({ recipient });
  assert.equal(calls, 2); assert.equal(failed.allowed, false);
  assert.equal(failed.errorCode, 'network-error'); assert.equal(failed.failedRole, 'recipient');
  calls = 0;
  const matched = await service(async () => { calls++; return response({ isSanctioned: true }); })({ recipient });
  assert.equal(matched.allowed, false); assert.equal(calls, 1);
});

test('timeouts fail closed and logs contain no wallet or credential', async () => {
  const events = [];
  const check = service((_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), { timeoutMs: 10, log: event => events.push(event) });
  // Keep the event loop alive while the unref'd AbortSignal timer is pending.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const result = await check({ recipient });
    assert.equal(result.allowed, false);
    const logged = JSON.stringify(events);
    assert.equal(logged.includes(recipient), false);
    assert.equal(logged.includes('test-credential-not-real'), false);
    assert.equal(events[0].provider, 'scorechain');
  } finally { clearInterval(keepAlive); }
});

test('browser never falls back to invented successful screening', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async url => {
      if (url.endsWith('/config')) return response({ screening: 'scorechain', liveSend: false });
      throw new Error('Network offline');
    };
    const api = await import(`../../public/assets/js/api.js?test=${Date.now()}`);
    const result = await api.screen({ recipient });
    assert.equal(result.allowed, false);
    assert.equal(result.source, 'off');
  } finally { globalThis.fetch = originalFetch; }
});

test('offline browser screening is blocked', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('Network offline'); };
    const api = await import(`../../public/assets/js/api.js?offline=${Date.now()}`);
    const result = await api.screen({ recipient });
    assert.equal(result.allowed, false);
    assert.equal(result.source, 'off');
  } finally { globalThis.fetch = originalFetch; }
});
