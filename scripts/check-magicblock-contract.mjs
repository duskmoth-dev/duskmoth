// Read-only upstream contract check. No wallet, login, builder, pass, or send calls.
import assert from 'node:assert/strict';
const origin = 'https://payments.magicblock.app';
const get = async path => {
  const response = await fetch(`${origin}${path}`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, `GET ${path} failed`);
  return response.json();
};
const doc = await get('/doc');
const paths = ['/health', '/v1/spl/challenge', '/v1/spl/login', '/v1/spl/deposit',
  '/v1/spl/transfer', '/v1/spl/withdraw', '/v1/spl/private-balance', '/v1/transaction/send'];
for (const path of paths) assert.ok(doc.paths[path], `Missing ${path}`);
const transfer = doc.components.schemas.TransferRequest;
for (const key of ['from', 'to', 'mint', 'amount']) assert.ok(transfer.required.includes(key));
for (const key of ['visibility', 'fromBalance', 'toBalance', 'legacy', 'platformFeeBps', 'gasless']) assert.ok(transfer.properties[key]);
for (const key of ['transactionBase64', 'sendTo', 'recentBlockhash', 'lastValidBlockHeight', 'requiredSigners']) {
  assert.ok(doc.components.schemas.UnsignedTransactionResponse.required.includes(key));
}
const challenge = doc.paths['/v1/spl/challenge'].get;
assert.match(challenge.description, /mainnet-private/);
const balance = doc.paths['/v1/spl/private-balance'].get;
assert.ok(balance.parameters.some(param => param.name === 'address' && param.required));
assert.ok(balance.parameters.some(param => param.name === 'authorization' && param.required));
assert.deepEqual(await get('/health'), { status: 'ok' });
console.log(JSON.stringify({ contract: 'MagicBlock hosted OpenAPI', version: doc.info.version,
  checkedAt: new Date().toISOString(), verifiedPaths: paths.length, health: 'ok',
  builderCalled: false, walletUsed: false, transactionSubmitted: false }));
