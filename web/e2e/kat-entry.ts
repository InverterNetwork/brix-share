/**
 * Bundled by esbuild for the test-only /__kat page: runs the real crypto module against the known-answer
 * vectors in each browser engine and publishes the outcome on window.__kat.
 */
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
  importFileKey,
  checkEnvelope,
  deriveKDataBytes,
  deriveKey,
  deriveConsumeToken,
  envelopeSalt,
  openFile,
  openText,
  sealFile,
  sealText,
} from '../src/crypto/envelope.ts';

declare global {
  interface Window {
    __kat?: { ok: boolean; results: { name: string; ok: boolean; detail?: string }[] };
  }
}

async function run() {
  const results: { name: string; ok: boolean; detail?: string }[] = [];
  const check = async (name: string, fn: () => Promise<boolean>) => {
    try {
      results.push({ name, ok: await fn() });
    } catch (e) {
      results.push({ name, ok: false, detail: String(e) });
    }
  };
  const byName = Object.fromEntries(kat.text.map((v) => [v.name, v]));

  for (const v of kat.text) {
    await check(`text:${v.name}`, async () => {
      const env = checkEnvelope(v.envelope, v.envelope.id);
      const kLink = b64urlDecode(v.kLink);
      if (bytesToHex(await deriveKDataBytes(kLink, v.passphrase, envelopeSalt(env))) !== v.kData)
        return false;
      const key = await deriveKey(kLink, v.passphrase, envelopeSalt(env));
      const parsed = PayloadSchema.safeParse(JSON.parse(v.plaintext));
      if (v.name === 'text-with-files') {
        if (parsed.success) return false;
        try {
          await openText(env, key);
          return false;
        } catch (e) {
          return e instanceof ProtocolError;
        }
      }
      if (!parsed.success) throw parsed.error;
      const payload = parsed.data;
      const sealed = await sealText({
        id: env.id,
        key,
        salt: envelopeSalt(env),
        payload,
        iv: b64urlDecode(env.iv),
      });
      const opened = await openText(env, key);
      return sealed.ct === env.ct && JSON.stringify(opened) === JSON.stringify(payload);
    });
  }
  for (const v of kat.files) {
    await check(`file:${v.name}`, async () => {
      const t = byName[v.textCase]!;
      const key =
        v.kFile !== undefined
          ? await importFileKey(hexToBytes(v.kFile))
          : await deriveKey(
              b64urlDecode(t.kLink),
              t.passphrase,
              envelopeSalt(t.envelope as Envelope),
            );
      const stored = hexToBytes(v.storedHex);
      const sealed = await sealFile(
        v.id,
        v.fileId,
        key,
        hexToBytes(v.contentHex),
        stored.slice(0, 12),
      );
      return (
        bytesToHex(sealed) === v.storedHex &&
        bytesToHex(await openFile(v.id, v.fileId, key, stored)) === v.contentHex
      );
    });
  }
  for (const n of kat.negativeText) {
    await check(`negative:${n.name}`, async () => {
      const base = byName[n.base]!;
      let env: Envelope;
      try {
        env = checkEnvelope(n.envelope, n.envelope.id);
      } catch {
        return n.envelope.v !== 'v1';
      }
      const aadCase = 'aad' in n && Boolean(n.aad);
      const passphrase = aadCase ? null : (n.passphrase ?? (env.hasPassphrase ? 'unused' : null));
      const key = await deriveKey(
        b64urlDecode(base.kLink),
        passphrase,
        aadCase ? null : envelopeSalt(env),
      );
      try {
        await openText(aadCase ? { ...env, hasPassphrase: true } : env, key);
        return false;
      } catch (e) {
        return e instanceof DecryptError;
      }
    });
  }
  for (const n of kat.negativeFiles) {
    await check(`negative-file:${n.name}`, async () => {
      const base = kat.files.find((f) => f.name === n.base)!;
      const t = byName[base.textCase]!;
      const key =
        n.keyHex !== undefined
          ? await importFileKey(hexToBytes(n.keyHex))
          : base.kFile !== undefined
            ? await importFileKey(hexToBytes(base.kFile))
            : await deriveKey(
                b64urlDecode(t.kLink),
                t.passphrase,
                envelopeSalt(t.envelope as Envelope),
              );
      try {
        await openFile(n.id ?? base.id, n.fileId, key, hexToBytes(n.storedHex));
        return false;
      } catch (e) {
        return e instanceof DecryptError;
      }
    });
  }
  for (const v of kat.consume) {
    await check(`consume:${v.name}`, async () => {
      const token = await deriveConsumeToken(b64urlDecode(v.kLink));
      return token === v.token && (await hashConsumeToken(token)) === v.hash;
    });
  }
  window.__kat = { ok: results.every((r) => r.ok), results };
}

void run();
