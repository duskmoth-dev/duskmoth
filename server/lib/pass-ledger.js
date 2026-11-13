import fs from 'node:fs';
import path from 'node:path';

// A single-writer, fsynced ledger. Multi-instance production needs a shared,
// transactional replacement; do not assert durability for an ephemeral disk.
export class PassLedger {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    this.directory = directory;
    this.lock = path.join(directory, 'pass-ledger.lock');
    try {
      const fd = fs.openSync(this.lock, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid)); fs.fsyncSync(fd); fs.closeSync(fd);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(this.lock, 'utf8'));
      let running = true;
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') running = false; }
      if (running || !Number.isSafeInteger(pid) || pid < 1) throw new Error('Pass ledger already has a writer.');
      fs.unlinkSync(this.lock);
      const fd = fs.openSync(this.lock, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid)); fs.fsyncSync(fd); fs.closeSync(fd);
    }
    this.burns = new Map(); this.spent = new Map();
    try {
      for (const [file, target, key] of [['pass-burns', this.burns, 'burn'], ['pass-spent', this.spent, 'hash']]) {
        const filename = path.join(directory, file);
        if (!fs.existsSync(filename)) continue;
        if (fs.statSync(filename).size > 64 * 1024 * 1024) throw new Error('Pass ledger requires maintenance.');
        const text = fs.readFileSync(filename, 'utf8');
        if (text && !text.endsWith('\n')) throw new Error('Incomplete pass ledger; refusing to forget records.');
        for (const line of text.split('\n').filter(Boolean)) {
          const row = JSON.parse(line);
          if (typeof row[key] !== 'string' || target.has(row[key])) throw new Error('Invalid pass ledger.');
          if (key === 'hash' && (!/^[a-f0-9]{64}$/.test(row.hash) || !/^[a-f0-9]{64}$/.test(row.grant))) throw new Error('Invalid spent-pass record.');
          if (key === 'burn' && (!/^[a-f0-9]{64}$/.test(row.batch) || !Number.isSafeInteger(row.count) || row.count < 1)) throw new Error('Invalid burn record.');
          target.set(row[key], row);
        }
      }
    } catch (error) { this.close(); throw error; }
  }
  append(file, row, target, key) {
    if (this.poisoned || this.closed) throw new Error('Pass storage unavailable.');
    let fd;
    try {
      fd = fs.openSync(path.join(this.directory, file), 'a', 0o600);
      fs.writeFileSync(fd, JSON.stringify(row) + '\n'); fs.fsyncSync(fd);
      // Persist a newly created directory entry, not just its contents.
      const dir = fs.openSync(this.directory, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      target.set(row[key], row);
    } catch (error) {
      // A failed fsync is ambiguous. Stop until an operator reloads the ledger.
      this.poisoned = true; throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  burn(row) {
    if (this.burns.has(row.burn)) return false;
    this.append('pass-burns', row, this.burns, 'burn'); return true;
  }
  getBurn(burn) { return this.burns.get(burn); }
  getSpend(hash) { return this.spent.get(hash); }
  spend(row) {
    if (this.spent.has(row.hash)) return false;
    this.append('pass-spent', row, this.spent, 'hash'); return true;
  }
  close() {
    if (!this.closed) { this.closed = true; try { fs.unlinkSync(this.lock); } catch {} }
  }
}
