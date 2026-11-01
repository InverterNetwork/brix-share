import { randomBytes } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { DAY, HOUR } from '@brix-share/shared';
import { describe, expect, inject, it } from 'vitest';
import { MemoryStore } from '../../api/src/files.ts';
import { Repo, documentClients, type SecretItem } from '../../api/src/repo.ts';
import { createSecretsTable } from '../../api/test/table.ts';
import { sweep } from '../src/sweep.ts';

const T0 = 1_800_000_000;
const GRACE = 300;

async function setup() {
  const db = documentClients(inject('ddbEndpoint'));
  const table = `s${randomBytes(6).toString('hex')}`;
  await createSecretsTable(db.read, table);
  const files = new MemoryStore('https://files.test.invalid', () => T0);
  const repo = new Repo(db, table);

  /** Writes an item the way the API would leave it, sweep index attributes included. */
  const put = async (id: string, item: Partial<SecretItem>, objectAge = HOUR) => {
    const fileIds = item.fileIds ?? [randomBytes(16).toString('base64url')];
    const status = item.status ?? 'ready';
    const expiresAt = item.expiresAt ?? T0 + DAY;
    const createdAt = item.createdAt ?? T0 - 2 * HOUR;
    const sweep =
      status === 'ended'
        ? { sweepPart: 'files' as const, sweepAt: (item.endedAt ?? T0) + GRACE }
        : status === 'pending'
          ? { sweepPart: 'live' as const, sweepAt: Math.min(createdAt + HOUR, expiresAt) }
          : { sweepPart: 'live' as const, sweepAt: expiresAt };
    await db.read.send(
      new PutCommand({
        TableName: table,
        Item: {
          pk: `S#${id}`,
          v: 'v1',
          status,
          ...(status === 'ended' ? {} : { envelope: '{}' }),
          hasPassphrase: false,
          retrievals: [],
          expiresAt,
          createdAt,
          purgeAt: expiresAt + 30 * DAY,
          deleteTokenHash: 'a'.repeat(64),
          consumeTokenHash: 'b'.repeat(64),
          ...sweep,
          ...item,
          fileIds,
        },
      }),
    );
    for (const f of fileIds)
      files.objects.set(`${id}/${f}`, { bytes: new Uint8Array(29), at: T0 - objectAge });
    return fileIds;
  };
  return { db, table, files, repo, put };
}

const id = () => randomBytes(16).toString('base64url');

describe('sweeper', () => {
  it('expires a live secret at its expiry, with or without files; files follow after the grace', async () => {
    const s = await setup();
    const withFiles = id();
    const textOnly = id();
    await s.put(withFiles, { expiresAt: T0 - 60 });
    await s.put(textOnly, { expiresAt: T0 - 60, fileIds: [] });
    const c1 = await sweep(s.db, s.table, s.files, T0);
    expect(c1.expired).toBe(2);
    for (const x of [withFiles, textOnly]) {
      const item = await s.repo.get(x);
      expect(item).toMatchObject({
        status: 'ended',
        endedReason: 'expired',
        endedAt: T0 - 60,
        expiresAt: T0 - 60,
        purgeAt: T0 - 60 + 30 * DAY,
      });
      expect(item!.envelope).toBeUndefined();
    }
    expect((await s.repo.get(textOnly))!.sweepPart).toBeUndefined();
    expect(await s.repo.get(withFiles)).toMatchObject({
      sweepPart: 'files',
      sweepAt: T0 - 60 + GRACE,
    });
    expect(s.files.objects.size).toBe(1);
    const c2 = await sweep(s.db, s.table, s.files, T0 + GRACE);
    expect(c2.filesDeleted).toBe(1);
    expect(s.files.objects.size).toBe(0);
    expect((await s.repo.get(withFiles))!.sweepPart).toBeUndefined();
  });

  it('does not touch live secrets before their expiry', async () => {
    const s = await setup();
    const a = id();
    await s.put(a, { expiresAt: T0 + 60 });
    const c = await sweep(s.db, s.table, s.files, T0);
    expect(c).toMatchObject({ expired: 0, filesDeleted: 0, orphansDeleted: 0 });
    expect((await s.repo.get(a))!.status).toBe('ready');
  });

  it('keeps objects of a just-ended secret for the download window, then deletes them', async () => {
    const s = await setup();
    const a = id();
    await s.put(a, { status: 'ended', endedAt: T0 - 60, endedReason: 'consumed' }, 60);
    expect((await sweep(s.db, s.table, s.files, T0)).filesDeleted).toBe(0);
    expect(s.files.objects.size).toBe(1);
    expect((await sweep(s.db, s.table, s.files, T0 + 240)).filesDeleted).toBe(1);
    expect(s.files.objects.size).toBe(0);
  });

  it('removes pending secrets older than an hour with their objects, keeps younger ones', async () => {
    const s = await setup();
    const old = id();
    const young = id();
    await s.put(old, { status: 'pending', createdAt: T0 - HOUR - 1 });
    await s.put(young, { status: 'pending', createdAt: T0 - 600 }, 600);
    const c = await sweep(s.db, s.table, s.files, T0);
    expect(c.pendingRemoved).toBe(1);
    expect(await s.repo.get(old)).toBeUndefined();
    expect((await s.repo.get(young))!.status).toBe('pending');
    expect([...s.files.objects.keys()].every((k) => k.startsWith(young))).toBe(true);
  });

  it('deletes orphaned objects (no item) after the grace period, never those of live secrets', async () => {
    const s = await setup();
    const live = id();
    await s.put(live, {});
    s.files.objects.set(`${id()}/${id()}`, { bytes: new Uint8Array(29), at: T0 - 600 });
    s.files.objects.set(`${id()}/${id()}`, { bytes: new Uint8Array(29), at: T0 - 60 });
    const c = await sweep(s.db, s.table, s.files, T0);
    expect(c.orphansDeleted).toBe(1);
    expect(s.files.objects.size).toBe(2);
    expect([...s.files.objects.keys()].some((k) => k.startsWith(live))).toBe(true);
  });

  it('deletes objects that reappeared under an ended secret (e.g. an upload URL replayed after delete)', async () => {
    const s = await setup();
    const a = id();
    // Ended long ago and already out of the sweep index, but an object is back.
    await s.put(
      a,
      {
        status: 'ended',
        endedAt: T0 - HOUR,
        endedReason: 'deleted',
        sweepPart: undefined,
        sweepAt: undefined,
      },
      600,
    );
    const c = await sweep(s.db, s.table, s.files, T0);
    expect(c.orphansDeleted).toBe(1);
    expect(s.files.objects.size).toBe(0);
  });

  it('is idempotent', async () => {
    const s = await setup();
    await s.put(id(), { expiresAt: T0 - 600 });
    await sweep(s.db, s.table, s.files, T0);
    await sweep(s.db, s.table, s.files, T0);
    const c = await sweep(s.db, s.table, s.files, T0 + 600);
    expect(c).toMatchObject({ expired: 0, pendingRemoved: 0, failures: 0 });
    expect(s.files.objects.size).toBe(0);
  });
});

