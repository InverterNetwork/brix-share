import { randomBytes } from 'node:crypto';
import {
  GetParameterCommand,
  ParameterAlreadyExists,
  ParameterNotFound,
  PutParameterCommand,
  type SSMClient,
} from '@aws-sdk/client-ssm';
import {
  DEFAULT_POW_DIFFICULTY,
  MAX_POW_DIFFICULTY,
  MIN_POW_DIFFICULTY,
  b64urlDecode,
  b64urlEncode,
} from '@brix-share/shared';

/** Runtime settings the API reads from SSM. */
export interface Params {
  createEnabled(): Promise<boolean>;
  powDifficulty(): Promise<number>;
  hmacKey(): Promise<Uint8Array>;
  /** Forgets the cached key and reads it again (after a rotation another container may sign with the new one). */
  reloadHmacKey(): Promise<Uint8Array>;
}

/** The two SSM calls the API makes; a narrow seam so tests can supply an in-memory store. */
export interface ParamStore {
  get(name: string, decrypt: boolean): Promise<string | undefined>;
  /** Creates a SecureString; false if it already exists. */
  createSecure(name: string, value: string): Promise<boolean>;
}

export function ssmStore(ssm: SSMClient): ParamStore {
  return {
    async get(name, decrypt) {
      try {
        const res = await ssm.send(
          new GetParameterCommand({ Name: name, WithDecryption: decrypt }),
        );
        return res.Parameter?.Value;
      } catch (e) {
        if (e instanceof ParameterNotFound || (e as { name?: string }).name === 'ParameterNotFound')
          return undefined;
        throw e;
      }
    },
    async createSecure(name, value) {
      try {
        await ssm.send(
          new PutParameterCommand({
            Name: name,
            Value: value,
            Type: 'SecureString',
            Overwrite: false,
          }),
        );
        return true;
      } catch (e) {
        if (
          e instanceof ParameterAlreadyExists ||
          (e as { name?: string }).name === 'ParameterAlreadyExists'
        )
          return false;
        throw e;
      }
    },
  };
}

const CACHE_MS = 60_000;

export function clampDifficulty(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) return DEFAULT_POW_DIFFICULTY;
  return Math.min(MAX_POW_DIFFICULTY, Math.max(MIN_POW_DIFFICULTY, n));
}

export function cachedParams(
  store: ParamStore,
  prefix: string,
  nowMs: () => number = Date.now,
): Params {
  const cache = new Map<string, { at: number; value: string | undefined }>();
  const read = async (name: string) => {
    const hit = cache.get(name);
    if (hit && nowMs() - hit.at < CACHE_MS) return hit.value;
    const value = await store.get(`${prefix}/${name}`, false);
    cache.set(name, { at: nowMs(), value });
    return value;
  };
  let key: Promise<Uint8Array> | undefined;
  let lastReload = Number.NEGATIVE_INFINITY;

  const loadKey = async (): Promise<Uint8Array> => {
    const name = `${prefix}/powHmacKey`;
    let value = await store.get(name, true);
    if (value === undefined) {
      // First cold start of the stage: provision the key. Overwrite=false makes concurrent cold starts converge.
      await store.createSecure(name, b64urlEncode(randomBytes(32)));
      value = await store.get(name, true);
    }
    if (value === undefined) throw new Error('powHmacKey unavailable');
    const bytes = b64urlDecode(value);
    if (bytes.length < 32) throw new Error('powHmacKey too short');
    return bytes;
  };

  return {
    async createEnabled() {
      return (await read('createEnabled')) !== 'false';
    },
    async powDifficulty() {
      return clampDifficulty(await read('powDifficulty'));
    },
    reloadHmacKey() {
      // At most once a minute per container: bad signatures from clients must not turn into SSM traffic.
      if (nowMs() - lastReload >= CACHE_MS) {
        lastReload = nowMs();
        key = undefined;
      }
      return this.hmacKey();
    },
    hmacKey() {
      key ??= loadKey().catch((e: unknown) => {
        key = undefined;
        throw e;
      });
      return key;
    },
  };
}
