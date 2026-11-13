// Wallet-only MagicBlock SDK executor. The provider's opaque transaction bytes
// are never signed: build locally from the reviewed mint, owner and recipient.
import { PublicKey, Transaction, TransactionMessage, ComputeBudgetProgram } from '@solana/web3.js';
import { delegateSpl, transferSpl, withdrawSpl, deriveShuttleEphemeralAta,
  deriveShuttleWalletAta } from '@magicblock-labs/ephemeral-rollups-sdk';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { validateAssertion } from './burn-transaction.js';
import { MAGICBLOCK_ORIGIN, MAGICBLOCK_RPC, MAGICBLOCK_USDC, magicblockPayload } from '../../public/assets/js/magicblock-contract.js';

const mint = new PublicKey(MAGICBLOCK_USDC);
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const ESPL = 'SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2';
const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
export const magicblockATA = owner => PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0].toBase58();
const enc = value => Buffer.from(value).toString('base64');
function core(ix) {
  return JSON.stringify({ program: ix.programId.toBase58(), keys: ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), data: enc(ix.data) });
}
export function verifyMagicblockSource(tx, intent, payment, record) {
  const message = tx?.transaction?.message;
  const payer = message?.accountKeys?.[0];
  if (!message || (typeof payer === 'string' ? payer : payer?.pubkey) !== intent.owner || tx.meta?.err) return false;
  const expectedCode = intent.kind === 'deposit' ? 24 : intent.kind === 'withdraw' ? 26 : intent.source === 'ephemeral' ? 16 : 25;
  return (message.instructions || []).some(ix => {
    if (ix.programId !== ESPL || !ix.accounts?.includes(MAGICBLOCK_USDC) || !ix.accounts.includes(intent.owner) || !ix.data) return false;
    try {
      const data = Buffer.from(bs58.decode(ix.data)), privateSource = expectedCode === 16;
      if (data[0] !== expectedCode || data.length < 13 || data.readBigUInt64LE(privateSource ? 1 : 5) !== BigInt(Math.round(payment.amount * 1e6))) return false;
      if (!privateSource && data.readUInt32LE(1) !== record.nonce) return false;
      // Private-transfer client references are encrypted in source data. Their
      // original values are bound to the signed durable reservation; verify the
      // reference again in the recipient settlement log, not ciphertext bytes.
      return true;
    } catch { return false; }
  });
}
export function verifyMagicblockSigned(signed, unsigned, owner) {
  let tx = signed;
  if (!Array.isArray(tx.instructions) && tx.message) {
    const message = TransactionMessage.decompile(tx.message);
    tx = new Transaction({ feePayer: message.payerKey, recentBlockhash: message.recentBlockhash }).add(...message.instructions);
    tx.addSignature(new PublicKey(owner), Buffer.from(signed.signatures[0]));
  }
  if (!tx || tx.feePayer?.toBase58() !== owner || tx.recentBlockhash !== unsigned.recentBlockhash) throw new Error('The wallet returned a different payer or expired transaction. Nothing was broadcast.');
  // Account privileges are global in a Solana compiled message. Normalize both
  // sides before comparing; raw SDK per-instruction flags can be less writable.
  const normalize = t => Transaction.from(t.serialize({ requireAllSignatures: false, verifySignatures: false }));
  tx = normalize(tx);
  const expected = normalize(unsigned);
  const approvedAccounts = new Map(expected.instructions.flatMap(ix => ix.keys).map(k => [k.pubkey.toBase58(), k]));
  for (const ix of tx.instructions.filter(ix => ix.programId.toBase58() === LIGHTHOUSE)) validateAssertion(ix, approvedAccounts);
  const withoutCompute = t => t.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId) && ix.programId.toBase58() !== LIGHTHOUSE);
  if (JSON.stringify(withoutCompute(tx).map(core)) !== JSON.stringify(withoutCompute(expected).map(core))) throw new Error('The wallet changed the payment instructions. Nothing was broadcast.');
  for (const ix of tx.instructions.filter(ix => ix.programId.equals(ComputeBudgetProgram.programId))) {
    if (ix.keys.length || ![2, 3].includes(ix.data[0]) || ix.data.length !== (ix.data[0] === 2 ? 5 : 9)) throw new Error('Unsupported wallet fee instruction.');
    if (ix.data[0] === 2 && ix.data.readUInt32LE(1) > 1400000) throw new Error('Wallet compute limit is invalid.');
  }
  if (tx.signatures.length !== 1 || tx.signatures[0].publicKey.toBase58() !== owner
    || !tx.signatures[0].signature || !nacl.sign.detached.verify(tx.serializeMessage(), tx.signatures[0].signature, new PublicKey(owner).toBytes())) throw new Error('The wallet did not return a valid owner signature.');
  return tx;
}
export async function localMagicblockInstructions(intent, payment, validator, nonce, clientRefId, magicAtaSource = false) {
  const owner = new PublicKey(intent.owner), v = new PublicKey(validator);
  const amount = BigInt(Math.round(payment.amount * 1e6));
  const opts = { validator: v, shuttleId: nonce, private: true, idempotent: true,
    initIfMissing: true, initAtasIfMissing: true, initVaultIfMissing: false };
  if (intent.kind === 'deposit') return delegateSpl(owner, mint, amount, opts);
  if (intent.kind === 'withdraw') return withdrawSpl(owner, mint, amount, { ...opts, magicAtaSource });
  return transferSpl(owner, new PublicKey(payment.recipient), mint, amount, {
    ...opts, visibility: 'private', fromBalance: intent.source, toBalance: 'base',
    privateTransfer: { exactOut: false, split: 1, minDelayMs: 0n, maxDelayMs: 0n, clientRefId: BigInt(clientRefId) },
  });
}
export function createMagicblockEngine({ wallet, rpcUrl, fetchImpl = fetch, assertWallet = () => {} }) {
  let bearer = null, expires = 0, identity = null;
  const owner = wallet.address;
  const check = () => { assertWallet(); if (wallet.provider?.publicKey?.toString() !== owner) throw new Error('Wallet changed. Reconnect the operation owner.'); };
  async function json(url, options = {}) {
    let r;
    try { r = await fetchImpl(url, { cache: 'no-store', redirect: 'error', ...options, signal: AbortSignal.timeout(25000) }); }
    catch { throw new Error('MagicBlock request timed out. If a signature was saved, check it instead of sending again.'); }
    if (!r.ok) {
      if ([401, 403].includes(r.status)) { bearer = null; expires = 0; }
      throw new Error([401, 403].includes(r.status) ? 'Private-session access expired or was refused. Reconnect to MagicBlock and check your saved operation.' : `MagicBlock request unavailable (${r.status}). Nothing new was signed.`);
    }
    const body = await r.json();
    if (body?.error) {
      const error = new Error('The rollup could not complete this request. Check the saved operation before retrying.');
      error.preflightRejected = body.error.code === -32002 && body.error.data?.err != null;
      throw error;
    }
    return body;
  }
  async function api(path, body, auth = false) {
    if (auth) await login();
    return json(`${MAGICBLOCK_ORIGIN}${path}`, { method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: `Bearer ${bearer}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  async function login() {
    check();
    if (bearer && expires > Date.now()) return;
    const { challenge } = await api(`/v1/spl/challenge?cluster=mainnet-private&pubkey=${encodeURIComponent(owner)}`);
    if (typeof challenge !== 'string' || !challenge || challenge.startsWith('MOCK:')) throw new Error('A real private-rollup challenge was not returned.');
    const signature = bs58.encode(await wallet.signMessage(challenge));
    check();
    const result = await api('/v1/spl/login', { pubkey: owner, challenge, signature, cluster: 'mainnet-private' });
    if (typeof result.token !== 'string' || !result.token.startsWith(`${owner}.`)) throw new Error('MagicBlock did not return a wallet-bound private session.');
    bearer = result.token; expires = Date.now() + 15 * 60 * 1000;
  }
  async function rpc(method, params, runtime = 'base') {
    if (runtime === 'ephemeral') await login();
    const data = await json(runtime === 'base' ? rpcUrl : MAGICBLOCK_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(runtime === 'ephemeral' ? { Authorization: `Bearer ${bearer.slice(owner.length + 1)}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return data.result;
  }
  async function validator() {
    if (!identity) {
      const data = await rpc('getIdentity', [], 'ephemeral');
      identity = new PublicKey(data.identity).toBase58();
    }
    return identity;
  }
  async function balance(source = 'ephemeral') {
    check();
    const data = await api(`/v1/spl/${source === 'ephemeral' ? 'private-balance' : 'balance'}?cluster=mainnet-private&mint=${MAGICBLOCK_USDC}&address=${owner}`, null, source === 'ephemeral');
    if (data.address !== owner || data.mint !== MAGICBLOCK_USDC || data.location !== source || !/^\d+$/.test(data.balance)) throw new Error("Couldn't read the USDC balance. This is not zero; please retry.");
    if (source === 'ephemeral' && data.delegation?.status === 'delegated' && data.delegation.validator !== await validator()) throw new Error('The private balance is on a different validator. No fallback or new deposit was made.');
    return { units: data.balance, readAt: Date.now() };
  }
  async function cost(tx, runtime, operationLamports = '0') {
    const before = await rpc('getBalance', [owner, { commitment: 'confirmed' }], runtime);
    const result = await rpc('simulateTransaction', [enc(tx.serialize({ requireAllSignatures: false, verifySignatures: false })), {
      encoding: 'base64', sigVerify: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [owner] },
    }], runtime);
    if (!result?.value || result.value.err || !result.value.accounts?.[0]) throw new Error('This exact transaction could not pass simulation. No signature was requested. Check USDC, SOL and rollup availability.');
    const fee = await rpc('getFeeForMessage', [enc(tx.serializeMessage()), { commitment: 'confirmed' }], runtime);
    if (!Number.isSafeInteger(fee?.value) || fee.value < 0 || !Number.isSafeInteger(before?.value)) throw new Error('The full network fee could not be verified.');
    const after = result.value.accounts[0].lamports;
    if (!Number.isSafeInteger(after)) throw new Error('Account setup cost could not be verified.');
    const debit = BigInt(before.value) - BigInt(after);
    if (debit < BigInt(fee.value) || debit < BigInt(operationLamports) + BigInt(fee.value)) throw new Error('Simulation did not verify the full upfront SOL cost.');
    return { networkLamports: String(fee.value), operationLamports, setupLamports: String(debit - BigInt(fee.value) - BigInt(operationLamports)), totalLamports: String(debit) };
  }
  async function quote(intent, payment, record) {
    check();
    const v = await validator(), units = Math.round(payment.amount * 1e6);
    const purpose = ['deposit', 'withdraw'].includes(intent.kind) ? intent.kind : 'transfer';
    const payload = { ...magicblockPayload(purpose, owner, units, payment.recipient),
      validator: v, initIfMissing: true, initAtasIfMissing: true, initVaultIfMissing: false };
    if (purpose === 'transfer') Object.assign(payload, { fromBalance: intent.source, clientRefId: record.clientRefId });
    const built = await api(`/v1/spl/${purpose}`, payload, intent.source === 'ephemeral');
    // The official idempotent withdrawal schedules the ER pull from a BASE
    // transaction. Funding source and transaction runtime are different.
    const runtime = purpose === 'transfer' && intent.source === 'ephemeral' ? 'ephemeral' : 'base';
    if (built.kind !== purpose || built.sendTo !== runtime || built.validator && built.validator !== v
      || !Array.isArray(built.requiredSigners) || built.requiredSigners.length !== 1 || built.requiredSigners[0] !== owner) throw new Error('MagicBlock returned a different route or signer. No transaction was signed.');
    const reported = built.fees || (purpose !== 'transfer' ? { tokens: '0', lamports: '0' } : null);
    if (!reported || !['tokens', 'lamports'].every(k => /^\d{1,20}$/.test(reported[k]))) throw new Error('MagicBlock did not return complete operation fees.');
    if (BigInt(reported.tokens) >= BigInt(units)) throw new Error('Fees leave no USDC for this operation.');
    let magicAtaSource = false;
    if (purpose === 'withdraw') {
      const info = await rpc('getAccountInfo', [magicblockATA(owner), { encoding: 'base64' }], 'ephemeral');
      const data = info?.value?.data && Buffer.from(info.value.data[0], 'base64');
      // SPL close authority COption at byte 129; a Magic ATA uses the rent sysvar.
      magicAtaSource = !!data && data.length >= 165 && data.readUInt32LE(129) === 1
        && new PublicKey(data.subarray(133, 165)).toBase58() === 'SysvarRent111111111111111111111111111111111';
    }
    const instructions = await localMagicblockInstructions(intent, payment, v, record.nonce, record.clientRefId, magicAtaSource);
    const block = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }], runtime);
    if (!block?.value?.blockhash || !Number.isSafeInteger(block.value.lastValidBlockHeight)) throw new Error('A current transaction blockhash could not be read.');
    const tx = new Transaction({ feePayer: new PublicKey(owner), recentBlockhash: block.value.blockhash }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }),
      ...(runtime === 'base' ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 })] : []), ...instructions);
    // The instructions are from the pinned official SDK, with our exact input;
    // the remote transactionBase64 is deliberately not used as signing material.
    const observed = await cost(tx, runtime, reported.lamports);
    // User-approved maximum, not a fabricated provider tariff. This bounded
    // allowance lets wallets add ordinary priority fees without an endless
    // re-review loop; actual signed costs are simulated and must stay below it.
    const allowance = runtime === 'base' ? 100000n : 0n;
    const fees = { ...observed, simulatedNetworkLamports: observed.networkLamports,
      operationFeeSeparated: !!built.fees,
      priorityAllowanceLamports: String(allowance),
      networkLamports: String(BigInt(observed.networkLamports) + allowance),
      totalLamports: String(BigInt(observed.totalLamports) + allowance), tokenUnits: reported.tokens };
    return { tx, fees, runtime, lastValidBlockHeight: block.value.lastValidBlockHeight,
      recipientUnits: String(BigInt(units) - (purpose === 'transfer' ? BigInt(reported.tokens) : 0n)), reviewedAt: Date.now() };
  }
  async function signAndSend(quote, record, save) {
    check();
    if (Date.now() - quote.reviewedAt > 90000) throw new Error('The quote expired. Review current costs again before signing.');
    if (['signed', 'submitted', 'source-confirmed', 'confirmed', 'uncertain'].includes(record.status)) throw new Error('This operation already has a signature or unresolved outcome. Check it; do not send again.');
    const height = await rpc('getBlockHeight', [{ commitment: 'confirmed' }], quote.runtime);
    if (height > quote.lastValidBlockHeight - 10) throw new Error('The transaction blockhash is expiring. Review a fresh transaction.');
    record.status = 'awaiting-wallet'; save();
    let signed;
    try {
      const copy = Transaction.from(quote.tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
      signed = verifyMagicblockSigned(await wallet.signTransaction(copy), quote.tx, owner); check();
    }
    catch (e) { record.status = 'pending'; save(); throw e; }
    // Allow Phantom's safe compute-budget additions, but never an unapproved
    // increase in the full upfront cost or a changed payment instruction.
    const current = await cost(signed, quote.runtime, quote.fees.operationLamports);
    if (BigInt(current.totalLamports) > BigInt(quote.fees.totalLamports)) { record.status = 'pending'; save(); throw new Error('Wallet network fees increased. Review the new total before signing again. Nothing was broadcast.'); }
    const signature = bs58.encode(signed.signatures[0].signature);
    if (record.signature) record.failedAttempts = [...(record.failedAttempts || []), { signature: record.signature, runtime: record.runtime }].slice(-20);
    delete record.failureKind;
    Object.assign(record, { status: 'signed', signature, runtime: quote.runtime, lastValidBlockHeight: quote.lastValidBlockHeight,
      recipientUnits: quote.recipientUnits, paidFees: current });
    save(); // A storage failure here stops before broadcast, not after.
    try {
      record.status = 'submitted'; save();
      // RPC retransmission uses the identical signed bytes/signature. It does
      // not create a second payment or re-sign an uncertain operation.
      const result = await rpc('sendTransaction', [enc(signed.serialize()), { encoding: 'base64', skipPreflight: false,
        preflightCommitment: 'confirmed', maxRetries: 5 }], quote.runtime);
      if (result !== signature) throw new Error('Signature mismatch');
    } catch (error) {
      if (error.preflightRejected) {
        record.status = 'failed'; record.failureKind = 'preflight'; save();
        throw new Error('Network simulation rejected this transaction before broadcast. No payment was sent. Review again after correcting the cause.');
      }
      record.status = 'uncertain'; save();
      throw new Error('Submission outcome is unknown. Your signature is saved. Check it before any new payment.');
    }
    return signature;
  }
  async function status(record, intent, payment) {
    if (!record.signature) return { status: 'pending' };
    if (record.failureKind === 'preflight') return { status: 'failed' };
    const result = await rpc('getSignatureStatuses', [[record.signature], { searchTransactionHistory: true }], record.runtime || 'base');
    const item = result?.value?.[0];
    if (!item) return { status: 'uncertain' };
    if (item.err) return { status: 'failed', provenFailure: true };
    if (!['confirmed', 'finalized'].includes(item.confirmationStatus)) return { status: 'submitted' };
    if (!intent || !payment) throw new Error('The saved payment intent is required to verify its source.');
    const tx = await rpc('getTransaction', [record.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }], record.runtime || 'base');
    if (!verifyMagicblockSource(tx, intent, payment, record)) throw new Error('The source transaction does not yet prove this exact saved payment. Do not resend it.');
    return { status: 'source-confirmed' };
  }
  async function settlement(intent, payment, record, signature) {
    const management = ['deposit', 'withdraw'].includes(intent.kind);
    const destination = magicblockATA(payment.recipient);
    const shuttle = deriveShuttleEphemeralAta(new PublicKey(owner), mint, record.nonce)[0];
    const shuttleWallet = deriveShuttleWalletAta(mint, shuttle);
    const runtime = intent.kind === 'deposit' ? 'ephemeral' : 'base';
    const lookup = management ? shuttleWallet.toBase58() : destination;
    // The private ER indexes native account-update receipts, not ordinary SPL
    // transfer history, for a deposit's automatic merge.
    const candidates = signature ? [{ signature }] : await rpc('getSignaturesForAddress', [intent.kind === 'deposit' ? shuttle.toBase58() : lookup, { limit: 30, commitment: 'confirmed' }], runtime);
    if (intent.kind === 'deposit') {
      const closed = await rpc('getAccountInfo', [shuttle.toBase58(), { encoding: 'base64', commitment: 'confirmed' }], 'ephemeral');
      const current = await balance('ephemeral');
      const creditObserved = record.proofMethod === 'tee-private-state-and-closed-shuttle' || BigInt(current.units) >= BigInt(record.recipientUnits);
      if (closed && Object.hasOwn(closed, 'value') && closed.value === null && creditObserved) {
        const authority = await validator();
        for (const candidate of candidates || []) {
          const tx = await rpc('getTransaction', [candidate.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }], 'ephemeral');
          const key = tx?.transaction?.message?.accountKeys?.[0];
          const signer = typeof key === 'string' ? key : key?.pubkey;
          const receipt = tx?.transaction?.message?.instructions?.some(ix => ix.programId === 'Magic11111111111111111111111111111111111111'
            && ix.data && bs58.decode(ix.data)[0] === 16 && ix.accounts?.[0] === authority && ix.accounts?.[1] === shuttle.toBase58());
          if (!tx?.meta || tx.meta.err || signer !== authority || !receipt) continue;
          return { status: 'confirmed', settlementSignature: candidate.signature, settlementRuntime: 'ephemeral',
            proofMethod: 'tee-private-state-and-closed-shuttle', note: null };
        }
      }
      return { status: 'source-confirmed', note: 'Deposit source confirmed; private credit and the exact closed-shuttle receipt are not yet verified. Check, never resend.' };
    }
    for (const candidate of candidates || []) {
      if (candidate.err) continue;
      const tx = await rpc('getTransaction', [candidate.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }], runtime);
      if (!tx?.meta || tx.meta.err) continue;
      if (!management) {
        const marker = `Program log: client_ref_id: ${record.clientRefId}`;
        const stack = [];
        let matched = false;
        for (const line of tx.meta.logMessages || []) {
          const start = /^Program (\w+) invoke \[\d+\]$/.exec(line);
          if (start) stack.push(start[1]);
          if (line === marker && stack.at(-1) === ESPL) matched = true;
          if (/^Program \w+ (success|failed:)/.test(line)) stack.pop();
        }
        if (!matched) continue;
      } else {
        const instructions = [...(tx.transaction?.message?.instructions || []), ...(tx.meta.innerInstructions || []).flatMap(r => r.instructions || [])];
        const matched = instructions.some(ix => {
          if (ix.programId !== ESPL || !ix.data || !Array.isArray(ix.accounts)) return false;
          const code = bs58.decode(ix.data)[0];
          const withdrawCallback = code === 201 && ix.accounts[1] === shuttle.toBase58()
            && ix.accounts[3] === shuttleWallet.toBase58() && ix.accounts[5] === MAGICBLOCK_USDC
            && ix.accounts[10] === owner && ix.accounts[4] === destination;
          return (intent.kind === 'deposit' ? code === 14 : code === 15 || code === 32 || withdrawCallback)
            && ix.accounts.includes(shuttle.toBase58()) && ix.accounts.includes(shuttleWallet.toBase58())
            && ix.accounts.includes(destination);
        });
        if (!matched) continue;
      }
      const keys = tx.transaction?.message?.accountKeys?.map(k => typeof k === 'string' ? k : k.pubkey) || [];
      const index = keys.indexOf(destination);
      if (index < 0) continue;
      const find = rows => rows?.find(r => r.accountIndex === index && r.mint === MAGICBLOCK_USDC && r.owner === payment.recipient);
      const pre = find(tx.meta.preTokenBalances), post = find(tx.meta.postTokenBalances);
      if (!post || BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount || '0') !== BigInt(record.recipientUnits)) continue;
      // A unique encrypted client reference, successful execution and exact USDC
      // credit must all agree. Unrelated balance increases are not receipts.
      return { status: 'confirmed', settlementSignature: candidate.signature, settlementRuntime: runtime, note: null };
    }
    return { status: 'source-confirmed', note: 'Funding confirmed; recipient settlement is still unverified. Check again. Never resend this row.' };
  }
  return { login, balance, quote, signAndSend, status, settlement,
    clear() { bearer = null; expires = 0; identity = null; }, rpc };
}
