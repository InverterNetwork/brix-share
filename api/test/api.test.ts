import { createHash, randomBytes } from 'node:crypto';
import {
  b64urlEncode,
  DAY,
  HOUR,
  MINUTE,
  StatusResponseSchema,
  ConsumeResponseSchema,
  CreateResponseSchema,
  ChallengeResponseSchema,
  securityHeaders,
} from '@brix-share/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { solve } from '../src/pow.ts';
import { FILES_ORIGIN, T0, makeApi } from './harness.ts';

type Api = Awaited<ReturnType<typeof makeApi>>;
let api: Api;
beforeAll(async () => {
  api = await makeApi();
});
afterEach(() => {
  api.clock.now = T0;
  api.store.values.set('/t/createEnabled', 'true');
  api.store.values.set('/t/powDifficulty', '8');
});

const consume = (id: string, country = 'DE') =>
  api.call('POST', `/api/secrets/${id}/consume`, {
    headers: { 'cloudfront-viewer-country': country },
  });
const status = (id: string, token: string) =>
  api.call('GET', `/api/secrets/${id}/status`, { headers: { 'x-manage-token': token } });
const del = (id: string, token: string) =>
  api.call('DELETE', `/api/secrets/${id}`, { headers: { 'x-manage-token': token } });

describe('routing and headers', () => {
  it('health answers 200 with no details', async () => {
    const r = await api.call('GET', '/api/health');
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('');
  });

  it('unknown routes, wrong methods and malformed ids are 404', async () => {
    for (const [m, p] of [
      ['GET', '/api/nope'],
      ['POST', '/api/health'],
      ['GET', '/api/secrets'],
      ['PUT', '/api/secrets'],
      ['GET', '/api/secrets/AAAAAAAAAAAAAAAAAAAAAA/consume'],
      ['POST', '/api/secrets/short/consume'],
      ['POST', '/api/secrets/AAAAAAAAAAAAAAAAAAAAAB/consume'],
      ['DELETE', '/api/secrets/AAAAAAAAAAAAAAAAAAAAAA/status'],
    ] as const) {
      const r = await api.call(m, p);
      expect(r.statusCode, `${m} ${p}`).toBe(404);
      expect(r.json).toEqual({ error: 'not_found', message: expect.any(String) });
    }
  });

  it('every response carries no-store and the security headers', async () => {
    for (const r of [
      await api.call('GET', '/api/health'),
      await api.call('GET', '/api/nope'),
      await api.call('GET', '/api/challenge'),
    ]) {
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers).toMatchObject(securityHeaders(FILES_ORIGIN));
    }
  });

  it('rejects bodies over 128 KB with 413, also when base64-encoded', async () => {
    const big = 'x'.repeat(128 * 1024 + 1);
    expect((await api.call('POST', '/api/secrets', { body: big })).statusCode).toBe(413);
    const { handle } = await import('../src/app.ts');
    const r = await handle(api.deps, {
      rawPath: '/api/secrets',
      requestContext: { http: { method: 'POST' } },
      body: Buffer.from(big).toString('base64'),
      isBase64Encoded: true,
    });
    expect(r.statusCode).toBe(413);
  });
});

