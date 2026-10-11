import { randomBytes } from 'node:crypto';
import { DAY, b64urlEncode, hashManageToken, secToIso } from '@brix-share/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { solve } from '../src/pow.ts';
import { T0, makeApi } from './harness.ts';

type Api = Awaited<ReturnType<typeof makeApi>>;
let api: Api;
beforeAll(async () => {
  api = await makeApi();
});

const keyOf = (url: string) => new URL(url).pathname.slice(1);
const tokenOf = (url: string) => new URL(url).searchParams.get('token');

async function createWithFiles(sizes: number[], maxViews: number | null = 1) {
  const id = b64urlEncode(randomBytes(16));
  const token = b64urlEncode(randomBytes(32));
  const fileIds = sizes.map(() => b64urlEncode(randomBytes(16)));
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
        fileIds,
      },
      policy: { maxViews, expiresAt: secToIso(api.clock.now + DAY), availableFrom: null },
      manageTokenHash: await hashManageToken(token),
      pow: { challenge, nonce: solve(challenge, ch.json!.difficulty as number) },
      files: fileIds.map((fileId, i) => ({ fileId, size: sizes[i]! })),
    },
  });
  expect(res.statusCode).toBe(201);
  const uploads = res.json!.uploads as {
    fileId: string;
    url: string;
    headers: Record<string, string>;
  }[];
  return { id, token, fileIds, uploads };
}

const upload = (u: { url: string }, length: number) =>
  api.files.handle('PUT', keyOf(u.url), tokenOf(u.url), new Uint8Array(length)).status;
const finalize = (id: string, token: string) =>
  api.call('POST', `/api/secrets/${id}/finalize`, { headers: { 'x-manage-token': token } });
const consume = (id: string) => api.call('POST', `/api/secrets/${id}/consume`);

describe('files', () => {
  it('maps declared sizes to envelope order even when files are listed in another order', async () => {
    const id = b64urlEncode(randomBytes(16));
    const token = b64urlEncode(randomBytes(32));
    const [f1, f2] = [b64urlEncode(randomBytes(16)), b64urlEncode(randomBytes(16))];
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
          fileIds: [f1, f2],
        },
        policy: { maxViews: 1, expiresAt: secToIso(api.clock.now + DAY), availableFrom: null },
        manageTokenHash: await hashManageToken(token),
        pow: { challenge, nonce: solve(challenge, ch.json!.difficulty as number) },
        files: [
          { fileId: f2, size: 20 },
          { fileId: f1, size: 10 },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect((await api.repo.get(id))!.fileSizes).toEqual([10, 20]);
    const uploads = res.json!.uploads as { fileId: string; url: string }[];
    for (const u of uploads) upload(u, (u.fileId === f1 ? 10 : 20) + 28);
    expect((await finalize(id, token)).json).toEqual({ status: 'ready' });
  });

  it('create returns one presigned PUT per file, length pinned to size + 28, secret pending', async () => {
    const s = await createWithFiles([10, 0]);
    expect(s.uploads.map((u) => u.fileId)).toEqual(s.fileIds);
    expect(s.uploads.every((u) => keyOf(u.url) === `${s.id}/${u.fileId}`)).toBe(true);
    expect(upload(s.uploads[0]!, 10)).toBe(403);
    expect(upload(s.uploads[0]!, 38)).toBe(200);
    expect(await api.repo.get(s.id)).toMatchObject({
      status: 'pending',
      sweepPart: 'live',
      fileSizes: [10, 0],
    });
    expect((await consume(s.id)).statusCode).toBe(404);
  });

  it('finalize: wrong token 404, missing or short object 409, then ready; idempotent', async () => {
    const s = await createWithFiles([5, 7]);
    expect((await finalize(s.id, b64urlEncode(randomBytes(32)))).statusCode).toBe(404);
    upload(s.uploads[0]!, 33);
    const missing = await finalize(s.id, s.token);
    expect(missing.statusCode).toBe(409);
    expect(missing.json).toMatchObject({ error: 'upload_incomplete' });
    // An object of the wrong size (written around the presigned length check) is refused too.
    api.files.objects.set(`${s.id}/${s.fileIds[1]}`, { bytes: new Uint8Array(30), at: T0 });
    expect((await finalize(s.id, s.token)).statusCode).toBe(409);
    upload(s.uploads[1]!, 35);
    expect((await finalize(s.id, s.token)).statusCode).toBe(200);
    expect((await api.repo.get(s.id))!.status).toBe('ready');
    expect((await finalize(s.id, s.token)).statusCode).toBe(200);
  });

  it('finalize on a secret without files or unknown id is 404', async () => {
    const plain = await api.create();
    expect((await finalize(plain.id, plain.token)).statusCode).toBe(404);
    expect((await finalize(b64urlEncode(randomBytes(16)), plain.token)).statusCode).toBe(404);
  });

  it('consume returns 2-minute download URLs for every file; they expire', async () => {
    const s = await createWithFiles([3], 2);
    upload(s.uploads[0]!, 31);
    await finalize(s.id, s.token);
    const r = await consume(s.id);
    const downloads = r.json!.downloads as { fileId: string; url: string }[];
    expect(downloads.map((d) => d.fileId)).toEqual(s.fileIds);
    const d = downloads[0]!;
    expect(api.files.handle('GET', keyOf(d.url), tokenOf(d.url))).toMatchObject({ status: 200 });
    api.clock.now += 121;
    expect(api.files.handle('GET', keyOf(d.url), tokenOf(d.url)).status).toBe(403);
    api.clock.now = T0;
  });

  it('final consume keeps objects for the download window; delete removes them at once', async () => {
    const once = await createWithFiles([4]);
    upload(once.uploads[0]!, 32);
    await finalize(once.id, once.token);
    expect((await consume(once.id)).statusCode).toBe(200);
    expect(await api.files.size(`${once.id}/${once.fileIds[0]}`)).toBe(32);
    expect(await api.repo.get(once.id)).toMatchObject({ status: 'ended', sweepPart: 'files' });

    const del = await createWithFiles([4, 4], null);
    upload(del.uploads[0]!, 32);
    upload(del.uploads[1]!, 32);
    await finalize(del.id, del.token);
    expect(
      (
        await api.call('DELETE', `/api/secrets/${del.id}`, {
          headers: { 'x-manage-token': del.token },
        })
      ).statusCode,
    ).toBe(204);
    expect(await api.files.size(`${del.id}/${del.fileIds[0]}`)).toBeUndefined();
    expect(await api.files.size(`${del.id}/${del.fileIds[1]}`)).toBeUndefined();
    const item = await api.repo.get(del.id);
    expect(item!.sweepPart).toBeUndefined();
    expect(item!.endedReason).toBe('deleted');
  });

  it('a pending secret can be deleted by its creator', async () => {
    const s = await createWithFiles([1]);
    upload(s.uploads[0]!, 29);
    expect(
      (await api.call('DELETE', `/api/secrets/${s.id}`, { headers: { 'x-manage-token': s.token } }))
        .statusCode,
    ).toBe(204);
    expect(await api.files.size(`${s.id}/${s.fileIds[0]}`)).toBeUndefined();
  });
});
