import { describe, expect, it, vi } from 'vitest';
import { parseRoute, takeInitialRoute } from '../src/router.ts';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const KEY = 'A'.repeat(43);

describe('router', () => {
  it('maps paths and accepts only well-formed fragments', () => {
    expect(parseRoute('/', '')).toEqual({ name: 'create' });
    expect(parseRoute('/how-it-works', '')).toEqual({ name: 'how' });
    expect(parseRoute('/about', '')).toEqual({ name: 'how' });
    expect(parseRoute('/verify', '')).toEqual({ name: 'verify' });
    expect(parseRoute('/privacy', '')).toEqual({ name: 'privacy' });
    expect(parseRoute('/acceptable-use', '')).toEqual({ name: 'acceptable' });
    expect(parseRoute(`/s/${ID}`, KEY)).toEqual({ name: 'reveal', id: ID, key: KEY });
    expect(parseRoute(`/s/${ID}`, 'short')).toEqual({ name: 'reveal', id: ID, key: null });
    expect(parseRoute(`/m/${ID}`, KEY)).toEqual({ name: 'manage', id: ID, token: KEY });
    for (const p of ['/s/short', `/s/${ID}/x`, '/s/AAAAAAAAAAAAAAAAAAAAAB', '/x', `/S/${ID}`]) {
      expect(parseRoute(p, KEY), p).toEqual({ name: 'notfound' });
    }
  });

  it('reads the fragment once and strips it from the address bar', () => {
    const replaceState = vi.fn();
    const route = takeInitialRoute(
      { pathname: `/s/${ID}`, hash: `#${KEY}` } as Location,
      { replaceState } as unknown as History,
    );
    expect(route).toEqual({ name: 'reveal', id: ID, key: KEY });
    expect(replaceState).toHaveBeenCalledWith(null, '', `/s/${ID}`);
    const none = vi.fn();
    takeInitialRoute(
      { pathname: '/', hash: '' } as Location,
      { replaceState: none } as unknown as History,
    );
    expect(none).not.toHaveBeenCalled();
  });
});
