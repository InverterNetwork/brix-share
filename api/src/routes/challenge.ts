import { secToIso } from '@brix-share/shared';
import type { Deps } from '../deps.ts';
import type { FunctionUrlResult } from '../http.ts';
import { issueChallenge } from '../pow.ts';

export async function getChallenge(deps: Deps): Promise<FunctionUrlResult> {
  const [key, difficulty] = await Promise.all([deps.params.hmacKey(), deps.params.powDifficulty()]);
  const c = issueChallenge(key, difficulty, deps.now());
  return deps.http.json(200, {
    challenge: c.challenge,
    difficulty: c.difficulty,
    expiresAt: secToIso(c.expiresAtSec),
  });
}
