import { createHash } from 'node:crypto';
import type { Envelope } from '@brix-share/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateBody } from '../src/api.ts';

vi.mock('../src/pow/solve.ts', async () => {
  const { solvePow } = await import('../src/pow/solver.ts');
  return {
    PowCancelled: class extends Error {},
    solveInWorker: (challenge: string, difficulty: number) => ({
      result: Promise.resolve(solvePow(challenge, difficulty)),
      cancel: () => undefined,
    }),
  };
});

const {
  ApiError,
  NetworkError,
  consumeSecret,
  getAvailability,
  createSecret,
  deleteSecret,
  getStatus,
  serverNow,
} = await import('../src/api.ts');

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const challenge = (n: number) => `v1.1800000600.4.${String(n).padStart(22, 'A')}.${'B'.repeat(43)}`;

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

let calls: Call[];
let replies: (() => Response | Promise<Response>)[];

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      date: 'Fri, 09 Oct 2026 12:00:00 GMT',
      ...headers,
    },
  });

beforeEach(() => {
  calls = [];
  replies = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({
      method: init.method ?? 'GET',
      url,
      headers: init.headers as Record<string, string>,
      body: (init.body as string | null) ?? null,
    });
    const next = replies.shift();
    if (!next) throw new Error('unexpected fetch');
    return Promise.resolve(next());
  });
});
afterEach(() => vi.unstubAllGlobals());

const envelope: Envelope = {
  v: 'v1',
  id: ID,
  iv: 'AAAAAAAAAAAAAAAA',
  salt: null,
  ct: 'A'.repeat(64),
  hasPassphrase: false,
  fileIds: [],
};
const body = (now: number): CreateBody => ({
  envelope,
  policy: {
    maxViews: 1,
    expiresAt: new Date((now + 3600) * 1000).toISOString(),
    availableFrom: null,
  },
  manageTokenHash: 'a'.repeat(64),
  consumeTokenHash: 'b'.repeat(64),
  files: [],
});

