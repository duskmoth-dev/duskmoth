import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { validateSignedBurn } from './burn-transaction.js';

const suite = RSABSSA.SHA384.PSS.Randomized();
const PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
export const encode = bytes => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
export const decode = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
export const importPublicKey = spki => crypto.subtle.importKey('spki', decode(spki), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
export async function blindPasses(pk, n) {
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('Choose 1–50 passes.');
  const items = [];
  for (let i = 0; i < n; i++) {
    const prepared = suite.prepare(crypto.getRandomValues(new Uint8Array(32)));
    const { blindedMsg, inv } = await suite.blind(pk, prepared);
    items.push({ prepared: encode(prepared), inv: encode(inv), blinded: encode(blindedMsg) });
  }
  return { items, blinded: items.map(item => item.blinded) };
}
export async function verifyPass(pk, pass) {
  try { return await suite.verify(pk, decode(pass.sig), decode(pass.msg)); } catch { return false; }
}
export async function finalizePasses(pk, items, signatures, kid, demo) {
  if (!Array.isArray(signatures) || !signatures.length || signatures.length > items.length) throw new Error('The issuer returned an invalid number of signatures. Keep your saved purchase.');
  const result = [];
  for (let i = 0; i < signatures.length; i++) {
    const prepared = decode(items[i].prepared);
    const sig = await suite.finalize(pk, prepared, decode(signatures[i]), decode(items[i].inv));
    if (!await suite.verify(pk, sig, prepared)) throw new Error('A pass signature failed verification. Keep your saved purchase.');
    result.push({ kid, msg: encode(prepared), sig: encode(sig), demo, at: Date.now() });
  }
  return result;
}
function connection(rpcUrl) { return new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true }); }
function currentOwner(wallet) {
  if (!wallet || wallet.demo || wallet.provider?.publicKey?.toString() !== wallet.address || wallet.provider.isConnected === false) throw new Error('The wallet changed or disconnected. Reconnect the burn wallet before continuing.');
  return new PublicKey(wallet.address);
}
export async function tokenBalance({ rpcUrl, owner, mint }) {
  const result = await connection(rpcUrl).getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
  const accounts = result.value.map(({ pubkey, account }) => {
    const info = account.data?.parsed?.info, amount = info?.tokenAmount;
    if (!PROGRAMS.has(account.owner.toString()) || info?.mint !== mint || info?.owner !== owner || !/^\d+$/.test(amount?.amount) || !Number.isInteger(amount.decimals) || amount.decimals < 0 || amount.decimals > 18) throw new Error('The RPC returned an unsupported token account.');
    return { address: pubkey.toString(), programId: account.owner.toString(), amount: amount.amount, decimals: amount.decimals };
  });
  const decimals = accounts[0]?.decimals ?? null;
  if (accounts.some(account => account.decimals !== decimals)) throw new Error('Token decimals are inconsistent.');
  const total = accounts.reduce((sum, account) => sum + BigInt(account.amount), 0n);
  return { accounts, rawTotal: total.toString(), decimals, total: decimals === null ? 0 : Number(total) / 10 ** decimals };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function confirmBurn({ rpcUrl, signature, blockhash, lastValidBlockHeight, onStep = () => {} }) {
  const rpc = connection(rpcUrl), deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const result = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = result.value[0];
    if (status?.err) { const error = new Error('The burn transaction failed. No tokens were burned; a network fee may still apply.'); error.burnFailed = true; throw error; }
    if (['confirmed', 'finalized'].includes(status?.confirmationStatus)) return signature;
    if (lastValidBlockHeight && await rpc.getBlockHeight('confirmed') > lastValidBlockHeight) throw new Error('The burn blockhash expired. Check the saved transaction on Solscan before starting another purchase.');
    onStep({ step: 2, detail: 'Waiting for the burn transaction to confirm on Solana.' });
    await sleep(1500);
  }
  throw new Error('Burn confirmation is still unknown. Keep this saved purchase and check its transaction before retrying.');
}
export async function burnDmoth({ rpcUrl, wallet, mint, amountUi, onStep = () => {}, onSigned = () => {} }) {
  const owner = currentOwner(wallet), rpc = connection(rpcUrl);
  const { accounts } = await tokenBalance({ rpcUrl, owner: owner.toString(), mint });
  const account = [...accounts].sort((a, b) => BigInt(a.amount) > BigInt(b.amount) ? -1 : 1)[0];
  if (!account) throw new Error('Not enough $DMOTH in one account.');
  // Prices are whole tokens; exact integer arithmetic avoids a rounded burn.
  if (!Number.isSafeInteger(amountUi) || amountUi < 1) throw new Error('Invalid burn amount.');
  const raw = BigInt(amountUi) * 10n ** BigInt(account.decimals);
  if (raw > BigInt(account.amount)) throw new Error('Not enough $DMOTH in one account.');
  if (raw > 18446744073709551615n) throw new Error('The burn amount exceeds the token instruction limit.');
  const data = new Uint8Array(10); data[0] = 15;
  new DataView(data.buffer).setBigUint64(1, raw, true); data[9] = account.decimals;
  const latest = await rpc.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: owner, ...latest }).add(new TransactionInstruction({
    programId: new PublicKey(account.programId),
    keys: [{ pubkey: new PublicKey(account.address), isSigner: false, isWritable: true }, { pubkey: new PublicKey(mint), isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }],
    data,
  }));
  currentOwner(wallet);
  onStep({ step: 1, detail: 'Approve the permanent $DMOTH burn in your wallet.' });
  const approvedMessage = Uint8Array.from(tx.serializeMessage());
  const signed = validateSignedBurn(await wallet.signTransaction(tx), approvedMessage);
  currentOwner(wallet);
  const rawTx = signed.serialize();
  const { b58encode } = await import('../../public/assets/js/wallet.js');
  const signature = b58encode(signed.signature);
  // Persist the signed transaction ID before broadcasting, including on timeout.
  const validity = {
    blockhash: signed.recentBlockhash,
    lastValidBlockHeight: signed.recentBlockhash === latest.blockhash ? latest.lastValidBlockHeight : undefined,
  };
  onSigned({ signature, ...validity });
  onStep({ step: 2, detail: 'Submitting the approved burn and waiting for Solana confirmation.' });
  const submitted = await rpc.sendRawTransaction(rawTx, { skipPreflight: false, maxRetries: 2 });
  if (submitted !== signature) throw new Error('The RPC returned an unexpected burn signature. Check the saved transaction.');
  await confirmBurn({ rpcUrl, signature, ...validity, onStep });
  return signature;
}