describe('challenge and create', () => {
  it('challenge response matches the shared schema and expires in 10 minutes', async () => {
    const r = await api.call('GET', '/api/challenge');
    const c = ChallengeResponseSchema.parse(r.json);
    expect(c.difficulty).toBe(8);
    expect(c.expiresAt).toBe(new Date((T0 + 10 * MINUTE) * 1000).toISOString());
  });

  it('creates with 201 and the shared response shape', async () => {
    const { id, res } = await api.create({ maxViews: 3 });
    expect(res.statusCode).toBe(201);
    expect(CreateResponseSchema.parse(res.json)).toMatchObject({
      id,
      maxViews: 3,
      availableFrom: null,
      uploads: [],
    });
  });

  it('rejects malformed JSON and invalid bodies with 400', async () => {
    expect((await api.call('POST', '/api/secrets', { body: '{nope' })).json).toMatchObject({
      error: 'invalid_request',
    });
    expect((await api.call('POST', '/api/secrets', { body: { envelope: {} } })).json).toMatchObject(
      { error: 'invalid_request' },
    );
  });

  it('blocks replayed challenges', async () => {
    const first = await api.create();
    expect(first.res.statusCode).toBe(201);
    const replay = await api.call('POST', '/api/secrets', {
      body: {
        ...first.body,
        envelope: { ...first.body.envelope, id: b64urlEncode(randomBytes(16)) },
      },
    });
    expect(replay.json).toMatchObject({ error: 'invalid_pow', message: 'challenge already used' });
  });

  it('rejects wrong or insufficient proof-of-work and difficulty raised after issue', async () => {
    const first = await api.create();
    const ch = await api.call('GET', '/api/challenge');
    const challenge = ch.json!.challenge as string;
    const fresh = () => ({ ...first.body.envelope, id: b64urlEncode(randomBytes(16)) });
    let bad = 0;
    const { verifySolution } = await import('../src/pow.ts');
    const key = await api.deps.params.hmacKey();
    while (verifySolution(key, challenge, String(bad), 8, T0).ok) bad++;
    const r1 = await api.call('POST', '/api/secrets', {
      body: { ...first.body, envelope: fresh(), pow: { challenge, nonce: String(bad) } },
    });
    expect(r1.json).toMatchObject({ error: 'invalid_pow' });

    api.store.values.set('/t/powDifficulty', '12');
    const r2 = await api.call('POST', '/api/secrets', {
      body: { ...first.body, envelope: fresh(), pow: { challenge, nonce: solve(challenge, 8) } },
    });
    expect(r2.json).toMatchObject({ error: 'invalid_pow', message: 'difficulty too low' });
    api.store.values.set('/t/powDifficulty', '8');
  });

  it('rejects expired challenges', async () => {
    const ch = await api.call('GET', '/api/challenge');
    const challenge = ch.json!.challenge as string;
    const { body } = await api.create();
    api.clock.now += 10 * MINUTE;
    const r = await api.call('POST', '/api/secrets', {
      body: {
        ...body,
        envelope: { ...body.envelope, id: b64urlEncode(randomBytes(16)) },
        pow: { challenge, nonce: solve(challenge, 8) },
        policy: { ...body.policy },
      },
    });
    api.clock.now = T0;
    expect(r.json).toMatchObject({ error: 'invalid_pow', message: 'challenge expired' });
  });

  it('returns 409 on id collision', async () => {
    const first = await api.create();
    const ch = await api.call('GET', '/api/challenge');
    const challenge = ch.json!.challenge as string;
    const r = await api.call('POST', '/api/secrets', {
      body: { ...first.body, pow: { challenge, nonce: solve(challenge, 8) } },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json).toMatchObject({ error: 'id_conflict' });
  });

  it('circuit breaker returns 503', async () => {
    api.store.values.set('/t/createEnabled', 'false');
    const r = await api.create();
    api.store.values.set('/t/createEnabled', 'true');
    expect(r.res.statusCode).toBe(503);
    expect(r.res.json).toMatchObject({ error: 'create_disabled' });
  });

  it('provisions the HMAC key once and reuses it', async () => {
    const key = api.store.values.get('/t/powHmacKey');
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await api.create();
    expect(api.store.values.get('/t/powHmacKey')).toBe(key);
  });
});

describe('consume', () => {
  it('burn after reading: first consume returns the envelope, then 404, tombstone recorded', async () => {
    const { id, token, body } = await api.create();
    const r = await consume(id);
    expect(r.statusCode).toBe(200);
    const parsed = ConsumeResponseSchema.parse(r.json);
    expect(parsed.envelope).toEqual(body.envelope);
    expect(parsed.policy.viewsRemaining).toBe(0);
    expect((await consume(id)).statusCode).toBe(404);

    const item = await api.repo.get(id);
    expect(item).toMatchObject({
      status: 'ended',
      endedReason: 'consumed',
      endedAt: T0,
      purgeAt: T0 + 30 * DAY,
      viewsRemaining: 0,
    });
    expect(item!.envelope).toBeUndefined();
    const s = StatusResponseSchema.parse((await status(id, token)).json);
    expect(s).toMatchObject({
      status: 'ended',
      endedReason: 'consumed',
      retrievals: [{ country: 'DE' }],
    });
    expect(s.expiresAt).toBe(body.policy.expiresAt);
  });

  it('N views: exactly N consumes succeed', async () => {
    const { id } = await api.create({ maxViews: 3 });
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await consume(id)).statusCode);
    expect(results).toEqual([200, 200, 200, 404, 404]);
  });

  it('unlimited until expiry, retrieval log capped at 100', async () => {
    const { id, token } = await api.create({ maxViews: null });
    for (let i = 0; i < 102; i++) {
      const r = await consume(id);
      expect(r.statusCode).toBe(200);
      expect((r.json!.policy as { viewsRemaining: unknown }).viewsRemaining).toBeNull();
    }
    const s = StatusResponseSchema.parse((await status(id, token)).json);
    expect(s.retrievals).toHaveLength(100);
    expect(s.status).toBe('ready');
  });

  it('expiry boundary: retrievable before expiresAt, 404 at exactly expiresAt, tombstoned before TTL', async () => {
    const { id, token } = await api.create({ maxViews: null, lifetime: HOUR });
    api.clock.now = T0 + HOUR - 1;
    expect((await consume(id)).statusCode).toBe(200);
    api.clock.now = T0 + HOUR;
    expect((await consume(id)).statusCode).toBe(404);
    const item = await api.repo.get(id);
    expect(item).toMatchObject({
      status: 'ended',
      endedReason: 'expired',
      endedAt: T0 + HOUR,
      expiresAt: T0 + HOUR,
      purgeAt: T0 + HOUR + 30 * DAY,
    });
    const s = StatusResponseSchema.parse((await status(id, token)).json);
    expect(s.endedReason).toBe('expired');
    api.clock.now = T0;
  });

  it('release later: 425 before availableFrom with the date, 200 from then on', async () => {
    const { id } = await api.create({ availableIn: 2 * HOUR });
    const early = await consume(id);
    expect(early.statusCode).toBe(425);
    expect(early.json).toMatchObject({
      error: 'too_early',
      availableFrom: new Date((T0 + 2 * HOUR) * 1000).toISOString(),
    });
    api.clock.now = T0 + 2 * HOUR;
    expect((await consume(id)).statusCode).toBe(200);
    api.clock.now = T0;
  });

  it('pending items are not retrievable', async () => {
    const { id } = await api.create();
    await api.db.send(
      new (await import('@aws-sdk/lib-dynamodb')).UpdateCommand({
        TableName: api.table,
        Key: { pk: `S#${id}` },
        UpdateExpression: 'SET #s = :p',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':p': 'pending' },
      }),
    );
    expect((await consume(id)).statusCode).toBe(404);
  });

  it('unknown ids are indistinguishable from consumed ones', async () => {
    const r = await consume(b64urlEncode(randomBytes(16)));
    expect(r.statusCode).toBe(404);
    const { id } = await api.create();
    await consume(id);
    expect((await consume(id)).json).toEqual(r.json);
  });

  it('normalises the viewer country', async () => {
    const { id, token } = await api.create({ maxViews: 3 });
    await consume(id, 'de');
    await api.call('POST', `/api/secrets/${id}/consume`);
    const s = StatusResponseSchema.parse((await status(id, token)).json);
    expect(s.retrievals.map((r) => r.country)).toEqual(['XX', 'XX']);
  });
});

