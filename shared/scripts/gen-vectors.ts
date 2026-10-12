/**
 * Generates the v1 known-answer test vectors (shared/vectors/kat-v1.json) with WebCrypto in Node.
 * Deliberately standalone: it does not import the client crypto module, so the vectors check that module
 * instead of snapshotting it. Run: pnpm --filter @brix-share/shared gen-vectors
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { b64urlEncode, bytesToHex } from '../src/b64url.ts';

// Protocol strings typed out here on purpose instead of imported from src/, so a typo in
// src/constants.ts or src/aad.ts shows up as a vector mismatch rather than being baked into the vectors.
const PROTOCOL_VERSION = 'v1';
const PBKDF2_ITERATIONS = 600000;
const HKDF_INFO_PASSPHRASE = 'brix-share/v1/passphrase';
const textAad = (id: string, p: boolean) => enc.encode(`brix-share/v1|${id}|text|${p ? 'p' : 'n'}`);
const fileAad = (id: string, fileId: string) => enc.encode(`brix-share/v1|${id}|file|${fileId}`);

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

const seq = (start: number, len: number) =>
  Uint8Array.from({ length: len }, (_, i) => (start + i) & 0xff);

async function deriveKData(kLink: Uint8Array, passphrase: string | null, salt: Uint8Array | null) {
  if (passphrase === null || salt === null) return { kData: kLink, pw: null, p: null };
  const pw = enc.encode(passphrase.trim().normalize('NFC'));
  const pwKey = await subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
  const p = new Uint8Array(
    await subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: salt as BufferSource,
        iterations: PBKDF2_ITERATIONS,
      },
      pwKey,
      256,
    ),
  );
  const ikm = await subtle.importKey('raw', kLink as BufferSource, 'HKDF', false, ['deriveBits']);
  const kData = new Uint8Array(
    await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: p, info: enc.encode(HKDF_INFO_PASSPHRASE) },
      ikm,
      256,
    ),
  );
  return { kData, pw, p };
}

async function seal(kData: Uint8Array, iv: Uint8Array, plaintext: Uint8Array, aad: Uint8Array) {
  const key = await subtle.importKey('raw', kData as BufferSource, 'AES-GCM', false, ['encrypt']);
  return new Uint8Array(
    await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
        additionalData: aad as BufferSource,
        tagLength: 128,
      },
      key,
      plaintext as BufferSource,
    ),
  );
}

interface TextCase {
  name: string;
  id: Uint8Array;
  kLink: Uint8Array;
  iv: Uint8Array;
  passphrase: string | null;
  salt: Uint8Array | null;
  payload: {
    title: string | null;
    text: string;
    files: { fileId: string; name: string; size: number; mime: string }[];
  };
}

interface FileCase {
  name: string;
  textCase: string;
  fileId: Uint8Array;
  iv: Uint8Array;
  content: Uint8Array;
}

const fileIdA = seq(0xa0, 16);
const fileIdB = seq(0xb0, 16);
const fileContentA = enc.encode(
  '-----BEGIN PGP PUBLIC KEY BLOCK-----\nexample\n-----END PGP PUBLIC KEY BLOCK-----\n',
);

const textCases: TextCase[] = [
  {
    name: 'text-no-passphrase',
    id: seq(0x00, 16),
    kLink: seq(0x20, 32),
    iv: seq(0x40, 12),
    passphrase: null,
    salt: null,
    payload: { title: 'Deployer key for staging', text: 'hunter2\nsecond line, ü € 🔑', files: [] },
  },
  {
    name: 'text-passphrase',
    id: seq(0x10, 16),
    kLink: seq(0x30, 32),
    iv: seq(0x50, 12),
    passphrase: 'harbor-velvet-ninety-cactus-orbit',
    salt: seq(0x60, 16),
    payload: { title: null, text: 'correct horse battery staple', files: [] },
  },
  {
    // Same inputs as text-passphrase with surrounding whitespace: trimmed before NFC, so K_data and ct match.
    name: 'text-passphrase-whitespace',
    id: seq(0x10, 16),
    kLink: seq(0x30, 32),
    iv: seq(0x50, 12),
    passphrase: '  harbor-velvet-ninety-cactus-orbit \n',
    salt: seq(0x60, 16),
    payload: { title: null, text: 'correct horse battery staple', files: [] },
  },
  {
    name: 'text-passphrase-nfc',
    id: seq(0x11, 16),
    kLink: seq(0x31, 32),
    iv: seq(0x51, 12),
    // Decomposed "é" (e + U+0301); must be NFC-normalised before PBKDF2.
    passphrase: 'café-orbit',
    salt: seq(0x61, 16),
    payload: { title: 'NFC', text: 'normalised passphrase', files: [] },
  },
  {
    // Same inputs as text-passphrase-nfc with the precomposed passphrase: K_data and ct must be identical.
    name: 'text-passphrase-nfc-twin',
    id: seq(0x11, 16),
    kLink: seq(0x31, 32),
    iv: seq(0x51, 12),
    passphrase: 'caf\u00e9-orbit',
    salt: seq(0x61, 16),
    payload: { title: 'NFC', text: 'normalised passphrase', files: [] },
  },
  {
    name: 'text-with-files',
    id: seq(0x70, 16),
    kLink: seq(0x80, 32),
    iv: seq(0x90, 12),
    passphrase: 'orbit-cactus-ninety-velvet-harbor',
    salt: seq(0x98, 16),
    payload: {
      title: 'Audit handover',
      text: 'Two files attached.',
      files: [
        {
          fileId: b64urlEncode(fileIdA),
          name: 'audit-handover.pub.asc',
          size: fileContentA.length,
          mime: 'application/pgp-keys',
        },
        { fileId: b64urlEncode(fileIdB), name: 'empty.txt', size: 0, mime: 'text/plain' },
      ],
    },
  },
];

const fileCases: FileCase[] = [
  {
    name: 'file-pgp',
    textCase: 'text-with-files',
    fileId: fileIdA,
    iv: seq(0xc0, 12),
    content: fileContentA,
  },
  {
    name: 'file-empty',
    textCase: 'text-with-files',
    fileId: fileIdB,
    iv: seq(0xd0, 12),
    content: new Uint8Array(0),
  },
];

const flip = (b: Uint8Array, at: number) => {
  const c = Uint8Array.from(b);
  c[at]! ^= 0x01;
  return c;
};

interface TextVector {
  name: string;
  kLink: string;
  passphrase: string | null;
  passphraseNfcHex: string | null;
  pbkdf2Hex: string | null;
  kData: string;
  aad: string;
  plaintext: string;
  plaintextHex: string;
  envelope: {
    v: string;
    id: string;
    iv: string;
    salt: string | null;
    ct: string;
    hasPassphrase: boolean;
    fileIds: string[];
  };
}

const textVectors: TextVector[] = [];
const fileVectors: unknown[] = [];
const kDataByCase = new Map<string, Uint8Array>();
const idByCase = new Map<string, string>();

for (const c of textCases) {
  const id = b64urlEncode(c.id);
  const { kData, pw, p } = await deriveKData(c.kLink, c.passphrase, c.salt);
  const hasPassphrase = c.passphrase !== null;
  const aad = textAad(id, hasPassphrase);
  const plaintext = JSON.stringify(c.payload);
  const ptBytes = enc.encode(plaintext);
  const ct = await seal(kData, c.iv, ptBytes, aad);
  kDataByCase.set(c.name, kData);
  idByCase.set(c.name, id);
  textVectors.push({
    name: c.name,
    kLink: b64urlEncode(c.kLink),
    passphrase: c.passphrase,
    passphraseNfcHex: pw ? bytesToHex(pw) : null,
    pbkdf2Hex: p ? bytesToHex(p) : null,
    kData: bytesToHex(kData),
    aad: new TextDecoder().decode(aad),
    plaintext,
    plaintextHex: bytesToHex(ptBytes),
    envelope: {
      v: PROTOCOL_VERSION,
      id,
      iv: b64urlEncode(c.iv),
      salt: c.salt ? b64urlEncode(c.salt) : null,
      ct: b64urlEncode(ct),
      hasPassphrase,
      fileIds: c.payload.files.map((f) => f.fileId),
    },
  });
}

for (const f of fileCases) {
  const kData = kDataByCase.get(f.textCase)!;
  const id = idByCase.get(f.textCase)!;
  const fileId = b64urlEncode(f.fileId);
  const aad = fileAad(id, fileId);
  const ct = await seal(kData, f.iv, f.content, aad);
  const stored = new Uint8Array(f.iv.length + ct.length);
  stored.set(f.iv);
  stored.set(ct, f.iv.length);
  fileVectors.push({
    name: f.name,
    textCase: f.textCase,
    id,
    fileId,
    kData: bytesToHex(kData),
    aad: new TextDecoder().decode(aad),
    contentHex: bytesToHex(f.content),
    storedHex: bytesToHex(stored),
  });
}

// Negative cases: each must fail to decrypt (or be refused) with the given inputs.
const base = textVectors[0]!;
const withPass = textVectors[1]!;
const ctBytes = (v: TextVector) => {
  const s = v.envelope.ct;
  return Uint8Array.from(Buffer.from(s, 'base64url'));
};
const negative = [
  {
    name: 'ct-bit-flip',
    base: base.name,
    passphrase: null,
    envelope: { ...base.envelope, ct: b64urlEncode(flip(ctBytes(base), 0)) },
  },
  {
    name: 'tag-bit-flip',
    base: base.name,
    passphrase: null,
    envelope: { ...base.envelope, ct: b64urlEncode(flip(ctBytes(base), ctBytes(base).length - 1)) },
  },
  {
    name: 'iv-bit-flip',
    base: base.name,
    passphrase: null,
    envelope: {
      ...base.envelope,
      iv: b64urlEncode(flip(Uint8Array.from(Buffer.from(base.envelope.iv, 'base64url')), 0)),
    },
  },
  {
    name: 'id-swapped',
    base: base.name,
    passphrase: null,
    envelope: { ...base.envelope, id: withPass.envelope.id },
  },
  // Key mismatch: claims a passphrase, so the recipient derives a different K_data.
  {
    name: 'passphrase-claimed-key-mismatch',
    base: base.name,
    passphrase: null,
    envelope: { ...base.envelope, hasPassphrase: true, salt: withPass.envelope.salt },
  },
  {
    name: 'wrong-passphrase',
    base: withPass.name,
    passphrase: 'harbor-velvet-ninety-cactus-orbiT',
    envelope: withPass.envelope,
  },
  // AAD binding: correct K_data, but the AAD says a passphrase was used.
  {
    name: 'aad-passphrase-flag-mismatch',
    base: base.name,
    passphrase: null,
    envelope: base.envelope,
    aad: `brix-share/v1|${base.envelope.id}|text|p`,
  },
  {
    name: 'version-v2',
    base: base.name,
    passphrase: null,
    envelope: { ...base.envelope, v: 'v2' },
  },
];
const fileBase = fileVectors[0] as { name: string; fileId: string; storedHex: string };
const negativeFiles = [
  {
    name: 'file-wrong-fileId',
    base: fileBase.name,
    fileId: (fileVectors[1] as { fileId: string }).fileId,
    storedHex: fileBase.storedHex,
  },
  {
    name: 'file-bit-flip',
    base: fileBase.name,
    fileId: fileBase.fileId,
    storedHex: bytesToHex(flip(Uint8Array.from(Buffer.from(fileBase.storedHex, 'hex')), 20)),
  },
];

const consumeVectors = [];
for (const c of textCases.slice(0, 2)) {
  const ikm = await subtle.importKey('raw', c.kLink as BufferSource, 'HKDF', false, ['deriveBits']);
  const token = new Uint8Array(
    await subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: enc.encode('brix-share/v1/consume'),
      },
      ikm,
      256,
    ),
  );
  consumeVectors.push({
    name: `consume-${c.name}`,
    kLink: b64urlEncode(c.kLink),
    token: b64urlEncode(token),
    hash: bytesToHex(new Uint8Array(await subtle.digest('SHA-256', token))),
  });
}

const out = {
  version: PROTOCOL_VERSION,
  note: 'Generated by shared/scripts/gen-vectors.ts with WebCrypto in Node. ct is ciphertext||tag, stored file objects are iv||ciphertext||tag. Frozen for protocol v1: do not edit by hand.',
  text: textVectors,
  files: fileVectors,
  negativeText: negative,
  negativeFiles,
  consume: consumeVectors,
};

const target = fileURLToPath(new URL('../vectors/kat-v1.json', import.meta.url));
const json = JSON.stringify(out, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== json) {
    console.error('kat-v1.json differs from generator output');
    process.exit(1);
  }
  console.log('kat-v1.json matches generator output');
} else {
  writeFileSync(target, json);
  console.log(
    `wrote ${textVectors.length} text, ${fileVectors.length} file and ${negative.length + negativeFiles.length} negative vectors`,
  );
}
