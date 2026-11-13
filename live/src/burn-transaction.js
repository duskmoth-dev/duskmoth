import { Message, Transaction } from '@solana/web3.js';

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
// Phantom's documented Lighthouse augmentation. Address and discriminators:
// https://github.com/Jac0xb/lighthouse/blob/main/programs/lighthouse/src/instruction.rs
const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const fail = (reason = 'The wallet changed the burn amount, mint, authority, or accounts.') => {
  throw new Error(`${reason} Nothing was broadcast.`);
};

export function validateAssertion(instruction, approvedAccounts) {
  const kind = instruction.data[0];
  // Only read/assert operations: never MemoryWrite (0), MemoryClose (1), or
  // the external-program Merkle-tree operation (16). Extra read-only accounts
  // are safe; global writable/signer privileges may only come from our burn.
  const supported = (kind >= 2 && kind <= 15) || kind === 17;
  const accountCount = kind === 15 ? 0 : kind === 4 ? 2 : 1;
  if (!supported || instruction.data.length < 3 || instruction.keys.length !== accountCount
    || instruction.keys.some(key => {
      const approved = approvedAccounts.get(key.pubkey.toBase58());
      return (key.isWritable && !approved?.isWritable) || (key.isSigner && !approved?.isSigner);
    })) fail('The wallet added an unsupported Lighthouse operation.');
}

// Compare immutable, compiled intent, not the mutable Transaction passed to the
// extension. Wallets may add bounded compute fees, read-only Lighthouse safety
// assertions, or refresh a recent blockhash.
export function validateSignedBurn(signed, approvedMessage) {
  const expected = Transaction.populate(Message.from(approvedMessage));
  const actual = Transaction.from(signed.serialize());
  if (!actual.feePayer?.equals(expected.feePayer)) fail('The wallet changed the transaction fee payer.');
  if (actual.signatures.length !== 1 || !actual.verifySignatures()) fail('The wallet returned unexpected transaction signatures.');
  if (expected.instructions.length !== 1) fail('The original burn instructions are invalid.');
  const wanted = expected.instructions[0];
  const approvedAccounts = new Map(wanted.keys.map(key => [key.pubkey.toBase58(), key]));

  const burns = [];
  let units = null, price = 0n, nonBudgetCount = 0n;
  const seen = new Set();
  for (const instruction of actual.instructions) {
    const program = instruction.programId.toBase58();
    if (program !== COMPUTE_BUDGET) nonBudgetCount++;
    if (program === LIGHTHOUSE) {
      validateAssertion(instruction, approvedAccounts);
      continue;
    }
    if (program !== COMPUTE_BUDGET) {
      if (!instruction.programId.equals(wanted.programId)) {
        fail(`The wallet added an unsupported instruction (${program}).`);
      }
      burns.push(instruction);
      continue;
    }
    const data = instruction.data, kind = data[0];
    if (instruction.keys.length || seen.has(kind)) fail('The wallet added invalid or duplicate compute settings.');
    seen.add(kind);
    if (kind === 2 && data.length === 5) {
      units = BigInt(data.readUInt32LE(1));
      if (units < 1n || units > 1400000n) fail('The wallet added an invalid compute limit.');
    } else if (kind === 3 && data.length === 9) {
      price = data.readBigUInt64LE(1);
    } else fail('The wallet added an unsupported compute setting.');
  }
  // Solana assigns a default budget per non-budget instruction, including
  // wallet-added assertions. Do not underestimate priority fees.
  units ??= nonBudgetCount * 200000n > 1400000n ? 1400000n : nonBudgetCount * 200000n;
  // At most 0.0001 SOL in extra priority fees, with exact integer rounding.
  if ((units * price + 999999n) / 1000000n > 100000n) {
    throw new Error('The wallet added a priority fee above 0.0001 SOL. Nothing was broadcast. Lower the wallet priority fee and retry.');
  }
  if (burns.length !== 1) fail('The wallet removed or duplicated the burn instruction.');
  const burn = burns[0];
  if (!burn.programId.equals(wanted.programId)) fail('The wallet changed the burn program.');
  if (!burn.data.equals(wanted.data)) fail('The wallet changed the burn amount or token decimals.');
  if (burn.keys.length !== wanted.keys.length) fail('The wallet changed the burn account list.');
  for (let index = 0; index < burn.keys.length; index++) {
    const key = burn.keys[index], original = wanted.keys[index];
    if (!key.pubkey.equals(original.pubkey)) {
      fail(`The wallet changed the burn ${['token account', 'mint', 'authority'][index] || 'account'}.`);
    }
    if (key.isSigner !== original.isSigner || key.isWritable !== original.isWritable) {
      fail('The wallet changed required burn account permissions.');
    }
  }
  return actual;
}
