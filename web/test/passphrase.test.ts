import { describe, expect, it } from 'vitest';
import {
  assessPassphrase,
  generatePassphrase,
  loadWords,
  uniformIndex,
} from '../src/crypto/passphrase.ts';

describe('passphrases', () => {
  it('wordlist: 7772 unique lower-case words, five give at least 64 bits', async () => {
    const words = await loadWords();
    expect(words).toHaveLength(7772);
    expect(new Set(words).size).toBe(7772);
    expect(words.every((w) => /^[a-z]+$/.test(w))).toBe(true);
    expect(5 * Math.log2(words.length)).toBeGreaterThan(64);
  });

  it('generates five words joined by hyphens; the unchanged phrase is rated by its real entropy', async () => {
    const words = await loadWords();
    const p = generatePassphrase(words);
    expect(p.split('-')).toHaveLength(5);
    expect(assessPassphrase(p, p, words.length)).toEqual({ kind: 'generated', bits: 64 });
    expect(assessPassphrase(` ${p} `, p, words.length).kind).toBe('generated');
    expect(generatePassphrase(words)).not.toBe(p);
  });

  it('any edited or self-chosen phrase gets no bit count, only a warning', async () => {
    const words = await loadWords();
    const p = generatePassphrase(words);
    expect(assessPassphrase(p + 'x', p, words.length)).toEqual({ kind: 'custom', tooShort: false });
    expect(assessPassphrase('abacus-abacus-abacus-abacus-abacus', null, words.length)).toEqual({
      kind: 'custom',
      tooShort: false,
    });
    expect(assessPassphrase('Summer2026!', null, words.length)).toEqual({
      kind: 'custom',
      tooShort: true,
    });
  });

  it('rejection sampling never returns out-of-range or biased tail values', () => {
    const values = [0xffffffff, 0xfffffff0, 7]; // the first two fall in the rejected tail for n = 7772
    let i = 0;
    const idx = uniformIndex(7772, (b) => {
      b[0] = values[i++]!;
      return b;
    });
    expect(idx).toBe(7);
    expect(i).toBe(3);
  });
});
