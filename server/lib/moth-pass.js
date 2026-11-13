import { encryptResult, decryptResult } from './premium-result.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { PassLedger } from './pass-ledger.js';

export const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
export const suite = RSABSSA.SHA384.PSS.Randomized();
const digest = value => createHash('sha256').update(value).digest('hex');
const validAddress = value => { try { return typeof value === 'string' && bs58.decode(value).length === 32; } catch { return false; } };
export class PassError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function bytesFromBase64(value, min, max = min) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new PassError(400, 'Malformed pass data.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < min || bytes.length > max || bytes.toString('base64') !== value) throw new PassError(400, 'Malformed pass data.');
  // The RSA library uses .slice().buffer. Buffer.slice() retains a pooled
  // backing buffer; an exact-size Uint8Array is required for WebCrypto.
  return new Uint8Array(bytes);
}
export function decimalUnits(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^\d+(?:\.\d+)?$/.test(String(value))) throw new PassError(400, 'Invalid token amount.');
  const [whole, fraction = ''] = String(value).split('.');
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) throw new PassError(400, 'Invalid token precision.');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction.slice(0, decimals).padEnd(decimals, '0')) || '0');
}
export function burnedUnits(tx, mint, decimals, authority) {
  if (!tx?.meta || tx.meta.err) return 0n;
  const instructions = [
    ...(tx.transaction?.message?.instructions || []),
    ...(tx.meta.innerInstructions || []).flatMap(group => group.instructions || []),
  ];
  return instructions.reduce((sum, instruction) => {
    const p = instruction.parsed, info = p?.info;
    if (!TOKEN_PROGRAMS.has(String(instruction.programId)) || !['burn', 'burnChecked'].includes(p?.type) || info?.mint !== mint) return sum;
    if (authority && (info.authority || info.owner) !== authority) return sum;
    try {
      const raw = info.tokenAmount?.amount ?? info.amount;
      if (info.tokenAmount?.decimals !== undefined && info.tokenAmount.decimals !== decimals) return sum;
      const amount = raw !== undefined && /^\d+$/.test(String(raw))
        ? BigInt(raw) : decimalUnits(info.tokenAmount?.uiAmountString, decimals);
      return amount > 0n && amount <= 18446744073709551615n ? sum + amount : sum;
    } catch { return sum; }
  }, 0n);
}
export function burnClaimMessage(burnSignature, batch, ts) {
  return `Duskmoth Moth Pass\nBurn: ${burnSignature}\nBatch: ${batch}\nTimestamp: ${ts}\nThis signs a pass claim only. It does not move funds.`;
}
function ownsBurn(proof, burn, batch, tx, now) {
  if (!proof || !validAddress(proof.address) || !Number.isSafeInteger(proof.ts) || Math.abs(now - proof.ts) > 300000) return false;
  if (!(tx.transaction?.message?.accountKeys || []).some(key => key.signer === true && String(key.pubkey) === proof.address)) return false;
  try {
    return nacl.sign.detached.verify(Buffer.from(burnClaimMessage(burn, batch, proof.ts)), bs58.decode(proof.signature), bs58.decode(proof.address));
  } catch { return false; }
}
async function signingKey(directory, env, demo, store) {
  const loadOriginal = async () => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, demo ? 'pass-key-demo.json' : 'pass-key.json');
  let jwk;
  if (!demo && env.PASS_PRIVATE_JWK) jwk = JSON.parse(env.PASS_PRIVATE_JWK);
  else if (fs.existsSync(filename)) { fs.chmodSync(filename, 0o600); jwk = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  else {
    if (['pass-burns', 'pass-spent'].some(file => fs.existsSync(path.join(directory, file)) && fs.statSync(path.join(directory, file)).size)) {
      throw new Error('Restore the original signing key before serving existing pass credits.');
    }
    const pair = await suite.generateKey({ modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1) });
    jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
    if (!store) {
      const fd = fs.openSync(filename, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(jwk)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  }
  return jwk;
  };
  const jwk = store ? await store.issuerKey(loadOriginal) : await loadOriginal();
  const algorithm = { name: 'RSA-PSS', hash: 'SHA-384' };
  const privateKey = await webcrypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'] }, algorithm, true, ['sign']);
  if (privateKey.algorithm.modulusLength !== 2048 || Buffer.from(privateKey.algorithm.publicExponent).toString('hex') !== '010001') throw new Error('A 2048-bit pass key with exponent 65537 is required.');
  const publicJwk = { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'PS384', ext: true, key_ops: ['verify'] };
  const publicKey = await webcrypto.subtle.importKey('jwk', publicJwk, algorithm, true, ['verify']);
  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', publicKey));
  return { privateKey, publicKey, spki: spki.toString('base64'), kid: digest(spki).slice(0, 16) };
}
export function createPassService({ directory, rpc, env = process.env, now = Date.now }) {
  const production = env.NODE_ENV === 'production';
  const demo = !production && env.ALLOW_DEMO_PASSES === 'true' && !env.DMOTH_MINT;
  const mint = env.DMOTH_MINT || null;
  const price = Number(env.PASS_PRICE_DMOTH || 50000);
  const max = Number(env.PASS_MAX_PER_BURN || 50);
  const maxAge = Number(env.PASS_BURN_MAX_AGE_HOURS || 72);
  let ledger, key, unavailable, mintCache;
  const pending = new Set();
  const ready = (async () => {
    try {
      if (!Number.isSafeInteger(price) || price < 1 || !Number.isSafeInteger(max) || max < 1 || max > 50 || !Number.isFinite(maxAge) || maxAge <= 0) throw new Error('Invalid pass configuration.');
      if (env.PASS_STORAGE && !['postgres', 'file'].includes(env.PASS_STORAGE)) throw new Error('Unknown pass storage.');
      if (!demo && env.PASS_STORAGE === 'postgres') {
        const { PostgresPassLedger } = await import('./pass-postgres.js');
        ledger = new PostgresPassLedger({ connectionString: env.DATABASE_URL, secret: env.SESSION_SECRET });
        key = await signingKey(directory, env, demo, ledger);
        await ledger.importLegacy(directory);
        await ledger.health();
      } else {
        ledger = new PassLedger(directory);
        key = await signingKey(directory, env, demo);
      }
    } catch {
      unavailable = 'Pass signing or storage is unavailable. The operator must restore its configuration.';
      await ledger?.close();
    }
  })();
  async function mintInfo() {
    if (mintCache && mintCache.until > now()) return mintCache.info;
    if (!validAddress(mint)) throw new PassError(503, 'The configured $DMOTH mint is invalid.');
    const genesis = await rpc('getGenesisHash', []);
    if (genesis !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw new PassError(503, 'Moth Pass requires Solana mainnet.');
    const response = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const value = response?.value, data = value?.data?.parsed;
    if (!TOKEN_PROGRAMS.has(value?.owner) || value.executable || data?.type !== 'mint' || data.info?.isInitialized !== true || !Number.isInteger(data.info?.decimals) || data.info.decimals < 0 || data.info.decimals > 18) throw new PassError(503, '$DMOTH must be an initialized, supported SPL mint on mainnet.');
    const metadata = data.info.extensions?.find(extension => extension.extension === 'tokenMetadata')?.state;
    mintCache = { until: now() + 60000, info: {
      decimals: data.info.decimals,
      program: value.owner,
      name: typeof metadata?.name === 'string' ? metadata.name.slice(0, 100) : null,
      symbol: typeof metadata?.symbol === 'string' ? metadata.symbol.slice(0, 20) : null,
    } };
    return mintCache.info;
  }
  async function info() {
    await ready;
    // Verify token identity independently of purchase readiness. A storage
    // blocker must not make a configured mint look verified or unconfigured.
    let token = null, mintError = null;
    if (!demo && mint) {
      try {
        const details = await mintInfo();
        token = { ...details, verified: true, network: 'solana-mainnet', priceRaw: decimalUnits(price, details.decimals).toString() };
      } catch { mintError = '$DMOTH mainnet mint validation is unavailable or failed.'; }
    }
    let reason = unavailable;
    if (!reason && ledger?.durable) {
      try { await ledger.health(); } catch { reason = 'Pass storage is temporarily unavailable. No purchase or redemption is allowed.'; }
    }
    if (!reason && production && !ledger?.durable && env.PASS_STATE_DURABLE !== 'true') reason = 'Moth Pass needs durable burn and spent-pass storage before real burns can be enabled.';
    if (!reason && !mint && !demo) reason = '$DMOTH mint is not configured. Ordinary Duskmoth features remain available.';
    if (!reason && mintError) reason = mintError;
    if (ledger?.poisoned) reason = 'Pass storage needs operator recovery. No new credits can be issued or spent.';
    return {
      enabled: !reason, reason: reason || null, mint, token, price, maxPerBurn: demo ? Math.min(3, max) : max,
      demo, storage: ledger?.durable ? 'postgres' : 'file',
      durable: !!ledger?.durable, kid: key?.kid || null, publicKey: key?.spki || null,
      suite: 'RSABSSA-SHA384-PSS-Randomized',
      features: {
        'split-withdraw': { cost: 1, label: 'Split withdraw' },
        'ai-pack': { cost: 1, label: 'AI Pack', enabled: !!env.ANTHROPIC_API_KEY && !!env.SESSION_SECRET && !reason },
        'private-payroll': { cost: 1, label: 'Private payroll', enabled: !reason },
      },
    };
  }
  return {
    info,
    async check(body = {}, context = {}) {
      const current = await info();
      if (!current.enabled) throw new PassError(503, current.reason);
      if (body.feature !== 'private-payroll' || !/^[a-f0-9]{64}$/.test(context.binding || '')
        || !/^[a-f0-9]{32}$/.test(body.requestId || '') || body.kid !== key.kid) throw new PassError(400, 'Invalid Payroll pass proof.');
      const msg = bytesFromBase64(body.msg, 32, 128), sig = bytesFromBase64(body.sig, 256);
      let verified = false;
      try { verified = await suite.verify(key.publicKey, sig, msg); } catch {}
      if (!verified) throw new PassError(400, 'Invalid pass signature.');
      const previous = await ledger.getSpend(digest(msg));
      if (previous && (previous.feature !== body.feature || previous.binding !== context.binding || previous.requestId !== body.requestId)) throw new PassError(409, 'This pass has already been spent on another action.');
      return { ok: true, spent: !!previous };
    },
    async issue(body = {}) {
      const current = await info();
      if (!current.enabled) throw new PassError(503, current.reason);
      if (!Array.isArray(body.blinded) || body.blinded.length < 1 || body.blinded.length > max) throw new PassError(400, `Provide 1–${max} blinded passes.`);
      const blinded = body.blinded.map(value => bytesFromBase64(value, 256));
      const batch = digest(JSON.stringify(body.blinded));
      let count, burn, previous;
      if (body.demo === true) {
        if (!demo) throw new PassError(503, 'Demo passes are disabled.');
        count = Math.min(3, blinded.length);
      } else {
        if (!mint) throw new PassError(503, '$DMOTH mint is not configured.');
        try { if (bs58.decode(body.burnSignature).length !== 64) throw Error(); } catch { throw new PassError(400, 'Invalid burn transaction signature.'); }
        burn = body.burnSignature;
        if (pending.has(burn)) throw new PassError(409, 'This burn is being checked. Retry the same saved purchase shortly.');
        previous = await ledger.getBurn(burn);
        if (previous && (previous.batch !== batch || previous.kid !== key.kid)) throw new PassError(409, 'This burn has already been used.');
        pending.add(burn);
      }
      try {
        if (burn) {
          const { decimals } = await mintInfo();
          const tx = await rpc('getTransaction', [burn, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
          if (!tx) throw new PassError(404, 'Burn transaction not found yet. Wait a few seconds and try again.');
          if (tx.meta?.err || !Number.isFinite(tx.blockTime) || tx.blockTime * 1000 > now() + 60000 || (!previous && now() - tx.blockTime * 1000 > maxAge * 3600000)) throw new PassError(400, 'The burn failed or is outside the claim window.');
          if (!ownsBurn(body.proof, burn, batch, tx, now())) throw new PassError(403, 'Sign this saved purchase with the wallet that authorized the burn.');
          const burned = burnedUnits(tx, mint, decimals, body.proof.address);
          count = previous?.count ?? Math.min(Number(burned / (BigInt(price) * 10n ** BigInt(decimals))), max, blinded.length);
          if (!Number.isSafeInteger(count) || count < 1) throw new PassError(400, `Burn at least ${price} $DMOTH per pass.`);
        }
        let signatures;
        try { signatures = await Promise.all(blinded.slice(0, count).map(value => suite.blindSign(key.privateKey, value).then(sig => Buffer.from(sig).toString('base64')))); }
        catch { throw new PassError(400, 'Invalid blinded messages. Nothing was claimed.'); }
        if (burn && !previous && !await ledger.burn({ burn, batch, count, kid: key.kid })) {
          previous = await ledger.getBurn(burn);
          if (previous?.batch !== batch || previous?.kid !== key.kid || previous?.count !== count) throw new PassError(409, 'This burn has already been claimed.');
        }
        return { kid: key.kid, count, signatures, demo: body.demo === true, recovered: !!previous };
      } finally { if (burn) pending.delete(burn); }
    },
    async redeem(body = {}, context = {}) {
      const current = await info();
      if (!current.enabled) throw new PassError(503, current.reason);
      if (!['split-withdraw', 'ai-pack', 'private-payroll'].includes(body.feature)) throw new PassError(400, 'Unknown premium feature.');
      if (body.feature !== 'split-withdraw' && !/^[a-f0-9]{64}$/.test(context.binding || '')) throw new PassError(400, 'Use the dedicated premium feature endpoint.');
      if (body.feature !== 'split-withdraw' && !body.requestId) throw new PassError(401, 'A valid Moth Pass proof and recovery request are required.');
      if (body.feature === 'ai-pack' && (typeof context.prepare !== 'function' || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32)) throw new PassError(503, 'AI Pack recovery protection is unavailable.');
      if (body.kid !== key.kid) throw new PassError(400, 'This pass belongs to a different issuer key.');
      const msg = bytesFromBase64(body.msg, 32, 128), sig = bytesFromBase64(body.sig, 256);
      if (body.requestId !== undefined && !/^[a-f0-9]{32}$/.test(body.requestId)) throw new PassError(400, 'Invalid redemption request.');
      let verified = false;
      try { verified = await suite.verify(key.publicKey, sig, msg); } catch {}
      if (!verified) throw new PassError(400, 'Invalid pass signature.');
      const hash = digest(msg), previous = await ledger.getSpend(hash);
      const response = (saved, recovered = false) => {
        if ((saved.feature || 'split-withdraw') !== body.feature || (saved.binding || null) !== (context.binding || null)) throw new PassError(409, 'This pass was used for a different feature or plan.');
        const result = { ok: true, feature: body.feature, grant: saved.grant, ...(saved.binding ? { binding: saved.binding } : {}), ...(recovered ? { recovered: true } : {}) };
        if (body.feature === 'ai-pack') {
          if (!saved.encryptedResult || new Date(saved.resultExpiresAt).getTime() <= now()) throw new PassError(410, 'The 7-day AI recovery window has expired. This pass remains spent.');
          result.result = decryptResult(saved.encryptedResult, env.SESSION_SECRET, hash);
        }
        return result;
      };
      if (previous) {
        if (body.requestId && previous.requestId === body.requestId) return response(previous, true);
        throw new PassError(409, 'This pass has already been spent.');
      }
      const actionLock = `ai:${hash}`;
      if (body.feature === 'ai-pack' && pending.has(actionLock)) throw new PassError(503, 'This saved AI request is already running. Retry the same request shortly.');
      if (body.feature === 'ai-pack') pending.add(actionLock);
      try {
      const grant = randomBytes(32).toString('hex');
      const row = { hash, grant, feature: body.feature, ...(context.binding ? { binding: context.binding } : {}), ...(body.requestId ? { requestId: body.requestId } : {}) };
      if (body.feature === 'ai-pack') {
        // Provider validation succeeds before any pass is consumed. The result
        // and spent-pass record are committed together in the same unique row.
        const result = await context.prepare();
        row.encryptedResult = encryptResult(result, env.SESSION_SECRET, hash);
        row.resultExpiresAt = new Date(now() + 7 * 86400000).toISOString();
      }
      if (!await ledger.spend(row)) {
        const saved = await ledger.getSpend(hash);
        if (body.requestId && saved?.requestId === body.requestId) return response(saved, true);
        throw new PassError(409, 'This pass has already been spent.');
      }
      return response(row);
      } finally { if (body.feature === 'ai-pack') pending.delete(actionLock); }
    },
    async close() { await ready; if (!unavailable) await ledger?.close(); },
  };
}
