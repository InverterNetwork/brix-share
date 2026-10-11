import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** Bundles the known-answer page script with esbuild (served at /__kat.js by the test server). */
export default async function globalSetup() {
  const out = fileURLToPath(new URL('./.kat/', import.meta.url));
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [fileURLToPath(new URL('./kat-entry.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outfile: `${out}kat.js`,
    logLevel: 'warning',
  });
}
