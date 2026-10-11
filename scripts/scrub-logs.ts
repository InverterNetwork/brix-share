/**
 * Searches a stage's Lambda log groups for every id, token, key, passphrase and ciphertext fragment that a
 * verify-live run produced, plus presigned URL markers. Any hit fails. A read-only profile is enough:
 *   AWS_PROFILE=<prod-readonly-profile> node scripts/scrub-logs.ts prod /tmp/brix-verify-<run>.json
 * CloudFront access logs legitimately contain /s/<id> paths and are admin-only; they are not scanned.
 */
import { readStageFile } from '../infra/lib/stage-file.ts';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [stage, termsFile] = process.argv.slice(2);
if (!stage || !termsFile) {
  console.error('usage: node scripts/scrub-logs.ts <stage> <terms-file>');
  process.exit(2);
}
const stages = readStageFile() as Record<string, { region: string }>;
const region = stages[stage]?.region;
if (!region) throw new Error(`unknown stage ${stage}`);
const run = JSON.parse(readFileSync(termsFile, 'utf8')) as { startedAt: number; terms: string[] };

/** JSON output makes the CLI merge all pages into one result (text output prints one value per page). */
const aws = (args: string[]) =>
  JSON.parse(
    execFileSync('aws', [...args, '--region', region, '--output', 'json'], { encoding: 'utf8' }),
  ) as Record<string, unknown>;

const groups: string[] = [];
for (const prefix of ['Api', 'Sweeper', 'Governor']) {
  const res = aws([
    'logs',
    'describe-log-groups',
    '--log-group-name-prefix',
    `BrixShare-${stage}-${prefix}Logs`,
  ]) as { logGroups: { logGroupName: string }[] };
  groups.push(...res.logGroups.map((g) => g.logGroupName));
}
if (groups.length < 3) throw new Error(`expected 3 log groups, found ${groups.length}`);
const apiGroup = groups[0]!;

// A quoted term in a filter pattern; embedded quotes and backslashes escaped.
const pattern = (t: string) => `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const count = (group: string, term: string) =>
  (
    aws([
      'logs',
      'filter-log-events',
      '--log-group-name',
      group,
      '--start-time',
      String(run.startedAt),
      '--filter-pattern',
      pattern(term),
    ]) as {
      events: unknown[];
    }
  ).events.length;

// CloudWatch ingestion lags: wait until the api log group has events from the run, or give up (no verdict).
let seen = 0;
for (let i = 0; i < 30 && seen === 0; i++) {
  seen = count(apiGroup, '"event":"request"');
  if (seen === 0) execFileSync('sleep', ['10']);
}
if (seen === 0) {
  console.error('No API log events since the run started; cannot conclude.');
  process.exit(1);
}

const terms = [
  ...run.terms,
  'X-Amz-Signature',
  'X-Amz-Credential',
  'x-manage-token',
  '"envelope"',
  '"ct"',
];
let hits = 0;
for (const g of groups) {
  for (const t of terms) {
    const n = count(g, t);
    if (n > 0) {
      // Never print the term itself: it may be a token.
      process.stdout.write(`HIT in ${g}: a term of ${t.length} characters appears ${n} times\n`);
      hits++;
    }
  }
}
process.stdout.write(
  `Searched ${groups.length} log groups for ${terms.length} terms (${seen} API events since the run): ${hits} hits.\n`,
);
if (hits) process.exit(1);
