/**
 * The passphrase string that goes into PBKDF2: surrounding whitespace removed (mobile keyboards append a
 * space after a predicted word), then Unicode NFC. Both sides apply exactly this rule.
 */
export function normalizePassphrase(passphrase: string): string {
  return passphrase.trim().normalize('NFC');
}
