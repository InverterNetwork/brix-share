import { b64urlEncode } from '@brix-share/shared';
import { describe, expect, it } from 'vitest';
import { decryptFiles, fetchEncryptedFiles, safeFileName } from '../src/attachments.ts';
import { importFileKey, newFileKey, newId, sealFile } from '../src/crypto/envelope.ts';

describe('attachments', () => {
  it('decrypts to octet-stream blobs, refuses a size that differs from the payload, keeps names safe', async () => {
    const id = newId();
    const raw = newFileKey();
    const key = await importFileKey(raw);
    const [a, b] = [newId(), newId()];
    const good = await sealFile(id, a, key, new Uint8Array([1, 2, 3]));
    const short = await sealFile(id, b, key, new Uint8Array([1, 2]));
    const files = await decryptFiles(
      id,
      {
        title: null,
        text: '',
        files: [
          {
            fileId: a,
            name: '../../etc/passwd',
            size: 3,
            mime: 'text/html',
            key: b64urlEncode(raw),
          },
          { fileId: b, name: 'b.txt', size: 3, mime: 'text/plain', key: b64urlEncode(raw) },
        ],
      },
      [good, short],
    );
    expect(files[0]!.name).toBe('.._.._etc_passwd');
    expect(files[0]!.url).toMatch(/^blob:/);
    const blob = await (await fetch(files[0]!.url!)).blob();
    expect(blob.type).toBe('application/octet-stream');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(files[1]!.url).toBeNull();
  });

  it('sanitises names', () => {
    expect(safeFileName('a\u0000b\nc/d\\e')).toBe('a_b_c_d_e');
    expect(safeFileName('   ')).toBe('file');
  });

  it('refuses download lists that do not match the envelope', async () => {
    const env = {
      v: 'v1' as const,
      id: newId(),
      iv: 'A'.repeat(16),
      salt: null,
      ct: 'A'.repeat(64),
      hasPassphrase: false,
      fileIds: [newId()],
    };
    await expect(fetchEncryptedFiles(env.id, env, [])).rejects.toThrow(/match/);
    await expect(
      fetchEncryptedFiles(env.id, env, [{ fileId: newId(), url: 'https://x/y' }]),
    ).rejects.toThrow(/match/);
  });
});

describe('file names', () => {
  it('neutralises bidi overrides, C1 controls and trailing dots', () => {
    expect(safeFileName('report‮txt.exe')).toBe('report_txt.exe');
    expect(safeFileName('a\u0085b')).toBe('a_b');
    expect(safeFileName('name. . ')).toBe('name');
  });
});

describe('per-file attachment decryption', () => {
  it('uses each authenticated payload key; swapped keys, altered ciphertext and ids fail', async () => {
    const id = newId();
    const a = {
      fileId: newId(),
      name: 'a.bin',
      size: 3,
      mime: 'text/plain',
      key: b64urlEncode(newFileKey()),
    };
    const b = { ...a, fileId: newId(), name: 'b.bin', key: b64urlEncode(newFileKey()) };
    const { b64urlDecode } = await import('@brix-share/shared');
    const bytes = new Uint8Array([1, 2, 3]);
    const stored = await Promise.all(
      [a, b].map(async (f) =>
        sealFile(id, f.fileId, await importFileKey(b64urlDecode(f.key)), bytes),
      ),
    );
    const payload = { title: null, text: '', files: [a, b] };
    const good = await decryptFiles(id, payload, stored);
    expect(good.every((f) => f.url !== null)).toBe(true);
    for (const f of good) {
      expect(new Uint8Array(await (await fetch(f.url!)).arrayBuffer())).toEqual(bytes);
      URL.revokeObjectURL(f.url!);
    }
    const swapped = {
      ...payload,
      files: [
        { ...a, key: b.key },
        { ...b, key: a.key },
      ],
    };
    expect((await decryptFiles(id, swapped, stored)).every((f) => f.url === null)).toBe(true);
    expect((await decryptFiles(newId(), payload, stored)).every((f) => f.url === null)).toBe(true);
    expect(
      (await decryptFiles(id, payload, [stored[1]!, stored[0]!])).every((f) => f.url === null),
    ).toBe(true);
    const corrupt = stored.map((s) => {
      const copy = s.slice();
      copy[copy.length - 1]! ^= 1;
      return copy;
    });
    expect((await decryptFiles(id, payload, corrupt)).every((f) => f.url === null)).toBe(true);
  });
});
