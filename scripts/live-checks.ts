/**
 * Checks of what a live stage serves, used by verify-live (after a deploy) and the hourly monitor.
 * They look at both things an attacker controlling delivery would change: file contents and headers.
 */
import { randomBytes } from 'node:crypto';
import { filesBucketName, filesBucketOrigin, securityHeaders } from '../shared/src/headers.ts';
import { cacheControl, contentType } from '../web/delivery.ts';
import { sha256Hex } from './manifest.ts';

/** Browser-like User-Agents; the WAF common rule set blocks requests without one. Rotated per run. */
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
];
export const userAgent = USER_AGENTS[randomBytes(1)[0]! % USER_AGENTS.length]!;

export const randomId = () => randomBytes(16).toString('base64url');

/** GET without cache busting: the point is to see what users get. Node's fetch decompresses bodies. */
export async function get(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<{ res: Response; body: Uint8Array }> {
  const res = await fetch(new URL(path, base), {
    ...init,
    headers: { 'user-agent': userAgent, ...(init.headers as Record<string, string> | undefined) },
    redirect: 'manual',
  });
  return { res, body: new Uint8Array(await res.arrayBuffer()) };
}

/** Bucket host the CSP must allow, as configured for the stage (read from the served CSP itself). */
export function filesOriginFromCsp(csp: string | null): string | null {
  return /connect-src 'self' (https?:\/\/[^\s;]+)/.exec(csp ?? '')?.[1] ?? null;
}

function checkHeaders(failures: string[], label: string, res: Response, filesOrigin: string): void {
  for (const [name, value] of Object.entries(securityHeaders(filesOrigin))) {
    const got = res.headers.get(name);
    if (got !== value)
      failures.push(
        `${label}: header ${name} is ${JSON.stringify(got)}, expected ${JSON.stringify(value)}`,
      );
  }
  // CloudFront always sets its own `Server: CloudFront`; the origin's (e.g. AmazonS3) must be gone.
  const server = res.headers.get('server');
  if (server && server !== 'CloudFront')
    failures.push(`${label}: origin Server header present (${server})`);
}

/**
 * Delivery checks. With `files` (a release manifest) every file must be served byte-identical, with its
 * content type and caching, and index.html must be identical on /, /index.html and an SPA path.
 */
export async function checkDelivery(
  base: string,
  files: Record<string, string> | null,
  /** The files bucket origin the CSP must allow, from the stage config; never taken from the response. */
  expectedFilesOrigin: string,
): Promise<string[]> {
  const failures: string[] = [];
  const root = await get(base, '/');
  if (root.res.status !== 200) return [`/ answered ${root.res.status}`];
  const filesOrigin = expectedFilesOrigin;
  const served = filesOriginFromCsp(root.res.headers.get('content-security-policy'));
  if (served !== filesOrigin) {
    return [`/: CSP allows ${served ?? 'no files origin'} instead of ${filesOrigin}`];
  }

  const spaPaths = [
    '/',
    '/index.html',
    `/s/${randomId()}`,
    `/m/${randomId()}`,
    '/about',
    '/how-it-works',
    '/privacy',
    '/acceptable-use',
  ];
  const indexHashes = new Set<string>();
  for (const path of spaPaths) {
    const { res, body } = path === '/' ? root : await get(base, path);
    if (res.status !== 200) failures.push(`${path}: status ${res.status}`);
    checkHeaders(failures, path, res, filesOrigin);
    if (res.headers.get('cache-control') !== 'no-store')
      failures.push(`${path}: cache-control ${res.headers.get('cache-control')}`);
    if (res.headers.get('content-type') !== contentType('/index.html'))
      failures.push(`${path}: content-type ${res.headers.get('content-type')}`);
    indexHashes.add(sha256Hex(body));
  }
  if (indexHashes.size !== 1)
    failures.push('index.html differs between /, /index.html and SPA paths');
  if (files && !indexHashes.has(files['/index.html'] ?? ''))
    failures.push('index.html differs from the release manifest');

  const api = await get(base, '/api/health');
  if (api.res.status !== 200) failures.push(`/api/health: status ${api.res.status}`);
  checkHeaders(failures, '/api/health', api.res, filesOrigin);
  if (api.res.headers.get('cache-control') !== 'no-store')
    failures.push('/api/health: cache-control is not no-store');

  if (files) {
    for (const [path, hash] of Object.entries(files)) {
      if (path === '/index.html') continue;
      const { res, body } = await get(base, path);
      if (res.status !== 200) {
        failures.push(`${path}: status ${res.status}`);
        continue;
      }
      if (sha256Hex(body) !== hash)
        failures.push(`${path}: content differs from the release manifest`);
      if (res.headers.get('content-type') !== contentType(path))
        failures.push(`${path}: content-type ${res.headers.get('content-type')}`);
      if (res.headers.get('cache-control') !== cacheControl(path))
        failures.push(`${path}: cache-control ${res.headers.get('cache-control')}`);
      checkHeaders(failures, path, res, filesOrigin);
    }
  }
  return failures;
}

/** Files bucket origin of a stage, derived exactly as the stack names the bucket. */
export function stageFilesOrigin(stage: string, bucketSuffix: string, region: string): string {
  return filesBucketOrigin(filesBucketName(stage, bucketSuffix), region);
}
