import { readFile, writeFile, rename, mkdir, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/** One bridge owns a cursor. Atomic file replacement keeps result recovery deterministic. */
export class StateStore {
  constructor(path) { this.path = path; this.lockPath = `${path}.lock`; }
  async lock() {
    await mkdir(dirname(this.path), { recursive: true });
    let handle;
    try { handle = await open(this.lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid = 'unknown';
      try {
        const owner = JSON.parse(await readFile(this.lockPath, 'utf8'));
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) pid = String(owner.pid);
      } catch { /* A concurrent owner may not have written its PID yet. Always fail closed. */ }
      throw new Error(`Another bridge may own this state (lock pid ${pid}). Existing locks are never removed automatically. Confirm all related processes have exited, then manually remove ${this.lockPath}; preserve the state file.`);
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.sync();
      this.lockHandle = handle;
    } catch (error) {
      await handle.close().catch(() => {});
      // Retain a partial lock on failure: operator inspection is safer than automatic takeover.
      throw error;
    }
  }
  async unlock() {
    if (!this.lockHandle) return;
    await this.lockHandle.close(); this.lockHandle = undefined;
    await unlink(this.lockPath);
  }
  async read(identity) {
    let value;
    try { value = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      value = { version: 1, identity, cursor: 0, sessions: {}, current: null };
    }
    if (value.version !== 1 || value.identity !== identity || !Number.isSafeInteger(value.cursor) || value.cursor < 0)
      throw new Error('Bridge state belongs to another server/bot or is invalid. Use a separate statePath.');
    return value;
  }
  async write(value) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flush: true });
    await rename(temporary, this.path);
  }
}
