import { describe, expect, it } from 'vitest';
import { decryptFiles, fetchEncryptedFiles, safeFileName } from '../src/attachments.ts';
import { deriveKey, newId, newLinkKey, sealFile } from '../src/crypto/envelope.ts';

describe('attachments', () => {
  it('decrypts to octet-stream blobs, refuses a size that differs from the payload, keeps names safe', async () => {
    const id = newId();
    const key = await deriveKey(newLinkKey(), null, null);
    const [a, b] = [newId(), newId()];
    const good = await sealFile(id, a, key, new Uint8Array([1, 2, 3]));
    const short = await sealFile(id, b, key, new Uint8Array([1, 2]));
    const files = await decryptFiles(
      id,
      key,
      {
        title: null,
        text: '',
        files: [
          { fileId: a, name: '../../etc/passwd', size: 3, mime: 'text/html' },
          { fileId: b, name: 'b.txt', size: 3, mime: 'text/plain' },
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
