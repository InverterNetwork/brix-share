/**
 * Deploys a tagged release of the web app to a stage. Run by a human with an admin SSO session.
 * Usage: AWS_PROFILE=<admin profile> node scripts/deploy-web.ts <stage> <tag> [--dry-run]
 *
 * 1. The working tree must be clean and at <tag>.
 * 2. Builds locally and refuses to continue unless every file equals the release manifest that CI published.
 * 3. Assumes the stage's web deploy role (the only principal the static bucket accepts writes from).
 * 4. Uploads hashed assets first and index.html last, with explicit content types and caching, removes files
 *    older than the previous release, invalidates /index.html and /.
 * 5. Records the tag in the repository variable DEPLOYED_<STAGE>, which the monitor checks against.
 */
import { readStageFile } from '../infra/lib/stage-file.ts';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planDeploy } from './deploy-plan.ts';
import { diffFiles, hashTree, parseManifest } from './manifest.ts';

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [stage, tag] = args.filter((a) => !a.startsWith('--'));
if (!stage || !tag) {
  console.error('usage: node scripts/deploy-web.ts <stage> <tag> [--dry-run]');
  process.exit(2);
}

const run = (cmd: string, argv: string[], env: NodeJS.ProcessEnv = process.env) =>
  execFileSync(cmd, argv, {
    cwd: root,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
const say = (s: string) => process.stdout.write(`${s}\n`);

// Stage config is not in the repository; the STAGES_JSON repository variable is the source (git-ignored copy).
writeFileSync(
  join(root, 'infra/stages.json'),
  `${run('gh', ['variable', 'get', 'STAGES_JSON'])}\n`,
);
const stages = readStageFile() as Record<string, { region: string }>;
const cfg = stages[stage];
if (!cfg) throw new Error(`unknown stage ${stage}`);

// 1. Clean tree at the tag.
if (run('git', ['status', '--porcelain'])) throw new Error('working tree is not clean');
const head = run('git', ['rev-parse', 'HEAD']);
const tagged = run('git', ['rev-parse', `${tag}^{commit}`]);
if (head !== tagged)
  throw new Error(`HEAD ${head} is not ${tag} (${tagged}); run git checkout ${tag}`);

// 2. Local build must equal the published release.
say(`Building ${tag} locally`);
run('pnpm', ['install', '--frozen-lockfile']);
run('pnpm', ['--filter', '@brix-share/web', 'build']);
const local = hashTree(join(root, 'web/dist'));
const release = parseManifest(
  run('gh', ['release', 'download', tag, '--pattern', 'manifest.json', '--output', '-']),
);
const diff = diffFiles(release.files, local);
if (diff.length) {
  say('Local build differs from the release manifest. Not deploying. Differences:');
  for (const d of diff) say(`  ${d}`);
  say('Do not override this. Compare toolchain versions (Node, pnpm, lockfile) and fix the cause.');
  process.exit(1);
}
say(`Local build matches release ${tag} (${Object.keys(local).length} files)`);

// Previous release stays for one more deploy so open tabs can still load their files.
let previous: Record<string, string> | null = null;
const variable = `DEPLOYED_${stage.toUpperCase()}`;
// Only "variable not found" means there is no previous release; any other gh failure must stop the deploy,
// otherwise the plan would delete files of the release that is live right now.
let previousTag = '';
try {
  previousTag = execFileSync('gh', ['variable', 'get', variable], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
} catch (e) {
  const stderr = (e as { stderr?: string }).stderr ?? '';
  if (!/not found/i.test(stderr))
    throw new Error(`gh variable get ${variable} failed: ${stderr.trim()}`);
}
// The variable is written after the upload; make sure that will work before touching the bucket.
if (run('gh', ['api', 'repos/{owner}/{repo}', '--jq', '.permissions.admin']) !== 'true') {
  throw new Error(`setting ${variable} needs admin rights on the repository`);
}
if (previousTag && previousTag !== tag) {
  previous = parseManifest(
    run('gh', ['release', 'download', previousTag, '--pattern', 'manifest.json', '--output', '-']),
  ).files;
}

if (dryRun) {
  const plan = planDeploy(local, previous, []);
  say(`Dry run for ${stage}; previous release: ${previousTag || 'none'}`);
  for (const u of plan.uploads) say(`  put ${u.key}  [${u.contentType}] [${u.cacheControl}]`);
  say('  (deletes are computed from the bucket listing during a real deploy)');
  process.exit(0);
}

// 3. Stack outputs and the web deploy role.
const outputs = Object.fromEntries(
  (
    JSON.parse(
      run('aws', [
        'cloudformation',
        'describe-stacks',
        '--stack-name',
        `BrixShare-${stage}`,
        '--region',
        cfg.region,
        '--output',
        'json',
      ]),
    ) as { Stacks: { Outputs: { OutputKey: string; OutputValue: string }[] }[] }
  ).Stacks[0]!.Outputs.map((o) => [o.OutputKey, o.OutputValue]),
);
const bucket = outputs.StaticBucketName;
const distribution = outputs.DistributionId;
const roleArn = outputs.WebDeployRoleArn;
if (!bucket || !distribution || !roleArn) throw new Error('stack outputs missing');

const creds = JSON.parse(
  run('aws', [
    'sts',
    'assume-role',
    '--role-arn',
    roleArn,
    '--role-session-name',
    `brix-share-web-${tag}`.replace(/[^\w+=,.@-]/g, '-'),
    '--output',
    'json',
  ]),
) as { Credentials: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string } };
const roleEnv: NodeJS.ProcessEnv = {
  ...process.env,
  AWS_PROFILE: undefined,
  AWS_ACCESS_KEY_ID: creds.Credentials.AccessKeyId,
  AWS_SECRET_ACCESS_KEY: creds.Credentials.SecretAccessKey,
  AWS_SESSION_TOKEN: creds.Credentials.SessionToken,
  AWS_REGION: cfg.region,
};
const aws = (argv: string[]) => run('aws', argv, roleEnv);

// 4. Upload in order, then clean up, then invalidate.
const existing = (JSON.parse(
  aws([
    's3api',
    'list-objects-v2',
    '--bucket',
    bucket,
    '--query',
    'Contents[].Key',
    '--output',
    'json',
  ]) || 'null',
) ?? []) as string[];
const plan = planDeploy(local, previous, existing);
for (const u of plan.uploads) {
  aws([
    's3api',
    'put-object',
    '--bucket',
    bucket,
    '--key',
    u.key,
    '--body',
    join(root, 'web/dist', u.key),
    '--content-type',
    u.contentType,
    '--cache-control',
    u.cacheControl,
  ]);
  say(`  put ${u.key}`);
}
// The bucket is versioned and denies DeleteObjectVersion: deletes add delete markers, old versions stay
// (30-day noncurrent expiry) so what was served can be reconstructed after an incident.
for (const key of plan.deletes) {
  aws(['s3api', 'delete-object', '--bucket', bucket, '--key', key]);
  say(`  delete ${key}`);
}
const invalidation = aws([
  'cloudfront',
  'create-invalidation',
  '--distribution-id',
  distribution,
  '--paths',
  // Hashed assets never change; everything else may be cached up to 5 minutes (index.html is no-store).
  ...plan.uploads.filter((u) => !u.path.startsWith('/assets/')).map((u) => u.path),
  '--query',
  'Invalidation.Id',
  '--output',
  'text',
]);
say(`Invalidation ${invalidation} created`);

// 5. Record what is deployed, for the monitor.
run('gh', ['variable', 'set', variable, '--body', tag]);
const siteUrl = outputs.SiteUrl ?? '<site url>';
say(`Deployed ${tag} to ${stage}. Next: node scripts/verify-live.ts ${stage} ${siteUrl} ${tag}`);
