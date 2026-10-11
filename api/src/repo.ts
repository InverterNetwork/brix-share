import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  DOWNLOAD_GRACE_SEC,
  MAX_RETRIEVALS_LOGGED,
  PENDING_MAX_AGE_SEC,
  TOMBSTONE_RETENTION_SEC,
  type Envelope,
} from '@brix-share/shared';

export type Status = 'pending' | 'ready' | 'ended';
export type EndedReason = 'consumed' | 'expired' | 'deleted';

export interface Retrieval {
  at: number;
  country: string;
}

/** Secret item as stored (PLAN section 8). Null policy values are absent attributes. */
export interface SecretItem {
  pk: string;
  v: string;
  status: Status;
  envelope?: string;
  hasPassphrase: boolean;
  maxViews?: number;
  viewsRemaining?: number;
  retrievals: Retrieval[];
  availableFrom?: number;
  expiresAt: number;
  createdAt: number;
  deleteTokenHash: string;
  fileIds: string[];
  /** Declared plaintext sizes, same order as fileIds; finalize checks the stored objects against them. */
  fileSizes?: number[];
  endedAt?: number;
  endedReason?: EndedReason;
  /** Total successful retrievals; the `retrievals` log keeps at most 100 entries. */
  retrievalCount?: number;
  /**
   * DynamoDB TTL. Live items: policy expiry + 30 d, so TTL can never remove a live item before the sweeper
   * turns it into a tombstone. Tombstones: endedAt + 30 d (the history window).
   */
  purgeAt: number;
  /**
   * Sparse `sweep-due` index. `live`: due at expiry (or pending cleanup); `files`: an ended secret whose
   * objects are due for deletion. Absent when nothing is left to do.
   */
  sweepPart?: 'live' | 'files';
  sweepAt?: number;
}

export const secretKey = (id: string) => `S#${id}`;
export const challengeKey = (hash: string) => `C#${hash}`;

export interface DbClients {
  /** Reads: default SDK retries (idempotent). */
  read: DynamoDBDocumentClient;
  /**
   * Writes: a single attempt. A conditional write whose response is lost must not be retried by the SDK: a
   * retried decrement would burn a second view for one released envelope. An ambiguous outcome surfaces as
   * a 500 and counts as a burnt retrieval, the same contract as a lost HTTP response.
   */
  write: DynamoDBDocumentClient;
}

export function documentClients(endpoint?: string): DbClients {
  const local = endpoint
    ? { endpoint, region: 'eu-central-1', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } }
    : {};
  const opts = { marshallOptions: { removeUndefinedValues: true } };
  return {
    read: DynamoDBDocumentClient.from(new DynamoDBClient(local), opts),
    write: DynamoDBDocumentClient.from(new DynamoDBClient({ ...local, maxAttempts: 1 }), opts),
  };
}

const isConditionFailure = (e: unknown) =>
  e instanceof ConditionalCheckFailedException ||
  (e as { name?: string } | null)?.name === 'ConditionalCheckFailedException';

export interface NewSecret {
  id: string;
  envelope: Envelope;
  maxViews: number | null;
  expiresAt: number;
  availableFrom: number | null;
  createdAt: number;
  deleteTokenHash: string;
  /** Declared plaintext sizes in envelope.fileIds order; a secret with files starts pending. */
  fileSizes: number[];
}

/** Where the consume state machine ended up. */
export type ConsumeResult =
  | {
      kind: 'ok';
      envelope: string;
      viewsRemaining: number | null;
      expiresAt: number;
      fileIds: string[];
    }
  | { kind: 'not_found' }
  | { kind: 'too_early'; availableFrom: number };

export class Repo {
  private readonly db: DbClients;
  private readonly table: string;

  constructor(db: DbClients, table: string) {
    this.db = db;
    this.table = table;
  }

  async get(id: string): Promise<SecretItem | undefined> {
    const res = await this.db.read.send(
      new GetCommand({ TableName: this.table, Key: { pk: secretKey(id) }, ConsistentRead: true }),
    );
    return res.Item as SecretItem | undefined;
  }

