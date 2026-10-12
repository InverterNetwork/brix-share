import { timingSafeEqual } from 'node:crypto';
import {
  MANAGE_TOKEN_BYTES,
  KEY_BYTES,
  CONSUME_TOKEN_HEADER,
  hashConsumeToken,
  MANAGE_TOKEN_HEADER,
  hashManageToken,
  isB64urlOfLength,
} from '@brix-share/shared';
import { header, type FunctionUrlEvent } from './http.ts';

/** `deleteTokenHash` form of a well-formed manage token from the request (shared rule), or undefined. */
export async function manageTokenHash(event: FunctionUrlEvent): Promise<string | undefined> {
  const token = header(event, MANAGE_TOKEN_HEADER);
  if (!token || !isB64urlOfLength(token, MANAGE_TOKEN_BYTES)) return undefined;
  return hashManageToken(token);
}

export async function consumeTokenHash(event: FunctionUrlEvent): Promise<string | undefined> {
  const token = header(event, CONSUME_TOKEN_HEADER);
  if (!token || !isB64urlOfLength(token, KEY_BYTES)) return undefined;
  return hashConsumeToken(token);
}

export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