describe('sweeper vs finalize race on a stale pending secret', () => {
  it('sweeper first: the item is gone, finalize can no longer release it', async () => {
    const s = await setup();
    const a = id();
    await s.put(a, { status: 'pending', createdAt: T0 - 2 * HOUR });
    await sweep(s.db, s.table, s.files, T0);
    expect(await s.repo.get(a)).toBeUndefined();
    expect(await s.repo.markReady(a, 'a'.repeat(64))).toBe(false);
    expect(s.files.objects.size).toBe(0);
  });

  it('finalize first: the sweeper leaves the now ready secret and its files alone', async () => {
    const s = await setup();
    const a = id();
    await s.put(a, { status: 'pending', createdAt: T0 - 2 * HOUR });
    expect(await s.repo.markReady(a, 'a'.repeat(64))).toBe(true);
    expect((await s.repo.get(a))!.sweepAt).toBe(T0 + DAY);
    const c = await sweep(s.db, s.table, s.files, T0);
    expect(c.pendingRemoved).toBe(0);
    expect((await s.repo.get(a))!.status).toBe('ready');
    expect(s.files.objects.size).toBe(1);
  });
});

describe('sweeper resilience', () => {
  it('a failing entry is counted and the rest of the run continues', async () => {
    const s = await setup();
    const bad = id();
    const good = id();
    await s.put(bad, { status: 'ended', endedAt: T0 - 600, endedReason: 'consumed' });
    await s.put(good, { status: 'ended', endedAt: T0 - 600, endedReason: 'consumed' });
    const realDelete = s.files.delete.bind(s.files);
    s.files.delete = (keys: string[]) =>
      keys.some((k) => k.startsWith(bad)) ? Promise.reject(new Error('boom')) : realDelete(keys);
    const c = await sweep(s.db, s.table, s.files, T0);
    // One from the files entry, one from the orphan pass retrying the same prefix.
    expect(c.failures).toBe(2);
    expect(c.filesDeleted).toBe(1);
    expect((await s.repo.get(good))!.sweepPart).toBeUndefined();
    expect((await s.repo.get(bad))!.sweepPart).toBe('files');
  });
});

describe('sweeper with items written by the API repository', () => {
  it('expires a text-only secret created through Repo.create', async () => {
    const s = await setup();
    const a = id();
    const ok = await s.repo.create({
      id: a,
      envelope: {
        v: 'v1',
        id: a,
        iv: 'AAAAAAAAAAAAAAAA',
        salt: null,
        ct: 'A'.repeat(64),
        hasPassphrase: false,
        fileIds: [],
      },
      maxViews: 1,
      expiresAt: T0 - 10,
      availableFrom: null,
      createdAt: T0 - HOUR,
      deleteTokenHash: 'a'.repeat(64),
      consumeTokenHash: 'b'.repeat(64),
      fileSizes: [],
    });
    expect(ok).toBe(true);
    const c = await sweep(s.db, s.table, s.files, T0);
    expect(c.expired).toBe(1);
    const item = await s.repo.get(a);
    expect(item).toMatchObject({
      status: 'ended',
      endedReason: 'expired',
      purgeAt: T0 - 10 + 30 * DAY,
    });
    expect(item!.envelope).toBeUndefined();
    expect(item!.sweepPart).toBeUndefined();
  });
});
