/**
 * Hourly external monitor (.github/workflows/monitor.yml). For every stage in infra/stages.json with a
 * deployed release (DEPLOYED_<STAGE>): the site (custom domain, or siteUrl while the custom domain is off)
 * must resolve and serve exactly that release's files with the expected headers. Stages without a deployed
 * release are skipped.
 */
import { readStageFile } from '../infra/lib/stage-file.ts';
import { execFileSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { checkDelivery, stageFilesOrigin } from './live-checks.ts';
import { parseManifest } from './manifest.ts';

interface Stage {
  filesBucketSuffix: string;
  region: string;
  domainName: string;
  customDomain?: boolean;
  siteUrl?: string;
}

const stages = readStageFile() as Record<string, Stage>;
const state = { failed: false };
const fail = (msg: string) => {
  state.failed = true;
  process.stdout.write(`${msg}\n`);
};

for (const [name, s] of Object.entries(stages)) {
  const tag = process.env[`DEPLOYED_${name.toUpperCase()}`];
  if (!tag) {
    // A stage configured to serve (custom domain or siteUrl) must have a deployed release on record.
    if (s.customDomain || s.siteUrl)
      fail(`${name}: FAIL configured to serve but DEPLOYED_${name.toUpperCase()} is not set`);
    else process.stdout.write(`${name}: not deployed yet, skipped\n`);
    continue;
  }
  const base = s.customDomain ? `https://${s.domainName}` : s.siteUrl;
  if (!base) {
    fail(`${name}: FAIL ${tag} is deployed but stages.json has neither customDomain nor siteUrl`);
    continue;
  }
  try {
    await lookup(new URL(base).hostname);
  } catch {
    fail(`${name}: FAIL ${base} does not resolve although ${tag} is deployed`);
    continue;
  }
  const manifest = parseManifest(
    execFileSync(
      'gh',
      ['release', 'download', tag, '--pattern', 'manifest.json', '--output', '-'],
      { encoding: 'utf8' },
    ),
  );
  const failures = await checkDelivery(
    base,
    manifest.files,
    stageFilesOrigin(name, s.filesBucketSuffix, s.region),
    tag,
  );
  if (failures.length === 0) {
    process.stdout.write(
      `${name}: ok, ${base} serves ${tag} (${Object.keys(manifest.files).length} files, headers as expected)\n`,
    );
  } else {
    fail(`${name}: FAIL ${base} differs from ${tag}:\n${failures.map((f) => `  ${f}`).join('\n')}`);
  }
}
if (state.failed) process.exit(1);
