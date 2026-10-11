import {
  MAX_FILES,
  MAX_PAYLOAD_BYTES,
  MAX_TEXT_BYTES,
  MAX_TOTAL_FILE_BYTES,
  b64urlEncode,
  hashManageToken,
  type CreateResponse,
  type Payload,
} from '@brix-share/shared';
import { createSecret, finalizeSecret, uploadFile, type CreateHooks } from './api.ts';
import {
  deriveKey,
  newId,
  newLinkKey,
  newManageToken,
  newSalt,
  sealFile,
  sealText,
} from './crypto/envelope.ts';
import { policyOf, type PolicyForm } from './policy.ts';

const enc = new TextEncoder();

export interface CreatedSecret {
  id: string;
  shareUrl: string;
  manageUrl: string;
  /** Kept only to hand the manage page its token without putting it in the URL bar. */
  manageToken: string;
  passphrase: string | null;
  title: string | null;
  fileCount: number;
  response: CreateResponse;
}

export function textBytes(text: string): number {
  return enc.encode(text).length;
}

/** Metadata of an attachment as it goes into the encrypted payload (names and types never leave it). */
export function fileMeta(
  fileId: string,
  file: { name: string; size: number; type: string },
): Payload['files'][number] {
  return {
    fileId,
    name: file.name.slice(0, 255),
    size: file.size,
    mime: (file.type || 'application/octet-stream').slice(0, 255),
  };
}

/** Serialized payload size, the figure the ciphertext cap actually limits. */
export function payloadBytes(
  title: string | null,
  text: string,
  files: Payload['files'] = [],
): number {
  return enc.encode(JSON.stringify({ title, text, files })).length;
}

export function checkFiles(files: { size: number }[]): string | null {
  if (files.length > MAX_FILES) return `At most ${MAX_FILES} files.`;
  if (files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_FILE_BYTES)
    return 'Files are larger than 25 MB in total.';
  return null;
}

export function checkContent(
  title: string | null,
  text: string,
  files: Payload['files'] = [],
): string | null {
  if (text.length === 0 && files.length === 0)
    return 'Write or paste the secret, or attach a file.';
  const fileProblem = checkFiles(files);
  if (fileProblem) return fileProblem;
  if (textBytes(text) > MAX_TEXT_BYTES) return 'The secret is larger than 64 KB.';
  if (payloadBytes(title, text, files) > MAX_PAYLOAD_BYTES)
    return 'The secret is too large once encoded. Shorten it a little.';
  return null;
}

/** Uploading or finalizing the files failed; the pending secret is never shared and gets swept. */
export class UploadFailed extends Error {
  constructor() {
    super('upload failed');
    this.name = 'UploadFailed';
  }
}

export interface FileHooks {
  /** Progress through the attachments: index of the file being uploaded and the count. */
  onUploading?: (index: number, count: number) => void;
}

/**
 * Encrypts in the browser, solves the proof-of-work and creates the secret. Keys and plaintext never leave
 * this function except as the two links returned to the creator.
 */
export async function createFlow(
  input: {
    title: string | null;
    text: string;
    form: PolicyForm;
    passphrase: string | null;
    files?: File[];
  },
  hooks: CreateHooks & FileHooks = {},
): Promise<CreatedSecret> {
  const id = newId();
  const kLink = newLinkKey();
  const salt = input.passphrase ? newSalt() : null;
  const manageToken = newManageToken();
  const key = await deriveKey(kLink, input.passphrase, salt);
  // Files are encrypted whole in memory (25 MB cap), each with a fresh IV, before anything is sent.
  const attachments = await Promise.all(
    (input.files ?? []).map(async (file) => {
      const fileId = newId();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const stored = await sealFile(id, fileId, key, bytes);
      // The size of what was read, not File.size: the file may have changed on disk since it was picked.
      return {
        meta: fileMeta(fileId, { name: file.name, type: file.type, size: bytes.length }),
        stored,
      };
    }),
  );
  const envelope = await sealText({
    id,
    key,
    salt,
    payload: { title: input.title, text: input.text, files: attachments.map((a) => a.meta) },
  });
  const manageTokenHash = await hashManageToken(manageToken);

  const response = await createSecret(
    (now) => ({
      envelope,
      policy: policyOf(input.form, now),
      manageTokenHash,
      files: attachments.map((a) => ({ fileId: a.meta.fileId, size: a.meta.size })),
    }),
    hooks,
  );
  if (attachments.length > 0) {
    // Until finalize confirms every upload the secret stays pending: not retrievable, swept after an hour.
    try {
      for (const [i, a] of attachments.entries()) {
        hooks.onUploading?.(i, attachments.length);
        const target = response.uploads.find((u) => u.fileId === a.meta.fileId);
        if (!target) throw new Error('upload target missing');
        await uploadFile(target.url, a.stored);
      }
      await finalizeSecret(id, manageToken);
    } catch {
      throw new UploadFailed();
    }
  }
  const origin = location.origin;
  return {
    id,
    shareUrl: `${origin}/s/${id}#${b64urlEncode(kLink)}`,
    manageUrl: `${origin}/m/${id}#${manageToken}`,
    manageToken,
    passphrase: input.passphrase,
    title: input.title,
    fileCount: attachments.length,
    response,
  };
}
