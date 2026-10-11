import { b64urlDecode, bytesToHex } from './b64url.ts';
import { MANAGE_TOKEN_BYTES } from './constants.ts';

/**
 * `deleteTokenHash` = hex SHA-256 over the 32 raw token bytes (not over the base64url string), PLAN section 6.
 * Shared by the client (computes it at create) and the API (compares it on status and delete).
 * Throws on a malformed token.
 */
export async function hashManageToken(token: string): Promise<string> {
  const bytes = b64urlDecode(token);
  if (bytes.length !== MANAGE_TOKEN_BYTES) throw new Error('invalid manage token');
  return bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
}