describe('status and delete', () => {
  it('status requires the right token and never consumes', async () => {
    const { id, token } = await api.create({ maxViews: 2 });
    const ok = await status(id, token);
    expect(ok.statusCode).toBe(200);
    expect(StatusResponseSchema.parse(ok.json)).toMatchObject({
      status: 'ready',
      viewsRemaining: 2,
      maxViews: 2,
      retrievals: [],
      historyUntil: null,
    });
    expect((await status(id, b64urlEncode(randomBytes(32)))).statusCode).toBe(404);
    expect((await api.call('GET', `/api/secrets/${id}/status`)).statusCode).toBe(404);
    expect((await status(id, 'short')).statusCode).toBe(404);
    expect((await status(id, token)).json).toMatchObject({ viewsRemaining: 2 });
  });

  it('wrong token and missing item look the same', async () => {
    const { id } = await api.create();
    const wrong = await status(id, b64urlEncode(randomBytes(32)));
    const missing = await status(b64urlEncode(randomBytes(16)), b64urlEncode(randomBytes(32)));
    expect(wrong.json).toEqual(missing.json);
  });

  it('delete with the right token tombstones with reason deleted', async () => {
    const { id, token } = await api.create();
    expect((await del(id, b64urlEncode(randomBytes(32)))).statusCode).toBe(404);
    expect((await del(id, token)).statusCode).toBe(204);
    expect((await consume(id)).statusCode).toBe(404);
    const s = StatusResponseSchema.parse((await status(id, token)).json);
    expect(s).toMatchObject({
      status: 'ended',
      endedReason: 'deleted',
      historyUntil: new Date((T0 + 30 * DAY) * 1000).toISOString(),
    });
    expect((await del(id, token)).statusCode).toBe(404);
    expect((await api.repo.get(id))!.envelope).toBeUndefined();
  });

  it('delete of a missing item is 404', async () => {
    expect(
      (await del(b64urlEncode(randomBytes(16)), b64urlEncode(randomBytes(32)))).statusCode,
    ).toBe(404);
  });

  it('delete after expiry records expired and answers 204', async () => {
    const { id, token } = await api.create({ lifetime: HOUR });
    api.clock.now = T0 + 2 * HOUR;
    expect((await del(id, token)).statusCode).toBe(204);
    expect(StatusResponseSchema.parse((await status(id, token)).json).endedReason).toBe('expired');
    api.clock.now = T0;
  });

  it('manage token hash is stored, never the token', async () => {
    const { id, token } = await api.create();
    const item = await api.repo.get(id);
    expect(item!.deleteTokenHash).toBe(
      createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex'),
    );
    expect(JSON.stringify(item)).not.toContain(token);
  });
});

