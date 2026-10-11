import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DEFAULT_PATH = resolve(REPO_ROOT, 'infra/stages.json');

/**
 * Raw stage config: infra/stages.json (git-ignored, written by the deploy scripts from the STAGES_JSON
 * repository variable), or the file named by BRIX_SHARE_STAGES, relative to the repository root (CI and tests
 * use infra/stages.example.json).
 */
export function readStageFile(): unknown {
  const env = process.env.BRIX_SHARE_STAGES;
  const path = env ? resolve(REPO_ROOT, env) : DEFAULT_PATH;
  if (!existsSync(path)) {
    throw new Error(
      `No stage config at ${path}. Maintainers: gh variable get STAGES_JSON > infra/stages.json. ` +
        'Dry run with the example: BRIX_SHARE_STAGES=infra/stages.example.json',
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
