/**
 * Recomputes the v1 known-answer vectors with node:crypto, an implementation path independent of the
 * WebCrypto generator, plus external anchors (RFC 5869, RFC 7914, GCM spec test case 16) for the primitives.
 */
import { createHash, createCipheriv, createDecipheriv, hkdfSync, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import kat from '../vectors/kat-v1.json' with { type: 'json' };
import { fileAad, textAad } from '../src/aad.ts';
import { HKDF_INFO_CONSUME, HKDF_INFO_PASSPHRASE, PBKDF2_ITERATIONS } from '../src/constants.ts';
import { EnvelopeSchema } from '../src/schema.ts';

const hex = (s: string) => Buffer.from(s, 'hex');
const b64 = (s: string) => Buffer.from(s, 'base64url');

function kData(kLink: Buffer, passphrase: string | null, salt: Buffer | null) {
  if (passphrase === null || salt === null) return { k: kLink, pw: null, p: null };
  const pw = Buffer.from(passphrase.trim().normalize('NFC'), 'utf8');
  const p = pbkdf2Sync(pw, salt, PBKDF2_ITERATIONS, 32, 'sha256');
  const k = Buffer.from(hkdfSync('sha256', kLink, p, HKDF_INFO_PASSPHRASE, 32));
  return { k, pw, p };
}

function gcmEncrypt(key: Buffer, iv: Buffer, pt: Buffer, aad: Buffer) {
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(aad);
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}

function gcmDecrypt(key: Buffer, iv: Buffer, ctTag: Buffer, aad: Buffer) {
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  d.setAAD(aad);
  d.setAuthTag(ctTag.subarray(ctTag.length - 16));
  return Buffer.concat([d.update(ctTag.subarray(0, ctTag.length - 16)), d.final()]);
}

describe('primitive anchors (external test vectors)', () => {
  it('HKDF-SHA256 matches RFC 5869 test case 1', () => {
    const okm = hkdfSync(
      'sha256',
      hex('0b'.repeat(22)),
      hex('000102030405060708090a0b0c'),
      hex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(Buffer.from(okm).toString('hex')).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('PBKDF2-HMAC-SHA256 matches RFC 7914 section 11', () => {
    expect(pbkdf2Sync('passwd', 'salt', 1, 64, 'sha256').toString('hex')).toBe(
      '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783',
    );
  });

  it('AES-256-GCM matches GCM spec test case 16', () => {
    const out = gcmEncrypt(
      hex('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308'),
      hex('cafebabefacedbaddecaf888'),
      hex(
        'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39',
      ),
      hex('feedfacedeadbeeffeedfacedeadbeefabaddad2'),
    );
    expect(out.toString('hex')).toBe(
      '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662' +
        '76fc6ece0f4e1768cddf8853bb2d551b',
    );
  });
});

describe('kat-v1 text vectors', () => {
  it.each(kat.text)('$name', (v) => {
    const env = EnvelopeSchema.parse(v.envelope);
    const { k, pw, p } = kData(b64(v.kLink), v.passphrase, env.salt ? b64(env.salt) : null);
    expect(pw?.toString('hex') ?? null).toBe(v.passphraseNfcHex);
    expect(p?.toString('hex') ?? null).toBe(v.pbkdf2Hex);
    expect(k.toString('hex')).toBe(v.kData);

    const aad = textAad(env.id, env.hasPassphrase);
    expect(Buffer.from(aad).toString('utf8')).toBe(v.aad);
    expect(Buffer.from(v.plaintext, 'utf8').toString('hex')).toBe(v.plaintextHex);

    expect(
      gcmEncrypt(k, b64(env.iv), hex(v.plaintextHex), Buffer.from(aad)).toString('base64url'),
    ).toBe(env.ct);
    expect(gcmDecrypt(k, b64(env.iv), b64(env.ct), Buffer.from(aad)).toString('hex')).toBe(
      v.plaintextHex,
    );
  });

  it('literal AAD strings', () => {
    const byName = Object.fromEntries(kat.text.map((v) => [v.name, v]));
    expect(byName['text-no-passphrase']!.aad).toBe('brix-share/v1|AAECAwQFBgcICQoLDA0ODw|text|n');
    expect(byName['text-passphrase']!.aad).toBe('brix-share/v1|EBESExQVFhcYGRobHB0eHw|text|p');
  });

  it('surrounding whitespace is trimmed before derivation', () => {
    const byName = Object.fromEntries(kat.text.map((v) => [v.name, v]));
    expect(byName['text-passphrase-whitespace']!.kData).toBe(byName['text-passphrase']!.kData);
    expect(byName['text-passphrase-whitespace']!.envelope.ct).toBe(
      byName['text-passphrase']!.envelope.ct,
    );
  });

  it('NFD and NFC passphrases derive the same key', () => {
    const byName = Object.fromEntries(kat.text.map((v) => [v.name, v]));
    const nfd = byName['text-passphrase-nfc']!;
    const nfc = byName['text-passphrase-nfc-twin']!;
    expect(nfd.passphrase).not.toBe(nfc.passphrase);
    expect(nfd.kData).toBe(nfc.kData);
    expect(nfd.envelope.ct).toBe(nfc.envelope.ct);
  });
});

describe('kat-v1 file vectors', () => {
  it.each(kat.files)('$name', (v) => {
    const aad = fileAad(v.id, v.fileId);
    expect(Buffer.from(aad).toString('utf8')).toBe(v.aad);
    expect(v.aad).toBe(`brix-share/v1|${v.id}|file|${v.fileId}`);
    const stored = hex(v.storedHex);
    const iv = stored.subarray(0, 12);
    expect(stored.length).toBe(hex(v.contentHex).length + 28);
    expect(
      gcmDecrypt(hex(v.kFile ?? v.kData), iv, stored.subarray(12), Buffer.from(aad)).toString(
        'hex',
      ),
    ).toBe(v.contentHex);
    expect(
      Buffer.concat([
        iv,
        gcmEncrypt(hex(v.kFile ?? v.kData), iv, hex(v.contentHex), Buffer.from(aad)),
      ]).toString('hex'),
    ).toBe(v.storedHex);
  });
});

describe('kat-v1 negative vectors', () => {
  const byName = Object.fromEntries(kat.text.map((v) => [v.name, v]));

  it.each(kat.negativeText)('$name fails', (n) => {
    const base = byName[n.base]!;
    const env = n.envelope;
    if ('aad' in n && n.aad) {
      const aadMismatch = Buffer.from(n.aad, 'utf8');
      expect(() => gcmDecrypt(hex(base.kData), b64(env.iv), b64(env.ct), aadMismatch)).toThrow();
      // Same key with the true AAD decrypts, so the failure above is the AAD binding alone.
      const ok = gcmDecrypt(hex(base.kData), b64(env.iv), b64(env.ct), Buffer.from(base.aad));
      expect(ok.toString('hex')).toBe(base.plaintextHex);
      return;
    }
    if (env.v !== 'v1') {
      expect(EnvelopeSchema.safeParse(env).success).toBe(false);
      return;
    }
    const passphrase = n.passphrase ?? (env.hasPassphrase ? 'unused' : null);
    const { k } = kData(b64(base.kLink), passphrase, env.salt ? b64(env.salt) : null);
    expect(() =>
      gcmDecrypt(k, b64(env.iv), b64(env.ct), Buffer.from(textAad(env.id, env.hasPassphrase))),
    ).toThrow();
  });

  it.each(kat.negativeFiles)('$name fails', (n) => {
    const base = kat.files.find((f) => f.name === n.base)!;
    const stored = hex(n.storedHex);
    expect(() =>
      gcmDecrypt(
        hex(n.keyHex ?? base.kFile ?? base.kData),
        stored.subarray(0, 12),
        stored.subarray(12),
        Buffer.from(fileAad(n.id ?? base.id, n.fileId)),
      ),
    ).toThrow();
  });
});

describe('kat-v1 consume vectors', () => {
  it.each(kat.consume)('$name: independent HKDF and hash', (v) => {
    const token = Buffer.from(
      hkdfSync('sha256', b64(v.kLink), Buffer.alloc(0), HKDF_INFO_CONSUME, 32),
    );
    expect(token.toString('base64url')).toBe(v.token);
    expect(createHash('sha256').update(token).digest('hex')).toBe(v.hash);
  });
});
