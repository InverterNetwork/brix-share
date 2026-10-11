/**
 * Proof-of-work rules shared by the browser solver and the API verifier (PLAN sections 7 and 12).
 * Challenge: `v1.<expSec>.<difficulty>.<nonce: 16 bytes b64url>.<HMAC-SHA256: 32 bytes b64url>`, issued by the API.
 * Solution: decimal nonce such that SHA-256(UTF-8(`<challenge>:<nonce>`)) starts with `difficulty` zero bits.
 */

export const POW_CHALLENGE_RE =
  /^v1\.[0-9]{1,12}\.[0-9]{1,2}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

export function powHashInput(challenge: string, nonce: string): string {
  return `${challenge}:${nonce}`;
}

export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export function meetsDifficulty(digest: Uint8Array, difficulty: number): boolean {
  return leadingZeroBits(digest) >= difficulty;
}
