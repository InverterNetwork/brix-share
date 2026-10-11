import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DOWNLOAD_GRACE_SEC, PENDING_MAX_AGE_SEC } from '@brix-share/shared';
import { fileKey, type FileStore } from '../../api/src/files.ts';
import { Repo, type DbClients, type SecretItem } from '../../api/src/repo.ts';

export { DOWNLOAD_GRACE_SEC, PENDING_MAX_AGE_SEC };

export interface SweepCounts {
  expired: number;
  pendingRemoved: number;
  filesDeleted: number;
  orphansDeleted: number;
  /** Entries or prefixes that failed this run; retried on the next one. */
  failures: number;
}

interface DueEntry {
  pk: string;
  sweepPart: 'live' | 'files';
  status: SecretItem['status'];
  expiresAt: number;
  createdAt: number;
  endedAt?: number;
  fileIds: string[];
}

/**
 * PLAN section 9.6, every 5 minutes. Reads only the sparse `sweep-due` index: live secrets whose expiry (or
 * pending cleanup time) has come, and ended secrets whose files are due for deletion. Never scans the table.
 * Every step is idempotent; a run that fails halfway is completed by the next one.
 */
export async function sweep(
  db: DbClients,
  table: string,
  files: FileStore,
  now: number,
): Promise<SweepCounts> {
  const repo = new Repo(db, table);
  const counts: SweepCounts = {
    expired: 0,
    pendingRemoved: 0,
    filesDeleted: 0,
    orphansDeleted: 0,
    failures: 0,
  };

  for (const part of ['live', 'files'] as const) {
    for (const e of await due(db, table, part, now)) {
      // One failing entry must not stop the rest of the run (or the item count metric).
      try {
        await sweepEntry(e, repo, files, now, counts);
      } catch {
        counts.failures++;
      }
    }
  }

  // Orphans: object prefixes without an item (crashed creates, races), or whose secret ended more than the
  // download grace ago (for example an object written again with a still valid upload URL after a delete).
  // Live secrets are in the index, so their prefixes need no item read (keeps a run cheap as the bucket grows).
  const live = await liveIds(db, table);
  for (const p of await files.listPrefixes()) {
    if (p.newest > now - DOWNLOAD_GRACE_SEC || live.has(p.prefix)) continue;
    try {
      const item = await repo.get(p.prefix);
      if (item && (item.status !== 'ended' || (item.endedAt ?? now) > now - DOWNLOAD_GRACE_SEC))
        continue;
      await files.delete(p.keys);
      counts.orphansDeleted += p.keys.length;
    } catch {
      counts.failures++;
    }
  }
  return counts;
}

/** Ids of all live secrets (keys only from the sparse index). */
async function liveIds(db: DbClients, table: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let start: Record<string, unknown> | undefined;
  do {
    const res = await db.read.send(
      new QueryCommand({
        TableName: table,
        IndexName: 'sweep-due',
        KeyConditionExpression: 'sweepPart = :live',
        ExpressionAttributeValues: { ':live': 'live' },
        ProjectionExpression: 'pk',
        ExclusiveStartKey: start,
      }),
    );
    for (const i of res.Items ?? []) ids.add(String(i.pk).slice(2));
    start = res.LastEvaluatedKey;
  } while (start);
  return ids;
}

async function due(
  db: DbClients,
  table: string,
  part: 'live' | 'files',
  now: number,
): Promise<DueEntry[]> {
  const out: DueEntry[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await db.read.send(
      new QueryCommand({
        TableName: table,
        IndexName: 'sweep-due',
        KeyConditionExpression: 'sweepPart = :part AND sweepAt <= :now',
        ExpressionAttributeValues: { ':part': part, ':now': now },
        ExclusiveStartKey: start,
      }),
    );
    out.push(...((res.Items ?? []) as DueEntry[]));
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}

async function sweepEntry(
  e: DueEntry,
  repo: Repo,
  files: FileStore,
  now: number,
  counts: SweepCounts,
): Promise<void> {
  const id = e.pk.slice(2);
  const keys = e.fileIds.map((f) => fileKey(id, f));
  if (e.status === 'pending') {
    // Item first: if a finalize slips in, the conditional delete fails and the objects stay with the now
    // ready secret. Deleting objects first could leave a ready secret without its files.
    if (await repo.deletePending(id)) {
      await files.delete(keys);
      counts.pendingRemoved++;
    }
    return;
  }
  if (e.status === 'ready') {
    // Expiry removes the envelope at once; files follow after the download grace (a `files` entry).
    if (e.expiresAt <= now) {
      const after = await repo.expireIfStale(id, now);
      // The index can lag; count only what actually ended by expiry here.
      if (after?.endedReason === 'expired' && after.endedAt === e.expiresAt) counts.expired++;
    }
    return;
  }
  if (e.sweepPart === 'files') {
    await files.delete(keys);
    await repo.clearFiles(id);
    counts.filesDeleted += keys.length;
  }
}

/** Approximate item count (DynamoDB refreshes it about every 6 hours); feeds the TableItemCount alarm. */
export async function tableItemCount(db: DbClients, table: string): Promise<number> {
  const res = await db.read.send(new DescribeTableCommand({ TableName: table }));
  return res.Table?.ItemCount ?? 0;
}
