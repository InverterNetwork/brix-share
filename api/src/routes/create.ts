import { FILE_OVERHEAD_BYTES, secToIso, validateCreateRequest } from '@brix-share/shared';
import { fileKey } from '../files.ts';
import type { Deps } from '../deps.ts';
import type { FunctionUrlResult } from '../http.ts';
import { logEvent } from '../log.ts';
import { verifySolution } from '../pow.ts';

export async function createSecret(deps: Deps, body: string): Promise<FunctionUrlResult> {
  const { http } = deps;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return http.error('invalid_request', 'body is not valid JSON');
  }
  if (!(await deps.params.createEnabled())) {
    return http.error('create_disabled', 'Creating new secrets is paused. Please try again later.');
  }
  const now = deps.now();
  const v = validateCreateRequest(parsed, now);
  if (!v.ok) return http.error('invalid_request', v.reason);
  const { request, expiresAtSec, availableFromSec } = v.value;

  const [key, difficulty] = await Promise.all([deps.params.hmacKey(), deps.params.powDifficulty()]);
  let pow = verifySolution(key, request.pow.challenge, request.pow.nonce, difficulty, now);
  if (!pow.ok && pow.reason === 'bad challenge signature') {
    // The key may have been rotated since this container cached it; read it once more.
    pow = verifySolution(
      await deps.params.reloadHmacKey(),
      request.pow.challenge,
      request.pow.nonce,
      difficulty,
      now,
    );
  }
  if (!pow.ok) return http.error('invalid_pow', pow.reason);
  if (!(await deps.repo.claimChallenge(pow.replayKey, pow.expSec))) {
    return http.error('invalid_pow', 'challenge already used');
  }

  // Uploads go straight to S3; the secret stays pending (not retrievable) until finalize checked them.
  // Presigned before the item is written, so a signing failure leaves nothing behind.
  const uploads = await Promise.all(
    request.files.map(async (f) => ({
      fileId: f.fileId,
      url: await deps.files.presignPut(
        fileKey(request.envelope.id, f.fileId),
        f.size + FILE_OVERHEAD_BYTES,
      ),
      headers: {},
    })),
  );

  const created = await deps.repo.create({
    id: request.envelope.id,
    envelope: request.envelope,
    maxViews: request.policy.maxViews,
    expiresAt: expiresAtSec,
    availableFrom: availableFromSec,
    createdAt: now,
    deleteTokenHash: request.manageTokenHash,
    // In envelope order, so finalize can compare each object with its declared size.
    fileSizes: request.envelope.fileIds.map((f) => request.files.find((d) => d.fileId === f)!.size),
  });
  if (!created) return http.error('id_conflict', 'id already in use, generate a new one');

  logEvent({ event: 'create' });
  return http.json(201, {
    id: request.envelope.id,
    expiresAt: secToIso(expiresAtSec),
    availableFrom: availableFromSec === null ? null : secToIso(availableFromSec),
    maxViews: request.policy.maxViews,
    uploads,
  });
}
