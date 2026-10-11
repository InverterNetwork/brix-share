// Deep import keeps zod and the rest of shared out of the worker bundle.
import { meetsDifficulty, powHashInput } from '@brix-share/shared/pow';
import { sha256 } from './sha256.ts';

const enc = new TextEncoder();
export const PROGRESS_EVERY = 1 << 15;

/**
 * Finds the smallest decimal nonce (from 0) meeting the difficulty under the shared PoW rules.
 * Synchronous; runs in a worker. `onProgress` gets the number of tries so far.
 */
export function solvePow(
  challenge: string,
  difficulty: number,
  onProgress?: (tries: number) => void,
): string {
  for (let n = 0; n < Number.MAX_SAFE_INTEGER; n++) {
    const nonce = String(n);
    if (meetsDifficulty(sha256(enc.encode(powHashInput(challenge, nonce))), difficulty))
      return nonce;
    if (onProgress && n > 0 && n % PROGRESS_EVERY === 0) onProgress(n);
  }
  throw new Error('no nonce found');
}
