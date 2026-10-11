import { describe, expect, it } from 'vitest';
import { b64urlEncode } from '../src/b64url.ts';
import { DAY, MAX_CT_CHARS, MAX_TOTAL_FILE_BYTES, MINUTE } from '../src/constants.ts';
import { validateCreateRequest, secToIso } from '../src/validate.ts';
import { payloadMatchesEnvelope, PayloadSchema, EnvelopeSchema } from '../src/schema.ts';

const NOW = 1_800_000_000;
const id = (n: number) => b64urlEncode(new Uint8Array(16).fill(n));
const bytes = (len: number, fill = 1) => b64urlEncode(new Uint8Array(len).fill(fill));

function body(
  overrides: Record<string, unknown> = {},
  envelopeOverrides: Record<string, unknown> = {},
  policyOverrides: Record<string, unknown> = {},
) {
  return {
    envelope: {
      v: 'v1',
      id: id(1),
      iv: bytes(12),
      salt: null,
      ct: bytes(64),
      hasPassphrase: false,
      fileIds: [],
      ...envelopeOverrides,
    },
    policy: {
      maxViews: 1,
      expiresAt: secToIso(NOW + 7 * DAY),
      availableFrom: null,
      ...policyOverrides,
    },
    manageTokenHash: 'a'.repeat(64),
    pow: { challenge: 'c', nonce: '123' },
    files: [],
    ...overrides,
  };
}

const ok = (b: unknown) => validateCreateRequest(b, NOW).ok;

