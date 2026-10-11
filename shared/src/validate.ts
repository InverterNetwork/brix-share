import {
  AVAILABILITY_GAP_SEC,
  MAX_LIFETIME_SEC,
  MAX_TOTAL_FILE_BYTES,
  MIN_LIFETIME_SEC,
} from './constants.ts';
import { CreateRequestSchema, type CreateRequest } from './schema.ts';

export interface ValidCreateRequest {
  request: CreateRequest;
  expiresAtSec: number;
  availableFromSec: number | null;
}

export type ValidationResult =
  { ok: true; value: ValidCreateRequest } | { ok: false; reason: string };

export function isoToSec(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

export function secToIso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

/**
 * Validates a create request body (PLAN section 7) against the server clock `nowSec`.
 * Shape errors and semantic errors both produce `{ ok: false }` with a short reason that is safe to return.
 */
export function validateCreateRequest(body: unknown, nowSec: number): ValidationResult {
  const parsed = CreateRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid body',
    };
  }
  const req = parsed.data;
  const { envelope, policy, files } = req;

  if (envelope.hasPassphrase !== (envelope.salt !== null)) {
    return {
      ok: false,
      reason: 'envelope.salt must be present exactly when hasPassphrase is true',
    };
  }

  const expiresAtSec = isoToSec(policy.expiresAt);
  if (!(expiresAtSec > nowSec + MIN_LIFETIME_SEC) || expiresAtSec > nowSec + MAX_LIFETIME_SEC) {
    return { ok: false, reason: 'policy.expiresAt out of range' };
  }

  let availableFromSec: number | null = null;
  if (policy.availableFrom !== null) {
    availableFromSec = isoToSec(policy.availableFrom);
    if (availableFromSec < nowSec || availableFromSec >= expiresAtSec - AVAILABILITY_GAP_SEC) {
      return { ok: false, reason: 'policy.availableFrom out of range' };
    }
  }

  const declared = files.map((f) => f.fileId);
  if (new Set(declared).size !== declared.length) {
    return { ok: false, reason: 'files: duplicate fileId' };
  }
  if (new Set(envelope.fileIds).size !== envelope.fileIds.length) {
    return { ok: false, reason: 'envelope.fileIds: duplicate fileId' };
  }
  const envelopeIds = new Set(envelope.fileIds);
  if (declared.length !== envelopeIds.size || !declared.every((f) => envelopeIds.has(f))) {
    return { ok: false, reason: 'files do not match envelope.fileIds' };
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_TOTAL_FILE_BYTES) {
    return { ok: false, reason: 'files: total size over cap' };
  }

  return { ok: true, value: { request: req, expiresAtSec, availableFromSec } };
}