describe('api client', () => {
  it('availability sends the consume capability only in its header', async () => {
    replies.push(() => json(200, { availableFrom: null }));
    expect(await getAvailability(ID, 'consume-token')).toEqual({ kind: 'ready' });
    expect(calls[0]).toMatchObject({ method: 'GET', url: `/api/secrets/${ID}`, body: null });
    expect(calls[0]!.headers['x-consume-token']).toBe('consume-token');
  });
  it('sends the body hash on every request and derives server time from Date', async () => {
    replies.push(() => json(404, { error: 'not_found', message: 'x' }));
    expect(await consumeSecret(ID, 'consume-token')).toEqual({ kind: 'not_found' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/secrets/${ID}/consume`,
      body: null,
    });
    expect(calls[0]!.headers['x-consume-token']).toBe('consume-token');
    expect(calls[0]!.headers['x-amz-content-sha256']).toBe(sha(''));
    expect(Math.abs(serverNow() - Date.parse('Fri, 09 Oct 2026 12:00:00 GMT') / 1000)).toBeLessThan(
      5,
    );
  });

  it('creates: challenge, proof-of-work, body built after the work with the server clock, hash of the exact body', async () => {
    replies.push(() =>
      json(200, { challenge: challenge(1), difficulty: 4, expiresAt: '2027-01-01T00:10:00.000Z' }),
    );
    replies.push(() =>
      json(201, {
        id: ID,
        expiresAt: '2027-01-01T01:00:00.000Z',
        availableFrom: null,
        maxViews: 1,
        uploads: [],
      }),
    );
    const res = await createSecret(body);
    expect(res.id).toBe(ID);
    const post = calls[1]!;
    expect(post.headers['x-amz-content-sha256']).toBe(sha(post.body!));
    expect(post.headers['content-type']).toBe('application/json');
    const sent = JSON.parse(post.body!) as { pow: { challenge: string; nonce: string } };
    expect(sent.pow.challenge).toBe(challenge(1));
    expect(sent.pow.nonce).toMatch(/^\d+$/);
  });

  it('retries invalid_pow exactly once with a fresh challenge', async () => {
    replies.push(() =>
      json(200, { challenge: challenge(1), difficulty: 4, expiresAt: '2027-01-01T00:10:00.000Z' }),
    );
    replies.push(() => json(400, { error: 'invalid_pow', message: 'difficulty too low' }));
    replies.push(() =>
      json(200, { challenge: challenge(2), difficulty: 4, expiresAt: '2027-01-01T00:10:00.000Z' }),
    );
    replies.push(() => json(400, { error: 'invalid_pow', message: 'difficulty too low' }));
    await expect(createSecret(body)).rejects.toMatchObject({ code: 'invalid_pow' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET', 'POST']);
  });

  it('maps other create errors without retrying', async () => {
    replies.push(() =>
      json(200, { challenge: challenge(1), difficulty: 4, expiresAt: '2027-01-01T00:10:00.000Z' }),
    );
    replies.push(() => json(503, { error: 'create_disabled', message: 'Paused.' }));
    await expect(createSecret(body)).rejects.toMatchObject({
      code: 'create_disabled',
      message: 'Paused.',
      status: 503,
    });
    expect(calls).toHaveLength(2);
  });

  it('consume: 425 parsed, schema-checked 200, never retried on network failure', async () => {
    replies.push(() =>
      json(425, { error: 'too_early', message: 'x', availableFrom: '2027-01-01T00:00:00.000Z' }),
    );
    expect(await consumeSecret(ID, 'consume-token')).toEqual({
      kind: 'too_early',
      availableFrom: '2027-01-01T00:00:00.000Z',
    });

    replies.push(() =>
      json(200, {
        envelope,
        policy: { viewsRemaining: 0, expiresAt: '2027-01-01T00:00:00.000Z' },
        downloads: [],
      }),
    );
    expect((await consumeSecret(ID, 'consume-token')).kind).toBe('ok');

    replies.push(() =>
      json(200, {
        envelope: { ...envelope, extra: 1 },
        policy: { viewsRemaining: 0, expiresAt: 'x' },
        downloads: [],
      }),
    );
    await expect(consumeSecret(ID, 'consume-token')).rejects.toMatchObject({ code: 'unexpected' });

    replies.push(() => Promise.reject(new TypeError('Failed to fetch')));
    const before = calls.length;
    await expect(consumeSecret(ID, 'consume-token')).rejects.toBeInstanceOf(NetworkError);
    expect(calls.length - before).toBe(1);

    replies.push(() => json(500, { error: 'internal', message: 'x' }));
    await expect(consumeSecret(ID, 'consume-token')).rejects.toBeInstanceOf(ApiError);
  });

  it('status and delete send the manage token header, 404 means nothing found', async () => {
    replies.push(() => json(404, { error: 'not_found', message: 'x' }));
    expect(await getStatus(ID, 'tok')).toBeNull();
    expect(calls[0]!.headers['x-manage-token']).toBe('tok');
    replies.push(() => new Response(null, { status: 204 }));
    expect(await deleteSecret(ID, 'tok')).toBe(true);
    expect(calls[1]).toMatchObject({ method: 'DELETE' });
    expect(calls[1]!.headers['x-amz-content-sha256']).toBe(sha(''));
    replies.push(() => json(404, { error: 'not_found', message: 'x' }));
    expect(await deleteSecret(ID, 'tok')).toBe(false);
  });
});

describe('bounded reads', () => {
  it('refuses an oversized API response before parsing it', async () => {
    const huge = JSON.stringify({ error: 'not_found', message: 'x'.repeat(600 * 1024) });
    replies.push(
      () => new Response(huge, { status: 500, headers: { 'content-type': 'application/json' } }),
    );
    await expect(consumeSecret(ID, 'consume-token')).rejects.toMatchObject({ code: 'unexpected' });
  });

  it('shares one byte budget across downloads and cancels on overflow', async () => {
    const { downloadFile } = await import('../src/api.ts');
    const budget = { remaining: 10 };
    replies.push(() => new Response(new Uint8Array(6)));
    replies.push(() => new Response(new Uint8Array(6)));
    expect((await downloadFile(new URL('https://b.example/x/y'), budget)).length).toBe(6);
    await expect(downloadFile(new URL('https://b.example/x/z'), budget)).rejects.toMatchObject({
      code: 'unexpected',
    });
  });
});
