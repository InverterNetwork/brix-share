import { secToIso, type Envelope } from '@brix-share/shared';
import type { Deps } from '../deps.ts';
import { header, type FunctionUrlEvent, type FunctionUrlResult } from '../http.ts';
import { fileKey } from '../files.ts';
import { logEvent } from '../log.ts';

export function viewerCountry(event: FunctionUrlEvent): string {
  const c = header(event, 'cloudfront-viewer-country');
  return c && /^[A-Z]{2}$/.test(c) ? c : 'XX';
}

/**
 * Whether the share link can be opened now or later. Counts nothing and returns nothing a reveal would not:
 * 404 for everything consume answers with 404, else the release time (null if already released).
 */
export async function getAvailability(deps: Deps, id: string): Promise<FunctionUrlResult> {
  const item = await deps.repo.availability(id);
  if (item?.status !== 'ready' || item.expiresAt <= deps.now())
    return deps.http.error('not_found', 'This secret does not exist or can no longer be opened.');
  const later = item.availableFrom !== undefined && item.availableFrom > deps.now();
  return deps.http.json(200, { availableFrom: later ? secToIso(item.availableFrom!) : null });
}

export async function consumeSecret(
  deps: Deps,
  id: string,
  event: FunctionUrlEvent,
): Promise<FunctionUrlResult> {
  const r = await deps.repo.consume(id, () => deps.now(), viewerCountry(event));
  if (r.kind === 'not_found')
    return deps.http.error('not_found', 'This secret does not exist or can no longer be opened.');
  if (r.kind === 'too_early') {
    return deps.http.error('too_early', 'This secret is not available yet.', {
      availableFrom: secToIso(r.availableFrom),
    });
  }
  const downloads = await Promise.all(
    r.fileIds.map(async (fileId) => ({
      fileId,
      url: await deps.files.presignGet(fileKey(id, fileId)),
    })),
  );
  logEvent({ event: 'consume' });
  return deps.http.json(200, {
    envelope: JSON.parse(r.envelope) as Envelope,
    policy: { viewsRemaining: r.viewsRemaining, expiresAt: secToIso(r.expiresAt) },
    downloads,
  });
}
