import { describe, expect, it } from 'vitest';
import { leadingZeroBits } from '@brix-share/shared';
import { issueChallenge, solve, verifySolution } from '../src/pow.ts';

const KEY = new Uint8Array(32).fill(9);
const NOW = 1_800_000_000;

describe('proof-of-work', () => {
  it('counts leading zero bits', () => {
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x01]))).toBe(7);
    expect(leadingZeroBits(new Uint8Array([0, 0x0f]))).toBe(12);
    expect(leadingZeroBits(new Uint8Array([0, 0]))).toBe(16);
  });

  it('accepts a valid solution and returns a stable replay key', () => {
    const c = issueChallenge(KEY, 10, NOW);
    expect(c.expiresAtSec).toBe(NOW + 600);
    const nonce = solve(c.challenge, 10);
    const r = verifySolution(KEY, c.challenge, nonce, 10, NOW + 5);
    expect(r).toMatchObject({ ok: true, expSec: NOW + 600 });
    const again = verifySolution(KEY, c.challenge, nonce, 10, NOW + 6);
    expect(again.ok && r.ok && again.replayKey === r.replayKey).toBe(true);
  });

  it('rejects insufficient work', () => {
    const c = issueChallenge(KEY, 12, NOW);
    let bad = 0;
    // find a nonce that does not meet the target
    while (verifySolution(KEY, c.challenge, String(bad), 12, NOW).ok) bad++;
    expect(verifySolution(KEY, c.challenge, String(bad), 12, NOW)).toEqual({
      ok: false,
      reason: 'insufficient work',
    });
  });

  it('rejects expired challenges, at the boundary too', () => {
    const c = issueChallenge(KEY, 4, NOW);
    const nonce = solve(c.challenge, 4);
    expect(verifySolution(KEY, c.challenge, nonce, 4, NOW + 599).ok).toBe(true);
    expect(verifySolution(KEY, c.challenge, nonce, 4, NOW + 600)).toEqual({
      ok: false,
      reason: 'challenge expired',
    });
  });

  it('rejects a challenge issued below the current difficulty', () => {
    const c = issueChallenge(KEY, 8, NOW);
    const nonce = solve(c.challenge, 8);
    expect(verifySolution(KEY, c.challenge, nonce, 10, NOW)).toEqual({
      ok: false,
      reason: 'difficulty too low',
    });
  });

  it('rejects forged or tampered challenges', () => {
    const c = issueChallenge(KEY, 4, NOW);
    const nonce = solve(c.challenge, 4);
    expect(verifySolution(new Uint8Array(32).fill(1), c.challenge, nonce, 4, NOW)).toEqual({
      ok: false,
      reason: 'bad challenge signature',
    });
    const parts = c.challenge.split('.');
    const lowered = [parts[0], String(NOW + 9999), '0', parts[3], parts[4]].join('.');
    expect(verifySolution(KEY, lowered, '0', 0, NOW).ok).toBe(false);
    // A zero-padded expiry parses to the same number but must fail the MAC.
    const padded = [parts[0], `0${parts[1]}`, parts[2], parts[3], parts[4]].join('.');
    expect(verifySolution(KEY, padded, nonce, 4, NOW)).toEqual({
      ok: false,
      reason: 'bad challenge signature',
    });
    for (const g of [
      '',
      'v1',
      'v2.1.1.x.y',
      `${c.challenge}.extra`,
      c.challenge.replace(/.$/, '!'),
    ]) {
      expect(verifySolution(KEY, g, nonce, 4, NOW).ok).toBe(false);
    }
  });
});
