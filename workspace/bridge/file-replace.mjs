import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_BACKOFF = [25, 50, 100, 200, 400, 800];

/** Atomic replacement with bounded Windows sharing retries; caller owns both paths.
 * Long-lived metadata readers can opt into a longer, still finite sharing budget.
 * The caller's ownership predicate is checked again before every retry. */
export async function replaceOwnedFile(source, target, validateOwner = async () => {}, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid atomic replacement options.');
  const configured = options.backoffMilliseconds ?? DEFAULT_BACKOFF;
  if (!Array.isArray(configured)) throw new Error('Atomic replacement backoff must be a bounded array.');
  const backoff = [...configured];
  if (backoff.length > 20 || backoff.some(value => !Number.isSafeInteger(value) || value < 1 || value > 2000)
    || backoff.reduce((total, value) => total + value, 0) > 10000)
    throw new Error('Atomic replacement backoff exceeds its finite sharing budget.');
  for (let attempt = 0; ; attempt++) {
    await validateOwner();
    try { await rename(source, target); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= backoff.length) throw error;
      await delay(backoff[attempt]);
    }
  }
}
