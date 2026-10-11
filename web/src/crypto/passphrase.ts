import { normalizePassphrase } from '@brix-share/shared';

/** Generated passphrases and a rough strength estimate for user-chosen ones (PLAN section 6, decision 5). */

export const PASSPHRASE_WORDS = 5;

/** Uniform index in [0, n) from crypto.getRandomValues, by rejection sampling (no modulo bias). */
export function uniformIndex(
  n: number,
  random: (buf: Uint32Array<ArrayBuffer>) => Uint32Array<ArrayBuffer> = (b) =>
    globalThis.crypto.getRandomValues(b),
): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    const v = random(buf)[0]!;
    if (v < limit) return v % n;
  }
}

export async function loadWords(): Promise<readonly string[]> {
  return (await import('./wordlist.ts')).WORDS;
}

export function generatePassphrase(words: readonly string[], count = PASSPHRASE_WORDS): string {
  return Array.from({ length: count }, () => words[uniformIndex(words.length)]!).join('-');
}

export const MIN_CUSTOM_LENGTH = 20;

export type PassphraseAssessment =
  { kind: 'generated'; bits: number } | { kind: 'custom'; tooShort: boolean };

/**
 * Only an unchanged generated phrase has a known strength (words picked uniformly at random). A phrase the
 * user typed or edited cannot be rated by looking at it: dictionary words or character classes say nothing
 * about how it was chosen. So custom phrases get a warning, never a bit count.
 */
export function assessPassphrase(
  passphrase: string,
  generated: string | null,
  listSize: number,
): PassphraseAssessment {
  if (generated !== null && normalizePassphrase(passphrase) === normalizePassphrase(generated)) {
    return {
      kind: 'generated',
      bits: Math.floor(generated.split('-').length * Math.log2(listSize)),
    };
  }
  return { kind: 'custom', tooShort: normalizePassphrase(passphrase).length < MIN_CUSTOM_LENGTH };
}
