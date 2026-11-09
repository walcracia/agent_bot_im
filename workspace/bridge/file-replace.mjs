import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Atomic replacement with bounded Windows sharing retries; caller owns both paths. */
export async function replaceOwnedFile(source, target, validateOwner = async () => {}) {
  const backoff = [25, 50, 100, 200, 400, 800];
  for (let attempt = 0; ; attempt++) {
    await validateOwner();
    try { await rename(source, target); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= backoff.length) throw error;
      await delay(backoff[attempt]);
    }
  }
}