describe('validateCreateRequest', () => {
  it('accepts the default policy', () => {
    const r = validateCreateRequest(body(), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.expiresAtSec).toBe(NOW + 7 * DAY);
      expect(r.value.availableFromSec).toBeNull();
    }
  });

  it('rejects wrong protocol version', () => {
    expect(ok(body({}, { v: 'v2' }))).toBe(false);
  });

  it('rejects malformed ids, ivs and salts', () => {
    expect(ok(body({}, { id: id(1).slice(1) }))).toBe(false);
    expect(ok(body({}, { id: id(1).slice(0, 21) + '+' }))).toBe(false);
    expect(ok(body({}, { iv: bytes(16) }))).toBe(false);
    expect(ok(body({}, { iv: bytes(12) + '=' }))).toBe(false);
    expect(ok(body({}, { hasPassphrase: true, salt: bytes(12) }))).toBe(false);
  });

  it('requires salt exactly when hasPassphrase', () => {
    expect(ok(body({}, { hasPassphrase: true, salt: bytes(16) }))).toBe(true);
    expect(ok(body({}, { hasPassphrase: true, salt: null }))).toBe(false);
    expect(ok(body({}, { hasPassphrase: false, salt: bytes(16) }))).toBe(false);
  });

  it('rejects oversize, undersize and non-base64url ciphertext', () => {
    expect(ok(body({}, { ct: 'A'.repeat(MAX_CT_CHARS) }))).toBe(true);
    expect(ok(body({}, { ct: 'A'.repeat(MAX_CT_CHARS + 4) }))).toBe(false);
    expect(ok(body({}, { ct: bytes(15) }))).toBe(false);
    expect(ok(body({}, { ct: bytes(16) }))).toBe(true);
    expect(ok(body({}, { ct: 'AAAA!AAA' + bytes(30) }))).toBe(false);
  });

  it('rejects unknown keys everywhere', () => {
    expect(ok({ ...body(), extra: 1 })).toBe(false);
    expect(ok(body({}, { extra: 1 }))).toBe(false);
    expect(ok(body({}, {}, { extra: 1 }))).toBe(false);
    expect(ok(body({ pow: { challenge: 'c', nonce: '1', x: 1 } }))).toBe(false);
  });

  it('rejects uppercase or short manage token hashes', () => {
    expect(ok(body({ manageTokenHash: 'A'.repeat(64) }))).toBe(false);
    expect(ok(body({ manageTokenHash: 'a'.repeat(63) }))).toBe(false);
  });

  it('bounds maxViews to null or 1..100 integers', () => {
    expect(ok(body({}, {}, { maxViews: null }))).toBe(true);
    expect(ok(body({}, {}, { maxViews: 100 }))).toBe(true);
    expect(ok(body({}, {}, { maxViews: 0 }))).toBe(false);
    expect(ok(body({}, {}, { maxViews: 101 }))).toBe(false);
    expect(ok(body({}, {}, { maxViews: 1.5 }))).toBe(false);
    expect(ok(body({}, {}, { maxViews: '3' }))).toBe(false);
  });

  it('enforces expiresAt in (now + 5 min, now + 30 d]', () => {
    expect(ok(body({}, {}, { expiresAt: secToIso(NOW + 5 * MINUTE) }))).toBe(false);
    expect(ok(body({}, {}, { expiresAt: secToIso(NOW + 5 * MINUTE + 1) }))).toBe(true);
    expect(ok(body({}, {}, { expiresAt: secToIso(NOW + 30 * DAY) }))).toBe(true);
    expect(ok(body({}, {}, { expiresAt: secToIso(NOW + 30 * DAY + 1) }))).toBe(false);
    expect(ok(body({}, {}, { expiresAt: secToIso(NOW - 1) }))).toBe(false);
  });

  it('floors fractional seconds', () => {
    const iso = new Date((NOW + 30 * DAY) * 1000 + 999).toISOString();
    expect(ok(body({}, {}, { expiresAt: iso }))).toBe(true);
  });

  it('rejects non-UTC and malformed dates', () => {
    expect(ok(body({}, {}, { expiresAt: '2027-01-01T00:00:00+01:00' }))).toBe(false);
    expect(ok(body({}, {}, { expiresAt: '2027-01-01' }))).toBe(false);
    expect(ok(body({}, {}, { expiresAt: 'tomorrow' }))).toBe(false);
    expect(ok(body({}, {}, { expiresAt: NOW + DAY }))).toBe(false);
  });

  it('enforces availableFrom in [now, expiresAt - 5 min)', () => {
    const exp = NOW + DAY;
    const p = (af: number) =>
      body({}, {}, { expiresAt: secToIso(exp), availableFrom: secToIso(af) });
    expect(ok(p(NOW))).toBe(true);
    expect(ok(p(NOW - 1))).toBe(false);
    expect(ok(p(exp - 5 * MINUTE - 1))).toBe(true);
    expect(ok(p(exp - 5 * MINUTE))).toBe(false);
    expect(ok(p(exp + 1))).toBe(false);
  });

  describe('files', () => {
    const f = (n: number, size = 10) => ({ fileId: id(n), size });

    it('accepts matching declarations including empty files', () => {
      expect(ok(body({ files: [f(2), f(3, 0)] }, { fileIds: [id(2), id(3)] }))).toBe(true);
    });

    it('rejects mismatch between files and envelope.fileIds', () => {
      expect(ok(body({ files: [f(2)] }, { fileIds: [] }))).toBe(false);
      expect(ok(body({ files: [] }, { fileIds: [id(2)] }))).toBe(false);
      expect(ok(body({ files: [f(2)] }, { fileIds: [id(3)] }))).toBe(false);
    });

    it('rejects duplicates', () => {
      expect(ok(body({ files: [f(2), f(2)] }, { fileIds: [id(2), id(2)] }))).toBe(false);
      expect(ok(body({ files: [f(2), f(3)] }, { fileIds: [id(2), id(2)] }))).toBe(false);
    });

    it('caps count at 10', () => {
      const ten = Array.from({ length: 10 }, (_, i) => f(i + 10, 1));
      expect(ok(body({ files: ten }, { fileIds: ten.map((x) => x.fileId) }))).toBe(true);
      const eleven = Array.from({ length: 11 }, (_, i) => f(i + 10, 1));
      expect(ok(body({ files: eleven }, { fileIds: eleven.map((x) => x.fileId) }))).toBe(false);
    });

    it('caps total size at 25 MB', () => {
      const half = MAX_TOTAL_FILE_BYTES / 2;
      expect(ok(body({ files: [f(2, half), f(3, half)] }, { fileIds: [id(2), id(3)] }))).toBe(true);
      expect(ok(body({ files: [f(2, half), f(3, half + 1)] }, { fileIds: [id(2), id(3)] }))).toBe(
        false,
      );
      expect(ok(body({ files: [f(2, -1)] }, { fileIds: [id(2)] }))).toBe(false);
    });
  });

  it('never throws on garbage', () => {
    for (const g of [null, undefined, 1, 'x', [], {}, { envelope: null }]) {
      expect(validateCreateRequest(g, NOW).ok).toBe(false);
    }
  });
});

describe('payloadMatchesEnvelope', () => {
  const env = EnvelopeSchema.parse(body({}, { fileIds: [id(2), id(3)] }).envelope);
  const file = (n: number) => ({ fileId: id(n), name: 'a', size: 1, mime: '' });
  it('requires same files in the same order', () => {
    expect(
      payloadMatchesEnvelope(
        PayloadSchema.parse({ title: null, text: '', files: [file(2), file(3)] }),
        env,
      ),
    ).toBe(true);
    expect(
      payloadMatchesEnvelope(
        PayloadSchema.parse({ title: null, text: '', files: [file(3), file(2)] }),
        env,
      ),
    ).toBe(false);
    expect(
      payloadMatchesEnvelope(PayloadSchema.parse({ title: null, text: '', files: [file(2)] }), env),
    ).toBe(false);
  });
});
