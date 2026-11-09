import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StateStore } from './state.mjs';

/** Only the controller lease may be reclaimed after its owner is proved dead.
 * Task/workspace leases are never touched here. An exclusive recovery guard
 * serializes every contender, and inode checks prevent deleting a replacement. */
export class SuperStore extends StateStore {
  async lock() {
    await mkdir(dirname(this.path), { recursive: true });
    const guardPath = `${this.lockPath}.recovery`;
    const guard = await open(guardPath, 'wx', 0o600);
    try {
      let handle;
      try { handle = await open(this.lockPath, 'r'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (handle) {
        try {
          const owner = JSON.parse(await handle.readFile('utf8'));
          if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid controller lease; preserve it for inspection.');
          let dead = false;
          try { process.kill(owner.pid, 0); }
          catch (error) { if (error.code === 'ESRCH') dead = true; else throw error; }
          if (!dead) throw new Error('Controller lease owner is still alive; no automatic takeover.');
          const mine = await handle.stat({ bigint: true }), current = await lstat(this.lockPath, { bigint: true });
          if (mine.ino !== current.ino || mine.dev !== current.dev) throw new Error('Controller lease changed; refusing recovery.');
          await unlink(this.lockPath);
        } finally { await handle.close(); }
      }
      await super.lock();
    } finally { await guard.close(); await unlink(guardPath); }
  }
}
