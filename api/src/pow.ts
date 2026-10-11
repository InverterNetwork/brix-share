import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CHALLENGE_TTL_SEC,
  POW_CHALLENGE_RE,
  b64urlDecode,
  b64urlEncode,
  leadingZeroBits,
  powHashInput,
} from '@brix-share/shared';

/**
 * Proof-of-work challenges (PLAN sections 7 and 12).
 * Format: `v1.<expSec>.<difficulty>.<nonce b64url>.<mac b64url>`, MAC = HMAC-SHA256(key, first four fields).
 * A solution is a decimal nonce such that SHA-256(`<challenge>:<nonce>`) starts with `difficulty` zero bits.
 */

export interface IssuedChallenge {
  challenge: string;
  difficulty: number;
  expiresAtSec: number;
}

export type PowCheck =
  { ok: true; expSec: number; replayKey: string } | { ok: false; reason: string };

const mac = (key: Uint8Array, payload: string) =>
  createHmac('sha256', key).update(payload).digest();

export function issueChallenge(
  key: Uint8Array,
  difficulty: number,
  nowSec: number,
): IssuedChallenge {
  const expiresAtSec = nowSec + CHALLENGE_TTL_SEC;
  const payload = `v1.${expiresAtSec}.${difficulty}.${b64urlEncode(randomBytes(16))}`;
  return { challenge: `${payload}.${b64urlEncode(mac(key, payload))}`, difficulty, expiresAtSec };
}

export function verifySolution(
  key: Uint8Array,
  challenge: string,
  nonce: string,
  currentDifficulty: number,
  nowSec: number,
): PowCheck {
  if (!POW_CHALLENGE_RE.test(challenge)) return { ok: false, reason: 'malformed challenge' };
  const parts = challenge.split('.');
  const [, expRaw, diffRaw, , macRaw] = parts as [string, string, string, string, string];
  let given: Uint8Array;
  try {
    given = b64urlDecode(macRaw);
  } catch {
    return { ok: false, reason: 'malformed challenge' };
  }
  // MAC over the raw first four fields as received, never re-serialised numbers.
  const signed = challenge.slice(0, challenge.lastIndexOf('.'));
  const expected = mac(key, signed);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad challenge signature' };
  }
  const expSec = Number(expRaw);
  const difficulty = Number(diffRaw);
  if (expSec <= nowSec) return { ok: false, reason: 'challenge expired' };
  if (expSec > nowSec + CHALLENGE_TTL_SEC)
    return { ok: false, reason: 'challenge from the future' };
  if (difficulty < currentDifficulty) return { ok: false, reason: 'difficulty too low' };
  const digest = createHash('sha256').update(powHashInput(challenge, nonce)).digest();
  if (leadingZeroBits(digest) < difficulty) return { ok: false, reason: 'insufficient work' };
  return { ok: true, expSec, replayKey: createHash('sha256').update(challenge).digest('hex') };
}

/** Brute-force solver for tests and tooling. The browser uses its own worker implementation. */
export function solve(challenge: string, difficulty: number): string {
  for (let n = 0; ; n++) {
    const digest = createHash('sha256')
      .update(powHashInput(challenge, String(n)))
      .digest();
    if (leadingZeroBits(digest) >= difficulty) return String(n);
  }
}
