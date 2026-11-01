import { b64urlDecode, bytesToHex } from './b64url.ts';
import { KEY_BYTES } from './constants.ts';

/** SHA-256 hex of the raw consume capability, never its base64url encoding. */
export async function hashConsumeToken(token: string): Promise<string> {
  const bytes = b64urlDecode(token);
  if (bytes.length !== KEY_BYTES) throw new Error('invalid consume token');
  return bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
}
