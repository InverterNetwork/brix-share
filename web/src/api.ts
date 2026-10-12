/**
 * Talks to /api on the same origin. Every request carries x-amz-content-sha256 (CloudFront OAC signs
 * requests to the Lambda Function URL and needs the body hash from the viewer). Responses are validated
 * with the shared schemas; anything unexpected becomes an ApiError. Consume is never retried.
 */
import {
  AvailabilityResponseSchema,
  ChallengeResponseSchema,
  ConsumeResponseSchema,
  CreateResponseSchema,
  ErrorResponseSchema,
  FinalizeResponseSchema,
  MANAGE_TOKEN_HEADER,
  CONSUME_TOKEN_HEADER,
  StatusResponseSchema,
  TooEarlyResponseSchema,
  type ConsumeResponse,
  type CreateRequest,
  type CreateResponse,
  type ErrorCode,
  type StatusResponse,
} from '@brix-share/shared';
import { sha256Hex } from './crypto/envelope.ts';
import { solveInWorker } from './pow/solve.ts';

export class ApiError extends Error {
  readonly code: ErrorCode | 'network' | 'unexpected';
  readonly status: number;

  constructor(code: ErrorCode | 'network' | 'unexpected', message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** The request may or may not have reached the server; the outcome is unknown. */
export class NetworkError extends ApiError {
  constructor() {
    super('network', 'The connection failed.');
    this.name = 'NetworkError';
  }
}

/** Server clock minus local clock in ms, from the Date header of the latest API response. */
let clockOffsetMs = 0;

/** Server time in epoch seconds. */
export function serverNow(): number {
  return Math.floor((Date.now() + clockOffsetMs) / 1000);
}

function trackServerClock(res: Response): void {
  const date = res.headers.get('date');
  const t = date ? Date.parse(date) : NaN;
  if (Number.isFinite(t)) clockOffsetMs = t - Date.now();
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  deadlineMs = API_DEADLINE_MS,
): Promise<Response> {
  const text = body === undefined ? '' : JSON.stringify(body);
  const h: Record<string, string> = { 'x-amz-content-sha256': await sha256Hex(text), ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: h,
      body: body === undefined ? null : text,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      // A stalled request must not hang the page; an aborted consume counts as a lost response.
      signal: AbortSignal.timeout(deadlineMs),
    });
  } catch {
    throw new NetworkError();
  }
  trackServerClock(res);
  return res;
}

/** Largest API response we read: an envelope is at most ~100 KB, everything else is far smaller. */
const MAX_API_RESPONSE_BYTES = 512 * 1024;
const API_DEADLINE_MS = 60_000;
const DOWNLOAD_DEADLINE_MS = 10 * 60_000;

async function readJson(res: Response): Promise<unknown> {
  const bytes = await readLimited(res, { remaining: MAX_API_RESPONSE_BYTES });
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ApiError('unexpected', 'The server sent an unreadable response.', res.status);
  }
}

interface Schema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
}

async function parse<T>(res: Response, schema: Schema<T>): Promise<T> {
  const json = await readJson(res);
  const ok = schema.safeParse(json);
  if (!ok.success)
    throw new ApiError('unexpected', 'The server sent an unexpected response.', res.status);
  return ok.data;
}

async function fail(res: Response): Promise<never> {
  const json = await readJson(res).catch(() => null);
  const err = ErrorResponseSchema.safeParse(json);
  if (err.success) throw new ApiError(err.data.error, err.data.message, res.status);
  throw new ApiError('unexpected', `Unexpected response (${res.status}).`, res.status);
}

export interface Challenge {
  challenge: string;
  difficulty: number;
}

export async function getChallenge(): Promise<Challenge> {
  const res = await request('GET', '/api/challenge');
  if (!res.ok) return fail(res);
  const c = await parse(res, ChallengeResponseSchema);
  return { challenge: c.challenge, difficulty: c.difficulty };
}

export type CreateBody = Omit<CreateRequest, 'pow'>;

export interface CreateHooks {
  /**
   * Called with the server clock once the challenge arrived, before any work. Return a message to stop
   * (the form is checked against the server's time, not the device's).
   */
  check?: (serverNowSec: number) => string | null;
  /** Called when the proof-of-work starts; receives the cancel function. */
  onSolving?: (cancel: () => void) => void;
  onProgress?: (tries: number) => void;
  /** Called when the proof-of-work is done and the request is sent; cancelling is no longer possible. */
  onSubmitting?: () => void;
}

/**
 * Solves the proof-of-work and creates the secret. `build` runs after the proof-of-work and receives the
 * server clock, so expiry choices are computed against the time the server will check them. An
 * `invalid_pow` (difficulty raised meanwhile, or challenge expired) is retried once with a fresh challenge.
 */
export async function createSecret(
  build: (serverNowSec: number) => CreateBody,
  hooks: CreateHooks = {},
): Promise<CreateResponse> {
  for (let attempt = 0; ; attempt++) {
    const c = await getChallenge();
    const problem = hooks.check?.(serverNow());
    if (problem) throw new ApiError('invalid_request', problem);
    const job = solveInWorker(c.challenge, c.difficulty, hooks.onProgress);
    hooks.onSolving?.(job.cancel);
    const nonce = await job.result;
    hooks.onSubmitting?.();
    const body: CreateRequest = { ...build(serverNow()), pow: { challenge: c.challenge, nonce } };
    const res = await request('POST', '/api/secrets', body);
    if (res.status === 201) return parse(res, CreateResponseSchema);
    const json = await readJson(res).catch(() => null);
    const err = ErrorResponseSchema.safeParse(json);
    if (attempt === 0 && err.success && err.data.error === 'invalid_pow') continue;
    if (err.success) throw new ApiError(err.data.error, err.data.message, res.status);
    throw new ApiError('unexpected', `Unexpected response (${res.status}).`, res.status);
  }
}

