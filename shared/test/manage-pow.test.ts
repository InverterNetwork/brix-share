import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { b64urlEncode } from '../src/b64url.ts';
import { hashManageToken } from '../src/manage.ts';
import { POW_CHALLENGE_RE, leadingZeroBits, meetsDifficulty, powHashInput } from '../src/pow.ts';

describe('hashManageToken', () => {
  it('hashes the raw 32 bytes, not the string', async () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
    const token = b64urlEncode(bytes);
    // Fixed vector: SHA-256 of 0x00..0x1f.
    expect(await hashManageToken(token)).toBe(
      '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd',
    );
    expect(await hashManageToken(token)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await hashManageToken(token)).not.toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('rejects malformed tokens', async () => {
    await expect(hashManageToken('short')).rejects.toThrow();
    await expect(hashManageToken(b64urlEncode(new Uint8Array(16)))).rejects.toThrow();
  });
});

describe('proof-of-work rules', () => {
  it('fixed vector: hash input and zero-bit count', () => {
    const challenge = `v1.1800000600.18.${'A'.repeat(22)}.${'B'.repeat(43)}`;
    expect(POW_CHALLENGE_RE.test(challenge)).toBe(true);
    expect(powHashInput(challenge, '42')).toBe(`${challenge}:42`);
    // Fixed vector: nonce 898 is the first with at least 10 zero bits (digest 00115a06...).
    const digest = createHash('sha256').update(powHashInput(challenge, '898')).digest();
    expect(digest.toString('hex').slice(0, 8)).toBe('00115a06');
    expect(leadingZeroBits(digest)).toBe(11);
  });

  it('counts leading zero bits', () => {
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x01]))).toBe(7);
    expect(leadingZeroBits(new Uint8Array([0, 0x0f]))).toBe(12);
    expect(leadingZeroBits(new Uint8Array([0, 0]))).toBe(16);
    expect(meetsDifficulty(new Uint8Array([0, 0x0f]), 12)).toBe(true);
    expect(meetsDifficulty(new Uint8Array([0, 0x0f]), 13)).toBe(false);
  });

  it('challenge grammar is strict', () => {
    const ok = `v1.1800000600.18.${'A'.repeat(22)}.${'B'.repeat(43)}`;
    for (const bad of [
      ok.replace('v1', 'v2'),
      ok + '.',
      `v1.01800000600.18.${'A'.repeat(22)}.${'B'.repeat(43)}x`,
      ok.replace('.18.', '.180.'),
      ok.replace(/A/, '+'),
    ]) {
      expect(POW_CHALLENGE_RE.test(bad), bad).toBe(false);
    }
  });
});

describe('normalizePassphrase', () => {
  it('trims surrounding whitespace and applies NFC, keeps inner characters', async () => {
    const { normalizePassphrase } = await import('../src/passphrase.ts');
    expect(normalizePassphrase('  café-orbit \n')).toBe('café-orbit');
    expect(normalizePassphrase('a b')).toBe('a b');
  });
});
