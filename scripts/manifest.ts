// Release manifests: SHA-256 of every file the web build serves.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface Manifest {
  /** Git tag of the release. */
  release: string;
  commit: string;
  node: string;
  /** URL path -> lowercase hex SHA-256. */
  files: Record<string, string>;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** { "/assets/index-abc.js": "<sha256>", ... } for every file under `dir`, keys sorted. */
export function hashTree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files['/' + relative(dir, p).split(sep).join('/')] = sha256Hex(readFileSync(p));
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Differences between two file maps: missing, unexpected, or with another hash. Empty when equal. */
export function diffFiles(
  expected: Record<string, string>,
  actual: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const [path, hash] of Object.entries(expected)) {
    if (!(path in actual)) out.push(`missing ${path}`);
    else if (actual[path] !== hash) out.push(`changed ${path}`);
  }
  for (const path of Object.keys(actual)) if (!(path in expected)) out.push(`unexpected ${path}`);
  return out;
}

export function parseManifest(text: string): Manifest {
  const m = JSON.parse(text) as Partial<Manifest>;
  if (!m.files || typeof m.files !== 'object') throw new Error('manifest without files');
  for (const [k, v] of Object.entries(m.files)) {
    if (!k.startsWith('/') || !/^[0-9a-f]{64}$/.test(v)) throw new Error(`bad manifest entry ${k}`);
  }
  return { release: m.release ?? '', commit: m.commit ?? '', node: m.node ?? '', files: m.files };
}

// CLI: node scripts/manifest.ts <dist dir> [release] [commit] -> manifest JSON on stdout.
if (import.meta.filename === process.argv[1]) {
  const [dir = 'web/dist', release = '', commit = ''] = process.argv.slice(2);
  const manifest: Manifest = { release, commit, node: process.version, files: hashTree(dir) };
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}
