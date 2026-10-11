import { createHash, randomBytes } from 'node:crypto';
import { leadingZeroBits, powHashInput } from '@brix-share/shared';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/pow/sha256.ts';
import { solvePow } from '../src/pow/solver.ts';

describe('pure-JS SHA-256', () => {
  it('matches node:crypto on lengths around block boundaries and random inputs', () => {
    for (let len = 0; len <= 200; len++) {
      const data = randomBytes(len);
      expect(Buffer.from(sha256(data)).toString('hex'), String(len)).toBe(
        createHash('sha256').update(data).digest('hex'),
      );
    }
    expect(Buffer.from(sha256(new TextEncoder().encode('abc'))).toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('solver', () => {
  it('finds the first nonce the server would accept (shared fixed vector)', () => {
    const challenge = `v1.1800000600.18.${'A'.repeat(22)}.${'B'.repeat(43)}`;
    expect(solvePow(challenge, 10)).toBe('898');
  });

  it('solutions meet the difficulty under node:crypto', () => {
    const challenge = `v1.1800000600.12.${'C'.repeat(22)}.${'D'.repeat(43)}`;
    const nonce = solvePow(challenge, 12);
    expect(
      leadingZeroBits(createHash('sha256').update(powHashInput(challenge, nonce)).digest()),
    ).toBeGreaterThanOrEqual(12);
  });
});
