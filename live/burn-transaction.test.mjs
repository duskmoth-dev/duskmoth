import test from 'node:test';
import assert from 'node:assert/strict';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { validateSignedBurn } from './src/burn-transaction.js';

const LIGHTHOUSE = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
function assertion(target) {
  // AssertTokenAccount (9), silent (0), Amount (2), value=0, Equal (0).
  const data = Buffer.alloc(12); data[0] = 9; data[2] = 2;
  return new TransactionInstruction({
    programId: LIGHTHOUSE,
    keys: [{ pubkey: target, isSigner: false, isWritable: false }], data,
  });
}

function fixture() {
  const owner = Keypair.generate(), mint = Keypair.generate().publicKey;
  const data = Buffer.alloc(10); data[0] = 15; data.writeBigUInt64LE(1000000000000n, 1); data[9] = 6;
  const tx = new Transaction({ feePayer: owner.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(new TransactionInstruction({
    programId: new Keypair().publicKey,
    keys: [
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: false },
    ], data,
  }));
  const intent = Uint8Array.from(tx.serializeMessage());
  return { owner, tx, intent };
}

test('accept unchanged signed burn and normalized writable fee payer', () => {
  const { owner, tx, intent } = fixture();
  tx.partialSign(owner);
  assert.equal(validateSignedBurn(tx, intent).verifySignatures(), true);
});

test('accept wallet-added bounded compute fees and refreshed blockhash', () => {
  const { owner, tx, intent } = fixture();
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }));
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.partialSign(owner);
  const result = validateSignedBurn(tx, intent);
  assert.equal(result.instructions.length, 3);
  assert.equal(result.recentBlockhash, tx.recentBlockhash);
});

test('accept Phantom Lighthouse token assertions with globally writable burn accounts', () => {
  const { owner, tx, intent } = fixture();
  tx.add(assertion(tx.instructions[0].keys[0].pubkey));
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }));
  tx.partialSign(owner);
  assert.equal(validateSignedBurn(tx, intent).instructions.length, 4);
});

test('accept read-only assertions on additional accounts without weakening burn validation', () => {
  const { owner, tx, intent } = fixture();
  tx.add(assertion(Keypair.generate().publicKey));
  tx.partialSign(owner);
  assert.equal(validateSignedBurn(tx, intent).instructions.length, 2);
});

for (const operation of ['memory write', 'memory close', 'external CPI', 'unknown', 'extra writable account', 'tampered burn']) {
  test(`reject unsafe Lighthouse augmentation: ${operation}`, () => {
    const { owner, tx, intent } = fixture();
    const check = assertion(tx.instructions[0].keys[0].pubkey);
    if (operation === 'memory write') check.data[0] = 0;
    if (operation === 'memory close') check.data[0] = 1;
    if (operation === 'external CPI') check.data[0] = 16;
    if (operation === 'unknown') check.data[0] = 255;
    if (operation === 'extra writable account') check.keys = [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }];
    if (operation === 'tampered burn') tx.instructions[0].data[1] ^= 1;
    tx.add(check); tx.partialSign(owner);
    assert.throws(() => validateSignedBurn(tx, intent), /Nothing was broadcast/);
  });
}

test('count Lighthouse assertions in the default compute budget when bounding fees', () => {
  const { owner, tx, intent } = fixture();
  tx.add(assertion(tx.instructions[0].keys[0].pubkey));
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300000 }));
  tx.partialSign(owner);
  // Two default 200k-CU instructions cost 120k lamports, not 60k.
  assert.throws(() => validateSignedBurn(tx, intent), /priority fee above/);
});

for (const change of ['amount', 'mint', 'authority', 'token account', 'program', 'decimals', 'transfer', 'second burn', 'fee payer']) {
  test(`reject wallet change: ${change}`, () => {
    const { owner, tx, intent } = fixture();
    const burn = tx.instructions[0];
    let signer = owner;
    if (change === 'amount') burn.data[1] ^= 1;
    if (change === 'decimals') burn.data[9] = 9;
    if (change === 'mint') burn.keys[1].pubkey = Keypair.generate().publicKey;
    if (change === 'token account') burn.keys[0].pubkey = Keypair.generate().publicKey;
    if (change === 'authority') { signer = Keypair.generate(); burn.keys[2].pubkey = signer.publicKey; }
    if (change === 'program') burn.programId = Keypair.generate().publicKey;
    if (change === 'transfer') tx.add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
    if (change === 'second burn') tx.add(burn);
    if (change === 'fee payer') { signer = Keypair.generate(); tx.feePayer = signer.publicKey; }
    tx.partialSign(owner);
    if (signer !== owner) tx.partialSign(signer);
    assert.throws(() => validateSignedBurn(tx, intent), /Nothing was broadcast/);
  });
}

test('reject excessive or duplicate compute fees and unsupported budget instructions', () => {
  for (const instructions of [
    [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000000 })],
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 })],
    [ComputeBudgetProgram.requestHeapFrame({ bytes: 32768 })],
  ]) {
    const { owner, tx, intent } = fixture();
    tx.instructions.unshift(...instructions); tx.partialSign(owner);
    assert.throws(() => validateSignedBurn(tx, intent), /Nothing was broadcast/);
  }
});
