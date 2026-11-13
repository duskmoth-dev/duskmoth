// Live private transfers through the official Privacy Cash SDK (privacycash/utils), signed by the user's
// browser wallet. Proofs are generated in the browser; the withdrawal is submitted by the Privacy Cash relayer.
// Built with Vite into public/assets/js/live/privacy-cash.js and loaded only when ENABLE_LIVE_SEND=true.
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { WasmFactory } from '@lightprotocol/hasher.rs';
import { deposit, withdraw, depositSPL, withdrawSPL, EncryptionService, getUtxos, getBalanceFromUtxos, getUtxosSPL, getBalanceFromUtxosSPL, setLogger } from 'privacycash/utils';
import { report, scanStorage, sdkLog, withProgress, operationSignal, checkReadSignal, abortableRead } from './runtime.js';

// The SDK's default debug logger prints UTXO and encryption details. Never expose those in browser logs.
setLogger(sdkLog);

// Must match the message Privacy Cash uses, so the same private balance is reachable from their app too.
const SIGN_MESSAGE = 'Privacy Money account sign in';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const KEY_BASE = `${location.origin}/circuit2/transaction2`;

export async function createLive({ rpcUrl, wallet }) {
  if (!wallet || wallet.demo) throw new Error('Live transfers need a real wallet.');
  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([AbortSignal.timeout(20000), options?.signal, operationSignal()].filter(Boolean)) }),
  });
  const publicKey = new PublicKey(wallet.address);
  const lightWasm = await WasmFactory.getInstance();
  let encryptionService = null;
  function assertWallet() {
    if (wallet.provider?.publicKey?.toString() !== publicKey.toString()) throw new Error('Wallet account changed. Reconnect before signing.');
  }

  async function keys() {
    assertWallet();
    if (encryptionService) return encryptionService;
    report('unlock', 'Approve the “Privacy Money account sign in” message in your wallet. This message does not move funds.');
    let timer;
    const sig = await abortableRead(Promise.race([
      wallet.signMessage(SIGN_MESSAGE),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Wallet message approval timed out. Close the pending wallet request before trying again. No deposit was signed.')), 90000); }),
    ])).finally(() => clearTimeout(timer));
    checkReadSignal();
    assertWallet();
    encryptionService = new EncryptionService();
    encryptionService.deriveEncryptionKeyFromSignature(sig);
    return encryptionService;
  }

  const base = async () => ({ connection, publicKey, lightWasm, storage: scanStorage(window.localStorage), keyBasePath: KEY_BASE, encryptionService: await keys() });
  function sdkError(error, operation, knownSignature) {
    const signature = error.signature || knownSignature;
    if (signature) {
      error.submittedSignature = signature;
      error.operation = operation;
    }
    return error;
  }
  async function confirmedSignature(result, operation) {
    const signature = result?.tx;
    try {
      if (typeof signature !== 'string' || bs58.decode(signature).length !== 64) throw new Error();
    } catch { throw new Error('The service did not return a valid transaction signature. No success can be confirmed.'); }
    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        const response = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
        const status = response.value[0];
        if (status?.err) throw new Error('The transaction failed on-chain. Inspect its transaction details.');
        if (['confirmed', 'finalized'].includes(status?.confirmationStatus)) return signature;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      throw new Error('The transaction was submitted but confirmation is still pending. Do not retry until you check its status.');
    } catch (error) {
      error.submittedSignature = signature; error.operation = operation; throw error;
    }
  }

  return {
    async shield({ token, amount, onStep = () => {}, onProgress }) {
      return withProgress(onProgress, async () => {
      const common = await base();
      onStep(0);
      report('scan', 'Reading your existing private balance before preparing the deposit. First-time scans may take several minutes.');
      let signedSignature;
      const transactionSigner = async (tx) => {
        assertWallet();
        report('preflight', 'Checking the prepared deposit against Solana before requesting your transaction signature.');
        const simulation = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
        if (simulation.value.err) throw new Error('The deposit could not pass the network preflight. Nothing was signed or submitted. Check your balance and try again.');
        report('sign', 'The deposit is ready. Open your wallet and approve or reject the transaction.');
        const signed = await wallet.signTransaction(tx);
        assertWallet();
        signedSignature = bs58.encode(signed.signatures[0]);
        onStep(1);
        return signed;
      };
      let res;
      try { res = token === 'SOL'
        ? await deposit({ ...common, amount_in_lamports: Math.round(amount * 1e9), transactionSigner })
        : await depositSPL({ ...common, mintAddress: USDC_MINT, base_units: Math.round(amount * 1e6), transactionSigner }); }
      catch (error) { throw sdkError(error, 'deposit', signedSignature); }
      const signature = await confirmedSignature(res, 'deposit');
      onStep(2);
      return signature;
      });
    },
    async withdraw({ token, amount, recipient, onStep = () => {}, onProgress }) {
      return withProgress(onProgress, async () => {
      const common = await base();
      report('scan', 'Reading your private balance and preparing the withdrawal proof.');
      const to = new PublicKey(recipient);
      let res;
      try { res = token === 'SOL'
        ? await withdraw({ ...common, recipient: to, amount_in_lamports: Math.round(amount * 1e9) })
        : await withdrawSPL({ ...common, recipient: to, mintAddress: USDC_MINT, base_units: Math.round(amount * 1e6) }); }
      catch (error) { throw sdkError(error, 'withdrawal'); }
      onStep(3);
      const signature = await confirmedSignature(res, 'withdrawal');
      if (res.isPartial) {
        const error = new Error('Only part of the amount was withdrawn. Check the transaction and remaining private balance before trying again.');
        error.submittedSignature = signature; error.operation = 'withdrawal'; throw error;
      }
      onStep(4);
      return signature;
      });
    },
    async balance(token, onProgress, { signal } = {}) {
      return withProgress(onProgress, async () => {
      const common = await base();
      report('scan', 'Reading private pool history. First-time scans can take several minutes. No new payment or pass is submitted during this scan.');
      const balances = {};
      if (!token || token === 'SOL') {
        const sol = getBalanceFromUtxos(await getUtxos({ ...common, abortSignal: signal }));
        if (!Number.isFinite(sol?.lamports)) throw new Error('Private SOL balance could not be verified.');
        balances.SOL = sol.lamports / 1e9;
      }
      if (!token || token === 'USDC') {
        const usdc = getBalanceFromUtxosSPL(await getUtxosSPL({ ...common, mintAddress: USDC_MINT, abortSignal: signal })).amount;
        if (!Number.isFinite(usdc)) throw new Error('Private USDC balance could not be verified.');
        balances.USDC = usdc;
      }
      checkReadSignal();
      return balances;
      }, signal);
    },
  };
}
