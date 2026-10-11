import { randomBytes } from 'node:crypto';
import { DAY, HOUR, b64urlEncode, hashManageToken, secToIso } from '@brix-share/shared';
import { describe, expect, it } from 'vitest';
import { cachedParams } from '../src/params.ts';
import { issueChallenge, solve } from '../src/pow.ts';
import { T0, makeApi } from './harness.ts';

type Api = Awaited<ReturnType<typeof makeApi>>;

async function withFiles(api: Api, size: number) {
  const id = b64urlEncode(randomBytes(16));
  const token = b64urlEncode(randomBytes(32));
  const fileId = b64urlEncode(randomBytes(16));
  const ch = await api.call('GET', '/api/challenge');
  const challenge = ch.json!.challenge as string;
  const res = await api.call('POST', '/api/secrets', {
    body: {
      envelope: {
        v: 'v1',
        id,
        iv: b64urlEncode(randomBytes(12)),
        salt: null,
        ct: b64urlEncode(randomBytes(64)),
        hasPassphrase: false,
        fileIds: [fileId],
      },
      policy: { maxViews: 1, expiresAt: secToIso(T0 + 3 * HOUR), availableFrom: null },
      manageTokenHash: await hashManageToken(token),
      pow: { challenge, nonce: solve(challenge, 8) },
      files: [{ fileId, size }],
    },
  });
  const url = new URL((res.json!.uploads as { url: string }[])[0]!.url);
  api.files.handle(
    'PUT',
    url.pathname.slice(1),
    url.searchParams.get('token'),
    new Uint8Array(size + 28),
  );
  return { id, token };
}

describe('sweep index and purge TTL as written by the API', () => {
  it('text-only create: live partition at expiry, purge 30 days after expiry; ending removes it from the index', async () => {
    const api = await makeApi();
    const a = await api.create({ maxViews: 1, lifetime: DAY });
    expect(await api.repo.get(a.id)).toMatchObject({
      sweepPart: 'live',
      sweepAt: T0 + DAY,
      purgeAt: T0 + DAY + 30 * DAY,
      expiresAt: T0 + DAY,
    });
    await api.call('POST', `/api/secrets/${a.id}/consume`);
    const consumed = await api.repo.get(a.id);
    expect(consumed).toMatchObject({ purgeAt: T0 + 30 * DAY, expiresAt: T0 + DAY });
    expect(consumed!.sweepPart).toBeUndefined();
    expect(consumed!.sweepAt).toBeUndefined();

    const b = await api.create({ maxViews: null });
    await api.call('DELETE', `/api/secrets/${b.id}`, { headers: { 'x-manage-token': b.token } });
    const deleted = await api.repo.get(b.id);
    expect(deleted!.sweepPart).toBeUndefined();
    expect(deleted!.purgeAt).toBe(T0 + 30 * DAY);
  });

  it('file create: pending due at min(created + 1 h, expiry); finalize moves it to the expiry; final consume queues the files', async () => {
    const api = await makeApi();
    const s = await withFiles(api, 3);
    expect(await api.repo.get(s.id)).toMatchObject({
      status: 'pending',
      sweepPart: 'live',
      sweepAt: T0 + HOUR,
      purgeAt: T0 + 3 * HOUR + 30 * DAY,
    });
    await api.call('POST', `/api/secrets/${s.id}/finalize`, {
      headers: { 'x-manage-token': s.token },
    });
    expect(await api.repo.get(s.id)).toMatchObject({
      status: 'ready',
      sweepPart: 'live',
      sweepAt: T0 + 3 * HOUR,
    });
    await api.call('POST', `/api/secrets/${s.id}/consume`);
    expect(await api.repo.get(s.id)).toMatchObject({
      status: 'ended',
      sweepPart: 'files',
      sweepAt: T0 + 300,
      purgeAt: T0 + 30 * DAY,
    });
  });
});

describe('HMAC key rotation', () => {
  it('a challenge signed with a rotated key is accepted after one reload; reloads are rate limited', async () => {
    const api = await makeApi();
    // The shared harness advances the parameter clock on every read; this test needs real minutes.
    api.deps.params = cachedParams(api.store, '/t', () => 1_000_000);
    await api.call('GET', '/api/challenge'); // caches the first key
    let reads = 0;
    const get = api.store.get.bind(api.store);
    api.store.get = (name: string) => {
      if (name.endsWith('powHmacKey')) reads++;
      return get(name);
    };
    const fresh = randomBytes(32);
    api.store.values.set('/t/powHmacKey', b64urlEncode(fresh));
    const rotated = issueChallenge(fresh, 8, T0).challenge;
    const { body } = await api.create();
    const send = (challenge: string) =>
      api.call('POST', '/api/secrets', {
        body: {
          ...body,
          envelope: { ...body.envelope, id: b64urlEncode(randomBytes(16)) },
          pow: { challenge, nonce: solve(challenge, 8) },
        },
      });
    reads = 0;
    expect((await send(rotated)).statusCode).toBe(201);
    expect(reads).toBe(1);
    // A forged challenge right after: no second SSM read within the minute.
    const forged = issueChallenge(randomBytes(32), 8, T0).challenge;
    expect((await send(forged)).json).toMatchObject({
      error: 'invalid_pow',
      message: 'bad challenge signature',
    });
    expect(reads).toBe(1);
  });
});
