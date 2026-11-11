import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { publicLockfile } from '../public-lockfile.ts';

it('keeps public lock entries byte-for-byte while excluding infra package access', () => {
  const source = readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8');
  const projected = publicLockfile(source);
  expect(projected).not.toContain('@inverternetwork/platform-cdk');
  expect(projected).not.toMatch(/^  infra:/m);
  for (const section of ['api', 'shared', 'web']) {
    const block = source.match(new RegExp(`^  ${section}:\\n(?:\\n| {4}[^\\n]*\\n)+`, 'm'))![0];
    expect(projected).toContain(block);
  }
  // Every retained nonempty line must appear unchanged, in original order.
  let cursor = 0;
  const original = source.split('\n');
  for (const line of projected.split('\n').filter(Boolean)) {
    while (cursor < original.length && original[cursor] !== line) cursor++;
    expect(original[cursor++]).toBe(line);
  }
});

it('fails closed on a changed lockfile format or missing private records', () => {
  expect(() => publicLockfile("lockfileVersion: '10.0'\n")).toThrow('Unsupported');
  expect(() =>
    publicLockfile("lockfileVersion: '9.0'\nimporters:\n  web:\n    dependencies: {}\n"),
  ).toThrow('Expected infra');
});
