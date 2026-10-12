import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { securityHeaders } from '../../shared/src/headers.ts';
import { cacheControl, contentType } from '../../web/delivery.ts';
import { checkDelivery } from '../live-checks.ts';
import { sha256Hex } from '../manifest.ts';

const ORIGIN = 'https://files-bucket.s3.eu-central-1.amazonaws.com';
const SITE: Record<string, string> = {
  '/index.html': '<!doctype html><script type="module" src="/assets/index-a.js"></script>',
  '/assets/index-a.js': 'console.log(1)',
  '/assets/worker-a.js': 'self.onmessage=()=>{}',
  '/robots.txt': 'User-agent: *\nDisallow: /\n',
};
const MANIFEST = Object.fromEntries(Object.entries(SITE).map(([p, c]) => [p, sha256Hex(c)]));

interface Tamper {
  file?: [string, string];
  spaIndex?: string;
  dropHeader?: string;
  cache?: string;
  age?: string;
}

let server: Server | undefined;
afterEach(() => server?.close());

async function site(t: Tamper = {}): Promise<string> {
  const files = { ...SITE, ...(t.file ? { [t.file[0]]: t.file[1] } : {}) };
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const headers = Object.fromEntries(
      Object.entries(securityHeaders(ORIGIN)).filter(([k]) => k !== t.dropHeader),
    );
    if (path === '/api/health')
      return void res.writeHead(200, { ...headers, 'cache-control': 'no-store' }).end();
    const isSpa = !path.slice(path.lastIndexOf('/') + 1).includes('.');
    const file = isSpa ? '/index.html' : path;
    const body = isSpa && path.startsWith('/s/') && t.spaIndex ? t.spaIndex : files[file];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, {
      ...headers,
      'content-type': contentType(file),
      ...(t.age === undefined ? {} : { age: t.age }),
      'cache-control': t.cache && file === '/index.html' ? t.cache : cacheControl(file),
    });
    res.end(body);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('checkDelivery', () => {
  it('passes when everything matches the release', async () => {
    expect(await checkDelivery(await site(), MANIFEST, ORIGIN)).toEqual([]);
  });

  it('checks the deployed version on every document path', async () => {
    const html = '<meta name="brix-share-version" content="v1.3.0 abc1234">';
    const base = await site({ file: ['/index.html', html] });
    expect(await checkDelivery(base, null, ORIGIN, 'v1.3.0')).toEqual([]);
    expect(
      (await checkDelivery(base, null, ORIGIN, 'v1.2.0')).some((f) =>
        f.includes('/verify: build version'),
      ),
    ).toBe(true);
  });
  it('rejects missing build metadata', async () => {
    expect(
      (await checkDelivery(await site(), MANIFEST, ORIGIN, 'v1.3.0')).some((f) =>
        f.includes('build version'),
      ),
    ).toBe(true);
  });

  it('rejects duplicated build metadata even when both versions match', async () => {
    const html = '<meta name="brix-share-version" content="v1.3.0 abc1234">'.repeat(2);
    expect(
      (
        await checkDelivery(await site({ file: ['/index.html', html] }), null, ORIGIN, 'v1.3.0')
      ).some((f) => f.includes('build version')),
    ).toBe(true);
  });

  it('catches a tampered asset, including one only referenced from JS', async () => {
    const f = await checkDelivery(
      await site({ file: ['/assets/worker-a.js', 'evil()'] }),
      MANIFEST,
      ORIGIN,
    );
    expect(f).toContain('/assets/worker-a.js: content differs from the release manifest');
  });

  it('catches a different index served only on share paths (cloaked rewrite)', async () => {
    const f = await checkDelivery(
      await site({ spaIndex: '<script src="/evil.js"></script>' }),
      MANIFEST,
      ORIGIN,
    );
    expect(f).toContain('index.html differs between /, /index.html and SPA paths');
  });

  it.each(['0', '1'])('rejects Age=%s on no-store documents', async (age) => {
    const failures = await checkDelivery(await site({ age }), MANIFEST, ORIGIN);
    expect(failures).toContain(`/: Age header present (${age})`);
    expect(failures).toContain(`/index.html: Age header present (${age})`);
    expect(failures.some((f) => /^\/s\/[^:]+: Age header present/.test(f))).toBe(true);
  });

  it('catches weakened headers and caching', async () => {
    expect(
      (
        await checkDelivery(
          await site({ dropHeader: 'cross-origin-opener-policy' }),
          MANIFEST,
          ORIGIN,
        )
      ).some((x) => x.includes('cross-origin-opener-policy')),
    ).toBe(true);
    expect(
      (await checkDelivery(await site({ cache: 'public, max-age=3600' }), MANIFEST, ORIGIN)).some(
        (x) => x.includes('cache-control'),
      ),
    ).toBe(true);
    expect(
      await checkDelivery(await site({ dropHeader: 'content-security-policy' }), MANIFEST, ORIGIN),
    ).toEqual([`/: CSP allows no files origin instead of ${ORIGIN}`]);
  });

  it('catches a CSP that allows a different files origin than the stage config', async () => {
    const f = await checkDelivery(
      await site(),
      MANIFEST,
      'https://brix-share-prod-files-1.s3.eu-central-1.amazonaws.com',
    );
    expect(f[0]).toMatch(/^\/: CSP allows https:\/\/files-bucket/);
  });
});

describe('canonical redirects', () => {
  it('checks the root and original share/manage paths without following redirects', async () => {
    const { checkCanonicalRedirect } = await import('../live-checks.ts');
    server = createServer((req, res) =>
      res.writeHead(301, { location: `https://share.example.com${req.url}` }).end(),
    );
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    expect(
      await checkCanonicalRedirect(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        'https://share.example.com',
      ),
    ).toEqual([]);
  });

  it('fails on the wrong host, rewritten paths or a non-301 response', async () => {
    const { checkCanonicalRedirect } = await import('../live-checks.ts');
    server = createServer((_req, res) =>
      res.writeHead(302, { location: 'https://other.example.com/index.html' }).end(),
    );
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const failures = await checkCanonicalRedirect(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      'https://share.example.com',
    );
    expect(failures).toHaveLength(3);
    expect(failures.every((f) => f.includes('got 302'))).toBe(true);
  });
});
