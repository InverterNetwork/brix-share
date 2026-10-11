import { AAD_PREFIX } from './constants.ts';

const enc = new TextEncoder();

/** AAD for the text envelope: binds protocol version, secret id and passphrase mode. */
export function textAad(id: string, hasPassphrase: boolean): Uint8Array<ArrayBuffer> {
  return enc.encode(`${AAD_PREFIX}|${id}|text|${hasPassphrase ? 'p' : 'n'}`);
}

/** AAD for a file envelope: binds protocol version, secret id and file id. */
export function fileAad(id: string, fileId: string): Uint8Array<ArrayBuffer> {
  return enc.encode(`${AAD_PREFIX}|${id}|file|${fileId}`);
}
