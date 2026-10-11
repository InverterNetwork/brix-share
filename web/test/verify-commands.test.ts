import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as commands from '../src/verify-commands.ts';

it('keeps the public page commands identical to the canonical README', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  for (const command of Object.values(commands)) expect(readme).toContain(command);
});
