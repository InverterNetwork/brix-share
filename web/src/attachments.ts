import {
  FILE_OVERHEAD_BYTES,
  MAX_TOTAL_FILE_BYTES,
  type Envelope,
  type Payload,
} from '@brix-share/shared';
import { OverBudgetError, checkDownloadUrl, downloadFile } from './api.ts';
import { openFile } from './crypto/envelope.ts';

export interface RevealedFile {
  name: string;
  size: number;
  /** Blob URL of the decrypted bytes, or null when the file could not be fetched or decrypted. */
  url: string | null;
}

/** Everything a hostile server could make us read, at most: the cap plus each file's IV and tag. */
const BUDGET = MAX_TOTAL_FILE_BYTES + 10 * FILE_OVERHEAD_BYTES;

/**
 * Fetches the encrypted files right after the consume, while the 2-minute URLs are valid, before any
 * passphrase prompt. Downloads must match the envelope's file ids in order. A failed fetch is retried once
 * (GETs do not count as retrievals) and then reported as null.
 */
export async function fetchEncryptedFiles(
  id: string,
  envelope: Envelope,
  downloads: { fileId: string; url: string }[],
): Promise<(Uint8Array<ArrayBuffer> | null)[]> {
  if (
    downloads.length !== envelope.fileIds.length ||
    downloads.some((d, i) => d.fileId !== envelope.fileIds[i])
  ) {
    throw new Error('downloads do not match the envelope');
  }
  // All requests start at once: the URLs expire 2 minutes after the consume, and S3 checks expiry when a
  // request starts, so sequential downloads on a slow line could run out of time.
  const budget = { remaining: BUDGET };
  return Promise.all(
    downloads.map(async (d) => {
      const url = checkDownloadUrl(d.url, id, d.fileId);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await downloadFile(url, budget);
        } catch (e) {
          // Over budget is final; anything else gets one more try within the URL's lifetime.
          if (e instanceof OverBudgetError) return null;
        }
      }
      return null;
    }),
  );
}

/** Names come from the sender: no path separators or control characters in the download name. */
export function safeFileName(name: string): string {
  const cleaned = name
    // Separators, C0/C1 controls and bidi overrides (which can disguise an extension, e.g. "report<RLO>txt.exe").
    .replace(/[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '_')
    .trim()
    // Trailing dots and spaces are dropped or misread by some file systems.
    .replace(/[. ]+$/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 255) : 'file';
}

/**
 * Decrypts each file and wraps it in a Blob URL typed application/octet-stream (never the declared type, so
 * nothing renders as active content). Length must equal the size inside the authenticated payload.
 */
export async function decryptFiles(
  id: string,
  key: CryptoKey,
  payload: Payload,
  encrypted: (Uint8Array<ArrayBuffer> | null)[],
): Promise<RevealedFile[]> {
  return Promise.all(
    payload.files.map(async (f, i) => {
      const stored = encrypted[i];
      if (!stored) return { name: safeFileName(f.name), size: f.size, url: null };
      try {
        const bytes = await openFile(id, f.fileId, key, stored);
        if (bytes.length !== f.size) return { name: safeFileName(f.name), size: f.size, url: null };
        return {
          name: safeFileName(f.name),
          size: f.size,
          url: URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })),
        };
      } catch {
        return { name: safeFileName(f.name), size: f.size, url: null };
      }
    }),
  );
}

export function revokeFiles(files: RevealedFile[]): void {
  for (const f of files) if (f.url) URL.revokeObjectURL(f.url);
}
