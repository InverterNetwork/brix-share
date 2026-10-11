import { FILE_OVERHEAD_BYTES, secToIso, type StatusResponse } from '@brix-share/shared';
import type { Deps } from '../deps.ts';
import type { FunctionUrlEvent, FunctionUrlResult } from '../http.ts';
import type { SecretItem } from '../repo.ts';
import { fileKey } from '../files.ts';
import { logEvent } from '../log.ts';
import { hashesEqual, manageTokenHash } from '../token.ts';

const NOT_FOUND = 'Nothing found for this manage link.';

function toStatus(item: SecretItem): StatusResponse {
  const ended = item.status === 'ended';
  return {
    exists: true,
    status: item.status,
    hasPassphrase: item.hasPassphrase,
    viewsRemaining: item.viewsRemaining ?? null,
    maxViews: item.maxViews ?? null,
    expiresAt: secToIso(item.expiresAt),
    availableFrom: item.availableFrom === undefined ? null : secToIso(item.availableFrom),
    createdAt: secToIso(item.createdAt),
    fileCount: item.fileIds.length,
    endedAt: item.endedAt === undefined ? null : secToIso(item.endedAt),
    endedReason: item.endedReason ?? null,
    historyUntil: ended ? secToIso(item.purgeAt) : null,
    retrievalCount: item.retrievalCount ?? item.retrievals.length,
    retrievals: item.retrievals.map((r) => ({ at: secToIso(r.at), country: r.country })),
  };
}

export async function getStatus(
  deps: Deps,
  id: string,
  event: FunctionUrlEvent,
): Promise<FunctionUrlResult> {
  const hash = await manageTokenHash(event);
  if (!hash) return deps.http.error('not_found', NOT_FOUND);
  const peek = await deps.repo.get(id);
  if (!peek || !hashesEqual(peek.deleteTokenHash, hash))
    return deps.http.error('not_found', NOT_FOUND);
  const item = await deps.repo.expireIfStale(id, deps.now());
  if (!item) return deps.http.error('not_found', NOT_FOUND);
  return deps.http.json(200, toStatus(item));
}

export async function deleteSecret(
  deps: Deps,
  id: string,
  event: FunctionUrlEvent,
): Promise<FunctionUrlResult> {
  const hash = await manageTokenHash(event);
  if (!hash) return deps.http.error('not_found', NOT_FOUND);
  const now = deps.now();
  const item = await deps.repo.get(id);
  if (!item || !hashesEqual(item.deleteTokenHash, hash) || item.status === 'ended') {
    return deps.http.error('not_found', NOT_FOUND);
  }
  if (item.expiresAt <= now) {
    // Already past its expiry: record it as expired; the secret is gone either way.
    await deps.repo.expireIfStale(id, now);
    return deps.http.empty(204);
  }
  if (!(await deps.repo.markDeleted(id, hash, now, item.fileIds.length > 0)))
    return deps.http.error('not_found', NOT_FOUND);
  // Deleting removes the files right away; a download started before the delete fails, as intended.
  // The secret is gone either way; if removing objects fails, the sweeper finishes it (it stays in the sweep index).
  if (item.fileIds.length > 0) {
    try {
      await deps.files.delete(item.fileIds.map((f) => fileKey(id, f)));
      await deps.repo.clearFiles(id);
    } catch (e) {
      logEvent({
        event: 'error',
        route: 'delete-files',
        name: e instanceof Error ? e.name : 'unknown',
      });
    }
  }
  return deps.http.empty(204);
}

/**
 * Releases a secret with attachments once every object is stored with the expected size (PLAN section 7).
 * Idempotent: an already released secret answers 200 again.
 */
export async function finalizeSecret(
  deps: Deps,
  id: string,
  event: FunctionUrlEvent,
): Promise<FunctionUrlResult> {
  const hash = await manageTokenHash(event);
  if (!hash) return deps.http.error('not_found', NOT_FOUND);
  const item = await deps.repo.get(id);
  if (!item || !hashesEqual(item.deleteTokenHash, hash) || item.fileIds.length === 0)
    return deps.http.error('not_found', NOT_FOUND);
  if (item.status === 'ready') return deps.http.json(200, { status: 'ready' });
  if (item.status !== 'pending' || item.expiresAt <= deps.now())
    return deps.http.error('not_found', NOT_FOUND);
  const sizes = item.fileSizes ?? [];
  const stored = await Promise.all(
    item.fileIds.map((fileId) => deps.files.size(fileKey(id, fileId))),
  );
  if (stored.some((n, i) => n === undefined || n !== (sizes[i] ?? -1) + FILE_OVERHEAD_BYTES)) {
    return deps.http.error(
      'upload_incomplete',
      'Not all files arrived completely. Please try again.',
    );
  }
  if (!(await deps.repo.markReady(id, hash))) {
    const again = await deps.repo.get(id);
    if (again?.status !== 'ready') return deps.http.error('not_found', NOT_FOUND);
  }
  return deps.http.json(200, { status: 'ready' });
}