describe('availability', () => {
  const peek = (id: string) => api.call('GET', `/api/secrets/${id}`);

  it('answers without counting a retrieval, then 404 once the secret ended', async () => {
    const { id, token } = await api.create({ maxViews: 1 });
    for (let i = 0; i < 3; i++) {
      const r = await peek(id);
      expect(r.statusCode).toBe(200);
      expect(r.json).toEqual({ availableFrom: null });
    }
    const s = StatusResponseSchema.parse((await status(id, token)).json);
    expect(s.retrievalCount).toBe(0);
    expect((await consume(id)).statusCode).toBe(200);
    const gone = await peek(id);
    expect(gone.statusCode).toBe(404);
    expect(gone.json).toEqual((await peek(b64urlEncode(randomBytes(16)))).json);
  });

  it('reports the release time before it, null after', async () => {
    const { id } = await api.create({ availableIn: 2 * HOUR });
    expect((await peek(id)).json).toEqual({
      availableFrom: new Date((T0 + 2 * HOUR) * 1000).toISOString(),
    });
    api.clock.now = T0 + 2 * HOUR;
    expect((await peek(id)).json).toEqual({ availableFrom: null });
  });

  it('is 404 for a pending secret whose files are not finalized', async () => {
    const { id } = await api.create();
    await api.db.send(
      new (await import('@aws-sdk/lib-dynamodb')).UpdateCommand({
        TableName: api.table,
        Key: { pk: `S#${id}` },
        UpdateExpression: 'SET #s = :p',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':p': 'pending' },
      }),
    );
    expect((await peek(id)).statusCode).toBe(404);
  });

  it('is 404 after delete and after expiry, even before the sweeper ran', async () => {
    const a = await api.create();
    expect((await del(a.id, a.token)).statusCode).toBe(204);
    expect((await peek(a.id)).statusCode).toBe(404);
    const b = await api.create({ lifetime: HOUR });
    api.clock.now = T0 + HOUR;
    expect((await peek(b.id)).statusCode).toBe(404);
  });
});
