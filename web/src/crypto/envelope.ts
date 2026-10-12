/**
 * Protocol v1 envelopes (PLAN section 6). WebCrypto only; no other cryptography in the bundle.
 * Keys never leave memory: K_data is imported as a non-extractable AES-GCM key.
 */
import {
  EnvelopeSchema,
  HKDF_INFO_PASSPHRASE,
  HKDF_INFO_CONSUME,
  ID_BYTES,
  IV_BYTES,
  KEY_BYTES,
  MANAGE_TOKEN_BYTES,
  PBKDF2_ITERATIONS,
  PROTOCOL_VERSION,
  PayloadSchema,
  SALT_BYTES,
  b64urlDecode,
  b64urlEncode,
  fileAad,
  normalizePassphrase,
  payloadMatchesEnvelope,
  textAad,
  type Envelope,
  type Payload,
} from '@brix-share/shared';

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export const newId = () => b64urlEncode(randomBytes(ID_BYTES));
export const newLinkKey = () => randomBytes(KEY_BYTES);
export const newManageToken = () => b64urlEncode(randomBytes(MANAGE_TOKEN_BYTES));
export const newSalt = () => randomBytes(SALT_BYTES);

/** Thrown when decryption fails: wrong passphrase, wrong key or tampered data. Never says which. */
export class DecryptError extends Error {
  constructor() {
    super('decryption failed');
    this.name = 'DecryptError';
  }
}

/** Thrown when an envelope or payload does not follow protocol v1. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Link capability, available before any passphrase prompt; never grants decryption or management. */
export async function deriveConsumeToken(kLink: Uint8Array<ArrayBuffer>): Promise<string> {
  if (kLink.length !== KEY_BYTES) throw new ProtocolError('link key must be 32 bytes');
  const ikm = await subtle().importKey('raw', kLink, 'HKDF', false, ['deriveBits']);
  const token = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(HKDF_INFO_CONSUME) },
    ikm,
    256,
  );
  return b64urlEncode(new Uint8Array(token));
}

/** Raw K_data bytes. Exposed for the known-answer tests; app code uses `deriveKey`. */
export async function deriveKDataBytes(
  kLink: Uint8Array<ArrayBuffer>,
  passphrase: string | null,
  salt: Uint8Array<ArrayBuffer> | null,
): Promise<Uint8Array<ArrayBuffer>> {
  if ((passphrase === null) !== (salt === null)) {
    // A passphrase without salt (or the reverse) must never silently fall back to the link key alone.
    throw new ProtocolError('passphrase and salt must be given together');
  }
  if (passphrase === null || salt === null) return kLink;
  const pwKey = await subtle().importKey(
    'raw',
    enc.encode(normalizePassphrase(passphrase)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const p = new Uint8Array(
    await subtle().deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
      pwKey,
      256,
    ),
  );
  const ikm = await subtle().importKey('raw', kLink, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await subtle().deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: p, info: enc.encode(HKDF_INFO_PASSPHRASE) },
      ikm,
      256,
    ),
  );
}

/** K_data as a non-extractable AES-256-GCM key. */
export async function deriveKey(
  kLink: Uint8Array<ArrayBuffer>,
  passphrase: string | null,
  salt: Uint8Array<ArrayBuffer> | null,
): Promise<CryptoKey> {
  if (kLink.length !== KEY_BYTES) throw new ProtocolError('link key must be 32 bytes');
  const raw = await deriveKDataBytes(kLink, passphrase, salt);
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function gcmEncrypt(
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
) {
  return new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, data),
  );
}

async function gcmDecrypt(
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
) {
  try {
    return new Uint8Array(
      await subtle().decrypt(
        { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
        key,
        data,
      ),
    );
  } catch {
    throw new DecryptError();
  }
}

export interface SealTextInput {
  id: string;
  key: CryptoKey;
  salt: Uint8Array<ArrayBuffer> | null;
  payload: Payload;
  /** Fixed IV for the known-answer tests only; real calls always get a fresh random IV. */
  iv?: Uint8Array<ArrayBuffer>;
}

/** Encrypts the text payload into a v1 envelope. */
export async function sealText({
  id,
  key,
  salt,
  payload,
  iv = randomBytes(IV_BYTES),
}: SealTextInput): Promise<Envelope> {
  const hasPassphrase = salt !== null;
  const plaintext = enc.encode(JSON.stringify(PayloadSchema.parse(payload)));
  const ct = await gcmEncrypt(key, iv, plaintext, textAad(id, hasPassphrase));
  return {
    v: PROTOCOL_VERSION,
    id,
    iv: b64urlEncode(iv),
    salt: salt ? b64urlEncode(salt) : null,
    ct: b64urlEncode(ct),
    hasPassphrase,
    fileIds: payload.files.map((f) => f.fileId),
  };
}

/**
 * Validates an envelope received from the server against protocol v1 and the id from the URL.
 * Throws ProtocolError before any key derivation if it does not match.
 */
export function checkEnvelope(raw: unknown, expectedId: string): Envelope {
  const parsed = EnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new ProtocolError('unsupported or malformed envelope');
  if (parsed.data.id !== expectedId)
    throw new ProtocolError('envelope does not belong to this link');
  if (parsed.data.hasPassphrase !== (parsed.data.salt !== null)) {
    throw new ProtocolError('envelope passphrase flag and salt disagree');
  }
  return parsed.data;
}

/** Decrypts and validates the text payload. DecryptError on a wrong key/passphrase or tampering. */
export async function openText(envelope: Envelope, key: CryptoKey): Promise<Payload> {
  const plaintext = await gcmDecrypt(
    key,
    b64urlDecode(envelope.iv),
    b64urlDecode(envelope.ct),
    textAad(envelope.id, envelope.hasPassphrase),
  );
  let json: unknown;
  try {
    json = JSON.parse(dec.decode(plaintext));
  } catch {
    throw new ProtocolError('payload is not valid JSON');
  }
  const payload = PayloadSchema.safeParse(json);
  if (!payload.success) throw new ProtocolError('payload does not follow protocol v1');
  if (!payloadMatchesEnvelope(payload.data, envelope))
    throw new ProtocolError('payload files do not match envelope');
  return payload.data;
}

/** Envelope salt as bytes, or null. */
export function envelopeSalt(envelope: Envelope): Uint8Array<ArrayBuffer> | null {
  return envelope.salt === null ? null : b64urlDecode(envelope.salt);
}

/** Encrypts one attachment: stored bytes are iv || ciphertext || tag. */
export async function sealFile(
  id: string,
  fileId: string,
  key: CryptoKey,
  content: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer> = randomBytes(IV_BYTES),
): Promise<Uint8Array<ArrayBuffer>> {
  const ct = await gcmEncrypt(key, iv, content, fileAad(id, fileId));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv);
  out.set(ct, IV_BYTES);
  return out;
}

export async function openFile(
  id: string,
  fileId: string,
  key: CryptoKey,
  stored: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (stored.length < IV_BYTES + 16) throw new DecryptError();
  return gcmDecrypt(key, stored.slice(0, IV_BYTES), stored.slice(IV_BYTES), fileAad(id, fileId));
}

/** SHA-256 hex of a string or bytes (request body hashes for CloudFront OAC). */
export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  const digest = new Uint8Array(await subtle().digest('SHA-256', bytes));
  let out = '';
  for (const b of digest) out += b.toString(16).padStart(2, '0');
  return out;
}
