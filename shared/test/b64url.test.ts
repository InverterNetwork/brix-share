import { describe, expect, it } from 'vitest';
import {
  b64urlDecode,
  b64urlEncode,
  b64urlLength,
  bytesToHex,
  hexToBytes,
  isB64urlOfLength,
} from '../src/b64url.ts';

describe('b64url', () => {
  it('round-trips every length 0..64 against Buffer', () => {
    for (let n = 0; n <= 64; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      const s = b64urlEncode(bytes);
      expect(s).toBe(Buffer.from(bytes).toString('base64url'));
      expect(s.length).toBe(b64urlLength(n));
      expect(b64urlDecode(s)).toEqual(bytes);
    }
  });

  it('rejects padding, foreign characters and impossible lengths', () => {
    expect(() => b64urlDecode('AAAA=')).toThrow();
    expect(() => b64urlDecode('AA+A')).toThrow();
    expect(() => b64urlDecode('AA/A')).toThrow();
    expect(() => b64urlDecode('AAAAA')).toThrow();
    expect(() => b64urlDecode('ÄAAA')).toThrow();
  });

  it('rejects non-canonical trailing bits', () => {
    // "AA" is one zero byte; "AB" encodes the same byte with a stray low bit set.
    expect(b64urlDecode('AA')).toEqual(new Uint8Array([0]));
    expect(() => b64urlDecode('AB')).toThrow('non-canonical');
    expect(() => b64urlDecode('AAB')).toThrow('non-canonical');
  });

  it('checks exact decoded length', () => {
    const id = b64urlEncode(new Uint8Array(16).fill(7));
    expect(isB64urlOfLength(id, 16)).toBe(true);
    expect(isB64urlOfLength(id, 12)).toBe(false);
    expect(isB64urlOfLength(id.slice(0, 21) + 'B', 16)).toBe(false);
  });

  it('hex round-trips and rejects uppercase', () => {
    expect(bytesToHex(hexToBytes('00ff10'))).toBe('00ff10');
    expect(() => hexToBytes('FF')).toThrow();
    expect(() => hexToBytes('abc')).toThrow();
  });
});