export type ConsumeOutcome =
  | { kind: 'ok'; data: ConsumeResponse }
  | { kind: 'not_found' }
  | { kind: 'too_early'; availableFrom: string };

export type Availability =
  { kind: 'ready' } | { kind: 'not_found' } | { kind: 'too_early'; availableFrom: string };

/** Whether the share link can be opened; counts nothing. Errors and slow answers are the caller's to ignore. */
export async function getAvailability(id: string, consumeToken: string): Promise<Availability> {
  const res = await request(
    'GET',
    `/api/secrets/${id}`,
    undefined,
    { [CONSUME_TOKEN_HEADER]: consumeToken },
    8_000,
  );
  if (res.status === 404) return { kind: 'not_found' };
  if (!res.ok) return fail(res);
  const { availableFrom } = await parse(res, AvailabilityResponseSchema);
  return availableFrom ? { kind: 'too_early', availableFrom } : { kind: 'ready' };
}

/** The only call that counts as a retrieval. Never retried, by the client or by this function. */
export async function consumeSecret(id: string, consumeToken: string): Promise<ConsumeOutcome> {
  const res = await request('POST', `/api/secrets/${id}/consume`, undefined, {
    [CONSUME_TOKEN_HEADER]: consumeToken,
  });
  if (res.status === 200) return { kind: 'ok', data: await parse(res, ConsumeResponseSchema) };
  if (res.status === 404) return { kind: 'not_found' };
  if (res.status === 425) {
    const t = await parse(res, TooEarlyResponseSchema);
    return { kind: 'too_early', availableFrom: t.availableFrom };
  }
  return fail(res);
}

export async function getStatus(id: string, manageToken: string): Promise<StatusResponse | null> {
  const res = await request('GET', `/api/secrets/${id}/status`, undefined, {
    [MANAGE_TOKEN_HEADER]: manageToken,
  });
  if (res.status === 404) return null;
  if (!res.ok) return fail(res);
  return parse(res, StatusResponseSchema);
}

/** True when deleted now, false when there was nothing (left) to delete. */
export async function deleteSecret(id: string, manageToken: string): Promise<boolean> {
  const res = await request('DELETE', `/api/secrets/${id}`, undefined, {
    [MANAGE_TOKEN_HEADER]: manageToken,
  });
  if (res.status === 204) return true;
  if (res.status === 404) return false;
  return fail(res);
}

export async function finalizeSecret(id: string, manageToken: string): Promise<void> {
  const res = await request('POST', `/api/secrets/${id}/finalize`, undefined, {
    [MANAGE_TOKEN_HEADER]: manageToken,
  });
  if (!res.ok) return fail(res);
  await parse(res, FinalizeResponseSchema);
}

/**
 * PUT of one encrypted file to its presigned URL. Deliberately not through request(): the URL is signed by
 * S3 itself, so no OAC body hash header, and a Uint8Array body sends no Content-Type.
 */
export async function uploadFile(url: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      body: bytes,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) throw new ApiError('unexpected', `Upload failed (${res.status}).`, res.status);
}

/** A download URL must point at <id>/<fileId> over https (plain http only for a local test origin). */
export function checkDownloadUrl(raw: string, id: string, fileId: string): URL {
  const url = new URL(raw);
  const local =
    url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if ((url.protocol !== 'https:' && !local) || url.pathname !== `/${id}/${fileId}`) {
    throw new ApiError('unexpected', 'Unexpected download location.');
  }
  return url;
}

/**
 * Fetches one encrypted file, reading at most `budget` bytes (a hostile server cannot exhaust memory).
 * GETs may be retried freely within the URL's lifetime: they do not count as retrievals.
 */
/** A response was larger than its budget allows; final, never retried. */
export class OverBudgetError extends ApiError {
  constructor() {
    super('unexpected', 'Response larger than allowed.');
    this.name = 'OverBudgetError';
  }
}

/** Byte allowance shared by several reads (all attachments of one secret draw from one budget). */
export interface Budget {
  remaining: number;
}

/** Reads a body, cancelling as soon as it exceeds the budget. A hostile server cannot exhaust memory. */
export async function readLimited(res: Response, budget: Budget): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > budget.remaining) {
    await res.body?.cancel();
    throw new OverBudgetError();
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      budget.remaining -= value.length;
      if (budget.remaining < 0) {
        await reader.cancel();
        throw new OverBudgetError();
      }
      chunks.push(value);
    }
  } catch (e) {
    // A failed attempt gives its bytes back, so a retry of the same file is not refused as too large.
    budget.remaining += total;
    throw e;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Fetches one encrypted file within the shared budget. GETs may be retried: they are not retrievals. */
export async function downloadFile(url: URL, budget: Budget): Promise<Uint8Array<ArrayBuffer>> {
  let res: Response;
  try {
    res = await fetch(url, {
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(DOWNLOAD_DEADLINE_MS),
    });
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new ApiError('unexpected', `Download failed (${res.status}).`, res.status);
  }
  return readLimited(res, budget);
}
