import { describe, expect, it } from 'vitest';
import kat from '@brix-share/shared/vectors/kat-v1.json' with { type: 'json' };
import {
  PayloadSchema,
  hashConsumeToken,
  b64urlDecode,
  bytesToHex,
  hexToBytes,
  type Envelope,
} from '@brix-share/shared';
import {
  DecryptError,
  ProtocolError,
  checkEnvelope,
  deriveKDataBytes,
  deriveKey,
  deriveConsumeToken,
  envelopeSalt,
  newId,
  newLinkKey,
  newSalt,
  openFile,
  openText,
  sealFile,
  sealText,
} from '../src/crypto/envelope.ts';

const byName = Object.fromEntries(kat.text.map((v) => [v.name, v]));

describe('known-answer vectors (protocol v1)', () => {
  it.each(kat.text)(
    'text $name: derives K_data, seals to the exact ciphertext, opens',
    async (v) => {
      const env = checkEnvelope(v.envelope, v.envelope.id);
      const kLink = b64urlDecode(v.kLink);
      expect(bytesToHex(await deriveKDataBytes(kLink, v.passphrase, envelopeSalt(env)))).toBe(
        v.kData,
      );
      const key = await deriveKey(kLink, v.passphrase, envelopeSalt(env));
      const payload = PayloadSchema.parse(JSON.parse(v.plaintext));
      const sealed = await sealText({
        id: env.id,
        key,
        salt: envelopeSalt(env),
        payload,
        iv: b64urlDecode(env.iv),
      });
      expect(sealed).toEqual(env);
      expect(await openText(env, key)).toEqual(payload);
    },
  );

  it.each(kat.files)('file $name: seals and opens the exact stored bytes', async (v) => {
    const t = byName[v.textCase]!;
    const key = await deriveKey(
      b64urlDecode(t.kLink),
      t.passphrase,
      envelopeSalt(t.envelope as Envelope),
    );
    const stored = hexToBytes(v.storedHex);
    const content = hexToBytes(v.contentHex);
    expect(bytesToHex(await sealFile(v.id, v.fileId, key, content, stored.slice(0, 12)))).toBe(
      v.storedHex,
    );
    expect(bytesToHex(await openFile(v.id, v.fileId, key, stored))).toBe(v.contentHex);
  });

  it.each(kat.negativeText)('negative $name is refused', async (n) => {
    const base = byName[n.base]!;
    const parsed = (() => {
      try {
        return checkEnvelope(n.envelope, n.envelope.id);
      } catch (e) {
        return e;
      }
    })();
    if (parsed instanceof ProtocolError) {
      expect(n.envelope.v).not.toBe('v1');
      return;
    }
    const env = parsed as Envelope;
    if ('aad' in n && n.aad) {
      // AAD binding: same key, flipped passphrase flag in the envelope.
      const key = await deriveKey(b64urlDecode(base.kLink), null, null);
      await expect(openText({ ...env, hasPassphrase: true }, key)).rejects.toBeInstanceOf(
        DecryptError,
      );
      return;
    }
    const passphrase = n.passphrase ?? (env.hasPassphrase ? 'unused' : null);
    const key = await deriveKey(b64urlDecode(base.kLink), passphrase, envelopeSalt(env));
    await expect(openText(env, key)).rejects.toBeInstanceOf(DecryptError);
  });

  it.each(kat.negativeFiles)('negative file $name is refused', async (n) => {
    const base = kat.files.find((f) => f.name === n.base)!;
    const t = byName[base.textCase]!;
    const key = await deriveKey(
      b64urlDecode(t.kLink),
      t.passphrase,
      envelopeSalt(t.envelope as Envelope),
    );
    await expect(openFile(base.id, n.fileId, key, hexToBytes(n.storedHex))).rejects.toBeInstanceOf(
      DecryptError,
    );
  });
});

