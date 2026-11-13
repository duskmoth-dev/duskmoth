import pg from 'pg';
import { createHmac, createHash } from 'node:crypto';
import { MagicBlockError } from './magicblock.js';

export const magicblockBinding = intent => createHash('sha256').update(JSON.stringify(intent)).digest('hex');
// Only keyed identities, operation bindings, amounts and pass state. No recipient
// list, private balance, bearer token, private key or raw transaction is stored.
export class MagicblockLedger {
  constructor({ connectionString = process.env.DATABASE_URL, secret = process.env.SESSION_SECRET, pool } = {}) {
    this.secret = secret;
    this.pool = pool || (connectionString && new pg.Pool({ connectionString, max: 3, connectionTimeoutMillis: 5000, query_timeout: 10000 }));
    this.pool?.on('error', () => {});
    this.ready = null;
  }
  async health() {
    if (!this.pool || !this.secret || this.secret.length < 32) throw new MagicBlockError(503, 'STORAGE_UNAVAILABLE', 'Durable MagicBlock limits are unavailable. Nothing was sent.');
    if (!this.ready) this.ready = this.pool.query(`CREATE TABLE IF NOT EXISTS duskmoth_magicblock_operations (
      owner_key text NOT NULL, operation_id text NOT NULL, binding text NOT NULL,
      amount bigint NOT NULL CHECK(amount > 0), reserved_at timestamptz NOT NULL DEFAULT now(),
      pass_key text, authorization_grant text, PRIMARY KEY(owner_key, operation_id))`).catch(e => { this.ready = null; throw e; });
    await this.ready;
    await this.pool.query('SELECT 1');
    return true;
  }
  ownerKey(owner) { return createHmac('sha256', this.secret).update(`magicblock:${owner}`).digest('hex'); }
  async reserve(intent, maxDaily) {
    await this.health();
    const owner = this.ownerKey(intent.owner), binding = magicblockBinding(intent);
    const amount = intent.payments.reduce((n, p) => n + BigInt(Math.round(p.amount * 1e6)), 0n);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [owner]);
      const { rows: [previous] } = await c.query("SELECT binding, (reserved_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS today FROM duskmoth_magicblock_operations WHERE owner_key=$1 AND operation_id=$2", [owner, intent.id]);
      if (previous) {
        if (previous.binding !== binding) throw new MagicBlockError(409, 'OPERATION_CHANGED', 'This operation ID belongs to a different plan.');
        if (previous.today) {
          await c.query('COMMIT');
          return { reserved: true, recovered: true };
        }
      }
      const { rows: [usage] } = await c.query("SELECT coalesce(sum(amount),0)::text AS used FROM duskmoth_magicblock_operations WHERE owner_key=$1 AND reserved_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'", [owner]);
      if (BigInt(usage.used) + amount > BigInt(Math.round(maxDaily * 1e6))) throw new MagicBlockError(409, 'DAILY_LIMIT', 'This wallet has reached its UTC-day MagicBlock reservation limit. Nothing was sent.');
      if (previous) await c.query('UPDATE duskmoth_magicblock_operations SET reserved_at=now() WHERE owner_key=$1 AND operation_id=$2', [owner, intent.id]);
      else await c.query('INSERT INTO duskmoth_magicblock_operations(owner_key,operation_id,binding,amount) VALUES($1,$2,$3,$4)', [owner, intent.id, binding, amount.toString()]);
      await c.query('COMMIT');
      return { reserved: true, recovered: false };
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }
  async operation(intent) {
    await this.health();
    const { rows: [row] } = await this.pool.query('SELECT binding,pass_key,authorization_grant AS "grant" FROM duskmoth_magicblock_operations WHERE owner_key=$1 AND operation_id=$2', [this.ownerKey(intent.owner), intent.id]);
    if (!row || row.binding !== magicblockBinding(intent)) throw new MagicBlockError(409, 'RESERVATION_REQUIRED', 'Reserve this exact plan before execution.');
    return row;
  }
  async claimPass(intent, passKey) {
    await this.operation(intent);
    const { rows: [row] } = await this.pool.query(`UPDATE duskmoth_magicblock_operations SET pass_key=coalesce(pass_key,$3)
      WHERE owner_key=$1 AND operation_id=$2 AND (pass_key IS NULL OR pass_key=$3)
      RETURNING pass_key,authorization_grant AS "grant"`, [this.ownerKey(intent.owner), intent.id, passKey]);
    if (!row) throw new MagicBlockError(409, 'ORIGINAL_PASS_REQUIRED', 'Recover this batch with its original pass. A second pass will not be charged.');
    return row;
  }
  async saveGrant(intent, grant) {
    await this.pool.query('UPDATE duskmoth_magicblock_operations SET authorization_grant=coalesce(authorization_grant,$3) WHERE owner_key=$1 AND operation_id=$2', [this.ownerKey(intent.owner), intent.id, grant]);
  }
  async close() { await this.pool?.end(); }
}
