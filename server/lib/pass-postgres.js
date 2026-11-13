import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, createHash, webcrypto } from 'node:crypto';
import pg from 'pg';
import { PassLedger } from './pass-ledger.js';

const AAD = Buffer.from('duskmoth:moth-pass:issuer:v1');
const error = () => new Error('Pass database or issuer-key protection is unavailable.');

// The SESSION_SECRET remains in Secrets, never in this database. Keep it stable
// and backed up: changing it requires an explicit issuer-key re-encryption.
export function protectKey(jwk, secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw error();
  const key = Buffer.from(hkdfSync('sha256', secret, AAD, 'issuer-encryption', 32));
  const iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(JSON.stringify(jwk), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  } finally { key.fill(0); }
}
export function restoreKey(envelope, secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw error();
  const key = Buffer.from(hkdfSync('sha256', secret, AAD, 'issuer-encryption', 32));
  try {
    const value = JSON.parse(envelope);
    if (value.v !== 1) throw error();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    decipher.setAAD(AAD); decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch { throw error(); } finally { key.fill(0); }
}
async function keyId(jwk) {
  const key = await webcrypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, key_ops: ['verify'] }, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
  if (key.algorithm.modulusLength !== 2048 || Buffer.from(key.algorithm.publicExponent).toString('hex') !== '010001') throw error();
  return createHash('sha256').update(Buffer.from(await webcrypto.subtle.exportKey('spki', key))).digest('hex').slice(0, 16);
}
export class PostgresPassLedger {
  constructor({ connectionString, secret }) {
    if (!connectionString || typeof secret !== 'string' || secret.length < 32) throw error();
    this.secret = secret;
    this.pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, query_timeout: 10000 });
    this.pool.on('error', () => { /* Queries fail closed; never log connection strings. */ });
    this.durable = true;
  }
  async issuerKey(loadOriginal) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize first initialization across independent app processes.
      await client.query("SELECT pg_advisory_xact_lock(719331, 92151)");
      const { rows } = await client.query("SELECT kid, encrypted_key FROM moth_pass_issuers WHERE id = 'mainnet'");
      let jwk;
      if (rows.length) {
        jwk = restoreKey(rows[0].encrypted_key, this.secret);
        if (await keyId(jwk) !== rows[0].kid) throw error();
      } else {
        const records = await client.query('SELECT EXISTS(SELECT 1 FROM moth_pass_burns) OR EXISTS(SELECT 1 FROM moth_pass_spent) AS used');
        if (records.rows[0].used) throw error(); // Never replace a lost issuer.
        jwk = await loadOriginal();
        await webcrypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'] }, { name: 'RSA-PSS', hash: 'SHA-384' }, false, ['sign']);
        const kid = await keyId(jwk);
        await client.query("INSERT INTO moth_pass_issuers(id,kid,encrypted_key) VALUES('mainnet',$1,$2)", [kid, protectKey(jwk, this.secret)]);
      }
      this.kid = await keyId(jwk);
      await client.query('COMMIT');
      return jwk;
    } catch {
      await client.query('ROLLBACK').catch(() => {});
      throw error();
    } finally { client.release(); }
  }
  async importLegacy(directory) {
    // Files are never erased. Import atomically and reject conflicting history.
    if (!['pass-burns', 'pass-spent'].some(file => fs.existsSync(path.join(directory, file)) && fs.statSync(path.join(directory, file)).size)) return;
    const legacy = new PassLedger(directory);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(719331, 92151)');
      for (const row of legacy.burns.values()) {
        if (row.kid !== this.kid) throw error();
        await client.query('INSERT INTO moth_pass_burns(burn,batch,count,kid) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [row.burn, row.batch, row.count, row.kid]);
        const { rows: [saved] } = await client.query('SELECT batch,count,kid FROM moth_pass_burns WHERE burn=$1', [row.burn]);
        if (saved.batch !== row.batch || saved.count !== row.count || saved.kid !== row.kid) throw error();
      }
      for (const row of legacy.spent.values()) {
        await client.query('INSERT INTO moth_pass_spent(hash,"grant",request_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [row.hash, row.grant, row.requestId || null]);
        const { rows: [saved] } = await client.query('SELECT "grant",request_id FROM moth_pass_spent WHERE hash=$1', [row.hash]);
        if (saved.grant !== row.grant || saved.request_id !== (row.requestId || null)) throw error();
      }
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK').catch(() => {});
      throw error();
    } finally { client.release(); legacy.close(); }
  }
  async health() {
    const { rows } = await this.pool.query("SELECT kid, (SELECT count(*) FROM moth_pass_burns WHERE false) AS burns, (SELECT count(feature) + count(binding) + count(encrypted_result) + count(result_expires_at) FROM moth_pass_spent WHERE false) AS spent FROM moth_pass_issuers WHERE id='mainnet'");
    if (rows[0]?.kid !== this.kid) throw error();
  }
  async getBurn(burn) {
    const { rows } = await this.pool.query('SELECT burn,batch,count,kid FROM moth_pass_burns WHERE burn=$1', [burn]);
    return rows[0];
  }
  async burn(row) {
    const result = await this.pool.query('INSERT INTO moth_pass_burns(burn,batch,count,kid) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [row.burn, row.batch, row.count, row.kid]);
    return result.rowCount === 1;
  }
  async getSpend(hash) {
    await this.pool.query('UPDATE moth_pass_spent SET encrypted_result=NULL WHERE result_expires_at < now() AND encrypted_result IS NOT NULL');
    const { rows } = await this.pool.query('SELECT hash,"grant",request_id AS "requestId",feature,binding,encrypted_result AS "encryptedResult", result_expires_at AS "resultExpiresAt" FROM moth_pass_spent WHERE hash=$1', [hash]);
    return rows[0] && Object.fromEntries(Object.entries(rows[0]).filter(([key, value]) => !['feature', 'binding', 'encryptedResult', 'resultExpiresAt'].includes(key) || value !== null));
  }
  async spend(row) {
    const result = await this.pool.query('INSERT INTO moth_pass_spent(hash,"grant",request_id,feature,binding,encrypted_result,result_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [row.hash, row.grant, row.requestId || null, row.feature || null, row.binding || null, row.encryptedResult || null, row.resultExpiresAt || null]);
    return result.rowCount === 1;
  }
  async close() { await this.pool.end(); }
}
