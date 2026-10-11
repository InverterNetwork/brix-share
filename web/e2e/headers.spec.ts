import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';

const ROUTES = [
  '/',
  '/how-it-works',
  '/privacy',
  '/verify',
  '/acceptable-use',
  '/s/AAAAAAAAAAAAAAAAAAAAAA',
  '/m/AAAAAAAAAAAAAAAAAAAAAA',
  '/robots.txt',
  '/api/health',
  '/api/challenge',
  '/api/nope',
  '/api/secrets/AAAAAAAAAAAAAAAAAAAAAA/finalize',
];

test('security headers on every route', async ({ request }) => {
  for (const path of ROUTES) {
    const res = await request.get(path);
    const h = res.headers();
    expect(h['content-security-policy'], path).toContain("default-src 'none'");
    expect(h['content-security-policy'], path).toContain("script-src 'self'");
    expect(h['content-security-policy'], path).not.toContain('unsafe');
    expect(h['strict-transport-security'], path).toContain('max-age=63072000');
    expect(h['referrer-policy'], path).toBe('no-referrer');
    expect(h['x-content-type-options'], path).toBe('nosniff');
    expect(h['x-robots-tag'], path).toBe('noindex, nofollow');
    expect(h['cross-origin-opener-policy'], path).toBe('same-origin');
    expect(h['cross-origin-resource-policy'], path).toBe('same-origin');
    expect(h['permissions-policy'], path).toContain('camera=()');
  }
  const index = await request.get('/');
  expect(index.headers()['cache-control']).toBe('no-store');
  expect((await request.get('/api/challenge')).headers()['cache-control']).toBe('no-store');
  expect(await (await request.get('/robots.txt')).text()).toContain('Disallow: /');
});

test('index.html has SRI on every script and stylesheet and no inline code', async ({
  request,
}) => {
  const html = await (await request.get('/')).text();
  const tags = html.match(/<(script|link rel="stylesheet")[^>]*>/g) ?? [];
  expect(tags.length).toBeGreaterThanOrEqual(2);
  for (const t of tags) {
    const integrity = /integrity="(sha384-[A-Za-z0-9+/=]+)"/.exec(t)?.[1];
    const url = /(?:src|href)="([^"]+)"/.exec(t)?.[1];
    expect(integrity, t).toBeDefined();
    const body = await (await request.get(url!)).body();
    expect(integrity).toBe(`sha384-${createHash('sha384').update(body).digest('base64')}`);
  }
  expect(html).not.toMatch(/<script(?![^>]*src=)[^>]*>/);
  expect(html).not.toMatch(/<style|style="/);
});