  /** Status and timing only, never the envelope: for the non-counting availability check. */
  async availability(
    id: string,
  ): Promise<Pick<SecretItem, 'status' | 'expiresAt' | 'availableFrom'> | undefined> {
    const res = await this.db.read.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: secretKey(id) },
        ConsistentRead: true,
        ProjectionExpression: '#s, expiresAt, availableFrom',
        ExpressionAttributeNames: { '#s': 'status' },
      }),
    );
    return res.Item as Pick<SecretItem, 'status' | 'expiresAt' | 'availableFrom'> | undefined;
  }

  /** Records a used proof-of-work challenge. False if it was used before. */
  async claimChallenge(replayKey: string, expSec: number): Promise<boolean> {
    try {
      await this.db.write.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: challengeKey(replayKey), purgeAt: expSec },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }

  /** Conditional put on a fresh id. False on collision. */
  async create(s: NewSecret): Promise<boolean> {
    const pending = s.fileSizes.length > 0;
    const item: SecretItem = {
      pk: secretKey(s.id),
      v: s.envelope.v,
      status: pending ? 'pending' : 'ready',
      // Re-serialised from the parsed, strict schema; never the raw request body.
      envelope: JSON.stringify(s.envelope),
      hasPassphrase: s.envelope.hasPassphrase,
      retrievals: [],
      retrievalCount: 0,
      expiresAt: s.expiresAt,
      createdAt: s.createdAt,
      deleteTokenHash: s.deleteTokenHash,
      fileIds: s.envelope.fileIds,
      purgeAt: s.expiresAt + TOMBSTONE_RETENTION_SEC,
      sweepPart: 'live',
      // A pending secret is due for cleanup after an hour unless finalize moves it to its expiry first.
      sweepAt: pending ? Math.min(s.createdAt + PENDING_MAX_AGE_SEC, s.expiresAt) : s.expiresAt,
    };
    if (s.maxViews !== null) {
      item.maxViews = s.maxViews;
      item.viewsRemaining = s.maxViews;
    }
    if (s.availableFrom !== null) item.availableFrom = s.availableFrom;
    if (pending) item.fileSizes = s.fileSizes;
    try {
      await this.db.write.send(
        new PutCommand({
          TableName: this.table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }

  /**
   * Builds the one update that ends a secret (PLAN 9.7): removes the envelope, sets the history TTL to
   * `endedAt + 30 d` and, for a secret with files, queues its objects for deletion after the download grace.
   * Every tombstone goes through here. `expiresAt` keeps the policy expiry.
   */
  private tombstone(
    id: string,
    reason: EndedReason,
    endedAt: number,
    hasFiles: boolean,
    extra: { set?: string[]; add?: string; condition: string; values: Record<string, unknown> },
    returnValues: 'NONE' | 'ALL_OLD' | 'ALL_NEW',
  ): UpdateCommand {
    const sets = [
      '#status = :ended',
      'endedAt = :endedAt',
      'endedReason = :reason',
      'purgeAt = :purgeAt',
      ...(hasFiles ? ['sweepPart = :files', 'sweepAt = :sweepAt'] : []),
      ...(extra.set ?? []),
    ];
    const removes = ['envelope', ...(hasFiles ? [] : ['sweepPart', 'sweepAt'])];
    return new UpdateCommand({
      TableName: this.table,
      Key: { pk: secretKey(id) },
      UpdateExpression: `REMOVE ${removes.join(', ')} SET ${sets.join(', ')}${extra.add ? ` ADD ${extra.add}` : ''}`,
      ConditionExpression: extra.condition,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':ended': 'ended',
        ':endedAt': endedAt,
        ':reason': reason,
        ':purgeAt': endedAt + TOMBSTONE_RETENTION_SEC,
        ...(hasFiles ? { ':files': 'files', ':sweepAt': endedAt + DOWNLOAD_GRACE_SEC } : {}),
        ...extra.values,
      },
      ReturnValues: returnValues,
    });
  }

  /**
   * Turns a live item whose expiry has passed into an `expired` tombstone (ended at its expiry time).
   * Idempotent. Always returns the item as stored afterwards, undefined if it is gone.
   */
  async expireIfStale(id: string, now: number): Promise<SecretItem | undefined> {
    const item = await this.get(id);
    if (!item || item.status === 'ended' || item.expiresAt > now) return item;
    try {
      await this.db.write.send(
        this.tombstone(
          id,
          'expired',
          item.expiresAt,
          item.fileIds.length > 0,
          {
            condition:
              'attribute_exists(pk) AND #status IN (:ready, :pending) AND expiresAt <= :now',
            values: { ':ready': 'ready', ':pending': 'pending', ':now': now },
          },
          'NONE',
        ),
      );
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
    }
    // Re-read either way: a racing consume or delete may have ended it with another reason.
    return this.get(id);
  }

  /**
   * PLAN section 9.1. At most two conditional attempts; the caller never retries. `clock` is read again
   * right before each write, so the expiry and availability conditions use the time of the write.
   */
  async consume(id: string, clock: () => number, country: string): Promise<ConsumeResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const item = await this.get(id);
      const now = clock();
      if (!item || item.status !== 'ready') return { kind: 'not_found' };
      if (item.expiresAt <= now) {
        await this.expireIfStale(id, now);
        return { kind: 'not_found' };
      }
      if (item.availableFrom !== undefined && item.availableFrom > now) {
        return { kind: 'too_early', availableFrom: item.availableFrom };
      }
      try {
        return await this.consumeOnce(id, item, now, country);
      } catch (e) {
        if (!isConditionFailure(e)) throw e;
      }
    }
    return { kind: 'not_found' };
  }

  private async consumeOnce(
    id: string,
    item: SecretItem,
    now: number,
    country: string,
  ): Promise<ConsumeResult> {
    const retrieval: Retrieval = { at: now, country };
    const live =
      'attribute_exists(pk) AND #status = :ready AND expiresAt > :now AND (attribute_not_exists(availableFrom) OR availableFrom <= :now)';

    if (item.viewsRemaining === 1) {
      // 9.1.2: the final retrieval turns the item into a tombstone in the same write.
      const res = await this.db.write.send(
        this.tombstone(
          id,
          'consumed',
          now,
          item.fileIds.length > 0,
          {
            set: ['viewsRemaining = :zero', 'retrievals = list_append(retrievals, :r)'],
            add: 'retrievalCount :one',
            condition: `${live} AND viewsRemaining = :one`,
            values: { ':ready': 'ready', ':now': now, ':zero': 0, ':one': 1, ':r': [retrieval] },
          },
          'ALL_OLD',
        ),
      );
      const old = res.Attributes as SecretItem;
      return {
        kind: 'ok',
        envelope: old.envelope!,
        viewsRemaining: 0,
        expiresAt: old.expiresAt,
        fileIds: old.fileIds,
      };
    }

    const values: Record<string, unknown> = { ':ready': 'ready', ':now': now, ':one': 1 };
    const sets: string[] = [];
    let condition = live;
    if (item.viewsRemaining !== undefined) {
      // 9.1.3, limited: a limited secret logs at most maxViews (<= 100) retrievals, so no cap check.
      sets.push(
        'viewsRemaining = viewsRemaining - :one',
        'retrievals = list_append(retrievals, :r)',
      );
      condition += ' AND viewsRemaining > :one';
      values[':r'] = [retrieval];
    } else {
      // Unlimited: the log keeps the first 100 retrievals; retrievalCount keeps counting.
      condition += ' AND attribute_not_exists(viewsRemaining)';
      if (item.retrievals.length < MAX_RETRIEVALS_LOGGED) {
        sets.push('retrievals = list_append(retrievals, :r)');
        condition += ' AND size(retrievals) < :maxr';
        values[':r'] = [retrieval];
        values[':maxr'] = MAX_RETRIEVALS_LOGGED;
      }
    }
    const res = await this.db.write.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: secretKey(id) },
        UpdateExpression: `${sets.length ? `SET ${sets.join(', ')} ` : ''}ADD retrievalCount :one`,
        ConditionExpression: condition,
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    const updated = res.Attributes as SecretItem;
    return {
      kind: 'ok',
      envelope: updated.envelope!,
      viewsRemaining: updated.viewsRemaining ?? null,
      expiresAt: updated.expiresAt,
      fileIds: updated.fileIds,
    };
  }

  /** PLAN section 9.3: tombstone with reason `deleted`. False if the token does not match or the item already ended. */
  async markDeleted(
    id: string,
    tokenHash: string,
    now: number,
    hasFiles: boolean,
  ): Promise<boolean> {
    try {
      await this.db.write.send(
        this.tombstone(
          id,
          'deleted',
          now,
          hasFiles,
          {
            condition:
              'attribute_exists(pk) AND deleteTokenHash = :h AND #status IN (:ready, :pending)',
            values: { ':h': tokenHash, ':ready': 'ready', ':pending': 'pending' },
          },
          'NONE',
        ),
      );
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }

  /** Releases a pending secret whose uploads were verified. False if not pending or the token does not match. */
  async markReady(id: string, tokenHash: string): Promise<boolean> {
    try {
      await this.db.write.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: secretKey(id) },
          // Due at its expiry now instead of the pending cleanup time.
          UpdateExpression: 'SET #status = :ready, sweepAt = expiresAt',
          ConditionExpression:
            'attribute_exists(pk) AND #status = :pending AND deleteTokenHash = :h',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':ready': 'ready', ':pending': 'pending', ':h': tokenHash },
        }),
      );
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }

  /** Takes an ended item out of the sweep index once its objects are gone. */
  async clearFiles(id: string): Promise<void> {
    try {
      await this.db.write.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: secretKey(id) },
          UpdateExpression: 'REMOVE sweepPart, sweepAt',
          ConditionExpression: 'attribute_exists(pk) AND #status = :ended',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':ended': 'ended' },
        }),
      );
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
    }
  }

  /** Removes a pending secret whose upload never completed. False if it is no longer pending. */
  async deletePending(id: string): Promise<boolean> {
    try {
      await this.db.write.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { pk: secretKey(id) },
          ConditionExpression: 'attribute_exists(pk) AND #status = :pending',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':pending': 'pending' },
        }),
      );
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }
}
