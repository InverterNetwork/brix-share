import { describe, expect, it } from 'vitest';
import { planDeploy } from '../deploy-plan.ts';
import { diffFiles, parseManifest } from '../manifest.ts';

const h = (c: string) => c.repeat(64);

describe('deploy plan', () => {
  const current = {
    '/index.html': h('a'),
    '/robots.txt': h('b'),
    '/favicon.svg': h('c'),
    '/assets/index-NEW.js': h('d'),
    '/assets/index-NEW.css': h('e'),
    '/assets/worker-NEW.js': h('f'),
    '/assets/DMMono-400-x.woff2': h('1'),
    '/assets/Title-Regular-x.otf': h('2'),
  };

  it('uploads hashed assets first and index.html last, with explicit types and caching', () => {
    const plan = planDeploy(current, null, []);
    const order = plan.uploads.map((u) => u.path);
    expect(order.at(-1)).toBe('/index.html');
    expect(order.slice(0, 5).every((p) => p.startsWith('/assets/'))).toBe(true);
    const by = Object.fromEntries(plan.uploads.map((u) => [u.path, u]));
    expect(by['/index.html']).toMatchObject({
      key: 'index.html',
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-store',
    });
    expect(by['/assets/index-NEW.js']).toMatchObject({
      contentType: 'text/javascript; charset=utf-8',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    expect(by['/assets/index-NEW.css']!.contentType).toBe('text/css; charset=utf-8');
    expect(by['/assets/DMMono-400-x.woff2']!.contentType).toBe('font/woff2');
    expect(by['/assets/Title-Regular-x.otf']!.contentType).toBe('font/otf');
    expect(by['/robots.txt']).toMatchObject({
      contentType: 'text/plain; charset=utf-8',
      cacheControl: 'public, max-age=300',
    });
  });

  it('keeps the previous release one more round and deletes older files', () => {
    const previous = {
      '/index.html': h('9'),
      '/assets/index-OLD.js': h('8'),
      '/assets/worker-OLD.js': h('7'),
    };
    const existing = [
      'index.html',
      'assets/index-OLD.js',
      'assets/worker-OLD.js',
      'assets/index-ANCIENT.js',
      'stray.html',
    ];
    expect(planDeploy(current, previous, existing).deletes).toEqual([
      'assets/index-ANCIENT.js',
      'stray.html',
    ]);
    expect(planDeploy(current, null, existing).deletes).toEqual([
      'assets/index-ANCIENT.js',
      'assets/index-OLD.js',
      'assets/worker-OLD.js',
      'stray.html',
    ]);
  });

  it('refuses files without a known content type', () => {
    expect(() => planDeploy({ '/assets/x.wasm': h('a') }, null, [])).toThrow(/content type/);
  });
});

describe('manifest', () => {
  it('diffs file maps', () => {
    expect(
      diffFiles({ '/a': h('1'), '/b': h('2') }, { '/a': h('1'), '/b': h('3'), '/c': h('4') }),
    ).toEqual(['changed /b', 'unexpected /c']);
    expect(diffFiles({ '/a': h('1') }, {})).toEqual(['missing /a']);
  });

  it('parses and validates', () => {
    expect(parseManifest(JSON.stringify({ release: 'v1', files: { '/a': h('1') } })).files).toEqual(
      { '/a': h('1') },
    );
    expect(() => parseManifest(JSON.stringify({ files: { a: h('1') } }))).toThrow();
    expect(() => parseManifest(JSON.stringify({ files: { '/a': 'nope' } }))).toThrow();
  });
});
