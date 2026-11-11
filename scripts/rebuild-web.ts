/** Credential-free web rebuild using the release lockfile, without the private infra workspace. */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicLockfile } from './public-lockfile.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? 'public-web-dist');
if (existsSync(output)) throw new Error(`Output already exists: ${output}`);
const work = mkdtempSync(join(tmpdir(), 'brix-share-web-'));
try {
  // Copy source only. No existing installation, private infra package or local registry credentials.
  for (const name of [
    'package.json',
    'pnpm-lock.yaml',
    '.nvmrc',
    'tsconfig.base.json',
    'web',
    'shared',
    'api',
    'sweeper',
    'scripts',
  ]) {
    cpSync(join(root, name), join(work, name), {
      recursive: true,
      filter: (source) =>
        !['node_modules', 'dist', 'test-results', 'playwright-report', '.kat'].includes(
          basename(source),
        ),
    });
  }
  writeFileSync(
    join(work, 'pnpm-lock.yaml'),
    publicLockfile(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')),
  );
  const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  if (!workspace.includes('  - infra\n'))
    throw new Error('Expected explicit infra workspace entry');
  writeFileSync(join(work, 'pnpm-workspace.yaml'), workspace.replace('  - infra\n', ''));
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|auth/i.test(key))),
    NPM_CONFIG_USERCONFIG: devNull,
    npm_config_userconfig: devNull,
    NPM_CONFIG_GLOBALCONFIG: devNull,
    npm_config_globalconfig: devNull,
  };
  for (const args of [
    ['install', '--frozen-lockfile', '--store-dir', join(work, 'store')],
    ['--filter', '@brix-share/web', 'build'],
  ]) {
    const result = spawnSync('pnpm', args, {
      cwd: work,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`pnpm ${args[0]} failed (${result.status ?? result.signal})`);
  }
  mkdirSync(output);
  cpSync(join(work, 'web/dist'), output, { recursive: true });
} finally {
  rmSync(work, { recursive: true, force: true });
}
