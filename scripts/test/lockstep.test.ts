import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// DECISIONS 2026-11-12: AWS SDK packages move together. Mixed releases pull separate Smithy copies whose
// client and command types do not match, which surfaces only as confusing type errors. Tailwind CSS and its
// Vite plugin move together too: a split leaves the plugin compiling with its own older tailwindcss copy.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

it.each([
  ['AWS SDK', /^@aws-sdk\//],
  ['Tailwind CSS', /^(?:tailwindcss$|@tailwindcss\/)/],
])('pins every direct %s dependency to one release', (_family, family) => {
  const versions = new Set<string>();
  const workspace = read('pnpm-workspace.yaml')
    .split(/^packages:\n/m)[1]!
    .split('\n\n')[0]!;
  const dirs = [...workspace.matchAll(/^ {2}- (\S+)$/gm)].map(([, dir]) => `${dir}/`);
  expect(dirs).toContain('api/');
  for (const dir of ['', ...dirs]) {
    const manifest = JSON.parse(read(`${dir}package.json`)) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const deps of [manifest.dependencies, manifest.devDependencies])
      for (const [name, version] of Object.entries(deps ?? {}))
        if (family.test(name)) versions.add(version);
  }
  expect([...versions]).toHaveLength(1);
});

it('resolves one version of each AWS SDK, Smithy and Tailwind CSS package', () => {
  const lock = read('pnpm-lock.yaml');
  const packages = lock.split('\npackages:\n')[1]?.split('\nsnapshots:\n')[0];
  expect(packages).toBeDefined();
  const seen = new Map<string, Set<string>>();
  for (const [, name, version] of packages!.matchAll(
    /^ {2}'?(@(?:aws-sdk|smithy|tailwindcss)\/[^@'\s]+|tailwindcss)@([^'(:\s]+)/gm,
  ))
    seen.set(name!, (seen.get(name!) ?? new Set()).add(version!));
  expect(seen.size).toBeGreaterThan(0);
  const duplicates = [...seen]
    .filter(([, v]) => v.size > 1)
    .map(([n, v]) => `${n}@${[...v].join('|')}`);
  expect(duplicates).toEqual([]);
});
