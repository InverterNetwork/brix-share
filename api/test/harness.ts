import { randomBytes } from 'node:crypto';
import { b64urlEncode, hashManageToken, secToIso, DAY } from '@brix-share/shared';
import { inject } from 'vitest';
import { handle } from '../src/app.ts';
import type { Deps } from '../src/deps.ts';
import { Responder, type FunctionUrlEvent } from '../src/http.ts';
import { cachedParams, type ParamStore } from '../src/params.ts';
import { solve } from '../src/pow.ts';
import { createSecretsTable } from './table.ts';
import { MemoryStore as FileMemoryStore } from '../src/files.ts';
import { Repo, documentClients } from '../src/repo.ts';

export const T0 = 1_800_000_000;
export const FILES_ORIGIN = 'https://files-bucket.s3.eu-central-1.amazonaws.com';

export class MemoryStore implements ParamStore {
  values = new Map<string, string>();
  get(name: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(name));
  }
  createSecure(name: string, value: string): Promise<boolean> {
    if (this.values.has(name)) return Promise.resolve(false);
    this.values.set(name, value);
    return Promise.resolve(true);
  }
}

export async function makeApi(opts: { difficulty?: number } = {}) {
  const clients = documentClients(inject('ddbEndpoint'));
  const db = clients.read;
  const table = `t${randomBytes(6).toString('hex')}`;
  await createSecretsTable(db, table);

  const store = new MemoryStore();
  store.values.set('/t/powDifficulty', String(opts.difficulty ?? 8));
  store.values.set('/t/createEnabled', 'true');
  const clock = { now: T0 };
  let paramClock = 0;
  const repo = new Repo(clients, table);
  const files = new FileMemoryStore('https://files.test.invalid', () => clock.now);
  const deps: Deps = {
    repo,
    files,
    // A clock that jumps a minute per read disables the parameter cache, so tests can flip parameters.
    params: cachedParams(store, '/t', () => (paramClock += 61_000)),
    http: new Responder(FILES_ORIGIN),
    now: () => clock.now,
  };

  const call = async (
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const event: FunctionUrlEvent = {
      rawPath: path,
      requestContext: { http: { method } },
      headers: init.headers ?? {},
      ...(init.body === undefined
        ? {}
        : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
    };
    const res = await handle(deps, event);
    return {
      ...res,
      json: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : undefined,
    };
  };

  /** Creates a secret through the API like a client would. */
  const create = async (
    policy: { maxViews?: number | null; lifetime?: number; availableIn?: number | null } = {},
  ) => {
    const id = b64urlEncode(randomBytes(16));
    const token = b64urlEncode(randomBytes(32));
    const ch = await call('GET', '/api/challenge');
    const challenge = ch.json!.challenge as string;
    const nonce = solve(challenge, ch.json!.difficulty as number);
    const body = {
      envelope: {
        v: 'v1',
        id,
        iv: b64urlEncode(randomBytes(12)),
        salt: null,
        ct: b64urlEncode(randomBytes(48)),
        hasPassphrase: false,
        fileIds: [],
      },
      policy: {
        maxViews: policy.maxViews === undefined ? 1 : policy.maxViews,
        expiresAt: secToIso(clock.now + (policy.lifetime ?? 7 * DAY)),
        availableFrom: policy.availableIn == null ? null : secToIso(clock.now + policy.availableIn),
      },
      manageTokenHash: await hashManageToken(token),
      pow: { challenge, nonce },
      files: [],
    };
    const res = await call('POST', '/api/secrets', { body });
    return { id, token, body, res };
  };

  return { deps, repo, store, clock, call, create, table, db, clients, files };
}
