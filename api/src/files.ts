import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DOWNLOAD_URL_TTL_SEC, UPLOAD_URL_TTL_SEC } from '@brix-share/shared';

/** Object storage for encrypted attachments. Keys are `<id>/<fileId>`. */
export interface FileStore {
  /** Presigned PUT accepting exactly `length` bytes, valid 15 minutes. */
  presignPut(key: string, length: number): Promise<string>;
  /** Presigned GET, valid 2 minutes. */
  presignGet(key: string): Promise<string>;
  /** Stored size in bytes, or undefined when the object does not exist. */
  size(key: string): Promise<number | undefined>;
  delete(keys: string[]): Promise<void>;
  /** Every `<id>/` prefix in the bucket with the newest LastModified of its objects (epoch seconds). */
  listPrefixes(): Promise<{ prefix: string; keys: string[]; newest: number }[]>;
}

export const fileKey = (id: string, fileId: string) => `${id}/${fileId}`;

export function s3Store(bucket: string, region?: string): FileStore {
  // WHEN_REQUIRED: otherwise the SDK signs a CRC32 of an empty body into presigned PUT URLs and every
  // browser upload fails. Content-Length is part of the signature, which pins the upload size.
  const s3 = new S3Client({
    ...(region ? { region } : {}),
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    presignPut: (key, length) =>
      getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentLength: length }), {
        expiresIn: UPLOAD_URL_TTL_SEC,
      }),
    presignGet: (key) =>
      getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: DOWNLOAD_URL_TTL_SEC,
      }),
    async size(key) {
      try {
        const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return res.ContentLength;
      } catch (e) {
        // Without s3:ListBucket (deliberately not granted) S3 answers HEAD on a missing key with 403, not 404.
        const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (
          e instanceof NotFound ||
          err.name === 'NotFound' ||
          err.name === 'Forbidden' ||
          err.$metadata?.httpStatusCode === 403
        ) {
          return undefined;
        }
        throw e;
      }
    },
    async delete(keys) {
      if (keys.length === 0) return;
      const res = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      if (res.Errors?.length) throw new Error(`could not delete ${res.Errors.length} objects`);
    },
    async listPrefixes() {
      const byPrefix = new Map<string, { keys: string[]; newest: number }>();
      let token: string | undefined;
      do {
        const res = await s3.send(
          new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
        );
        for (const o of res.Contents ?? []) {
          if (!o.Key) continue;
          const prefix = o.Key.split('/')[0]!;
          const entry = byPrefix.get(prefix) ?? { keys: [], newest: 0 };
          entry.keys.push(o.Key);
          entry.newest = Math.max(
            entry.newest,
            Math.floor((o.LastModified?.getTime() ?? Date.now()) / 1000),
          );
          byPrefix.set(prefix, entry);
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return [...byPrefix].map(([prefix, v]) => ({ prefix, ...v }));
    },
  };
}

/** In-memory store for tests and the local e2e server. URLs point at `origin` and carry a random token. */
export class MemoryStore implements FileStore {
  readonly objects = new Map<string, { bytes: Uint8Array; at: number }>();
  /** token -> pending upload or download grant */
  readonly grants = new Map<
    string,
    { key: string; method: 'PUT' | 'GET'; length?: number; expires: number }
  >();
  private readonly origin: string;
  private readonly now: () => number;

  constructor(origin: string, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.origin = origin;
    this.now = now;
  }

  private grant(key: string, method: 'PUT' | 'GET', ttl: number, length?: number): string {
    const token = crypto.randomUUID();
    this.grants.set(token, {
      key,
      method,
      expires: this.now() + ttl,
      ...(length === undefined ? {} : { length }),
    });
    return `${this.origin}/${key}?token=${token}`;
  }

  presignPut(key: string, length: number) {
    return Promise.resolve(this.grant(key, 'PUT', UPLOAD_URL_TTL_SEC, length));
  }
  presignGet(key: string) {
    return Promise.resolve(this.grant(key, 'GET', DOWNLOAD_URL_TTL_SEC));
  }
  size(key: string) {
    return Promise.resolve(this.objects.get(key)?.bytes.length);
  }
  delete(keys: string[]) {
    for (const k of keys) this.objects.delete(k);
    return Promise.resolve();
  }
  listPrefixes() {
    const byPrefix = new Map<string, { keys: string[]; newest: number }>();
    for (const [key, o] of this.objects) {
      const prefix = key.split('/')[0]!;
      const e = byPrefix.get(prefix) ?? { keys: [], newest: 0 };
      e.keys.push(key);
      e.newest = Math.max(e.newest, o.at);
      byPrefix.set(prefix, e);
    }
    return Promise.resolve([...byPrefix].map(([prefix, v]) => ({ prefix, ...v })));
  }

  /** Emulates S3 for a presigned request: returns an HTTP status and, for GET, the bytes. */
  handle(
    method: string,
    key: string,
    token: string | null,
    body?: Uint8Array,
    /** Clock for this request; tests can shift time for one secret without affecting others. */
    at: number = this.now(),
  ): { status: number; bytes?: Uint8Array } {
    const g = token ? this.grants.get(token) : undefined;
    if (!g || g.key !== key || g.method !== method || g.expires <= at) return { status: 403 };
    if (method === 'PUT') {
      if (!body || body.length !== g.length) return { status: 403 };
      this.objects.set(key, { bytes: body, at });
      return { status: 200 };
    }
    const o = this.objects.get(key);
    return o ? { status: 200, bytes: o.bytes } : { status: 404 };
  }
}