describe('round trips', () => {
  const payload = { title: 'T', text: 'line 1\nline 2 ü €', files: [] };

  it('without passphrase, fresh ids, keys and IVs every time', async () => {
    const id = newId();
    const kLink = newLinkKey();
    const key = await deriveKey(kLink, null, null);
    const a = await sealText({ id, key, salt: null, payload });
    const b = await sealText({ id, key, salt: null, payload });
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(await openText(a, key)).toEqual(payload);
    expect(newId()).not.toBe(id);
  });

  it('with passphrase; a wrong passphrase fails without changing the envelope', async () => {
    const id = newId();
    const kLink = newLinkKey();
    const salt = newSalt();
    const env = await sealText({
      id,
      key: await deriveKey(kLink, 'harbor-velvet', salt),
      salt,
      payload,
    });
    expect(env.hasPassphrase).toBe(true);
    await expect(
      openText(env, await deriveKey(kLink, 'harbor-velvez', salt)),
    ).rejects.toBeInstanceOf(DecryptError);
    expect(await openText(env, await deriveKey(kLink, 'harbor-velvet', salt))).toEqual(payload);
  });

  it('keys are not extractable', async () => {
    const key = await deriveKey(newLinkKey(), null, null);
    expect(key.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('refuses envelopes for another id or another protocol version', async () => {
    const key = await deriveKey(newLinkKey(), null, null);
    const env = await sealText({ id: newId(), key, salt: null, payload });
    expect(() => checkEnvelope(env, newId())).toThrow(ProtocolError);
    expect(() => checkEnvelope({ ...env, v: 'v2' }, env.id)).toThrow(ProtocolError);
    expect(() => checkEnvelope({ ...env, extra: 1 }, env.id)).toThrow(ProtocolError);
  });

  it('rejects a payload whose file list does not match the envelope', async () => {
    const id = newId();
    const key = await deriveKey(newLinkKey(), null, null);
    const env = await sealText({ id, key, salt: null, payload });
    // Same ciphertext, envelope claims a file: the AAD does not cover fileIds, the payload check does.
    await expect(openText({ ...env, fileIds: [newId()] }, key)).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });
});

describe('consistency and normalisation', () => {
  it('refuses a passphrase without salt and the reverse instead of silently dropping it', async () => {
    await expect(deriveKDataBytes(newLinkKey(), 'pass', null)).rejects.toBeInstanceOf(
      ProtocolError,
    );
    await expect(deriveKDataBytes(newLinkKey(), null, newSalt())).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });

  it('rejects envelopes whose passphrase flag and salt disagree', async () => {
    const key = await deriveKey(newLinkKey(), null, null);
    const env = await sealText({
      id: newId(),
      key,
      salt: null,
      payload: { title: null, text: 'x', files: [] },
    });
    expect(() => checkEnvelope({ ...env, hasPassphrase: true }, env.id)).toThrow(ProtocolError);
  });

  it('surrounding whitespace in the passphrase does not matter (mobile keyboards)', async () => {
    const kLink = newLinkKey();
    const salt = newSalt();
    const env = await sealText({
      id: newId(),
      key: await deriveKey(kLink, 'orbit-cactus', salt),
      salt,
      payload: { title: null, text: 'ws', files: [] },
    });
    expect((await openText(env, await deriveKey(kLink, ' orbit-cactus \n', salt))).text).toBe('ws');
  });
});

describe('consume capability', () => {
  it.each(kat.consume)('$name derives and hashes without a passphrase', async (v) => {
    const token = await deriveConsumeToken(b64urlDecode(v.kLink));
    expect(token).toBe(v.token);
    expect(await hashConsumeToken(token)).toBe(v.hash);
    expect(token).not.toBe(v.kLink);
  });
  it('rejects malformed keys and tokens', async () => {
    await expect(deriveConsumeToken(new Uint8Array(31))).rejects.toThrow(ProtocolError);
    for (const token of ['bad!', '', 'A'.repeat(42), 'A'.repeat(44)])
      await expect(hashConsumeToken(token)).rejects.toThrow();
  });
});
