import { IdSchema, KEY_BYTES, MANAGE_TOKEN_BYTES, isB64urlOfLength } from '@brix-share/shared';

export type Route =
  | { name: 'create' }
  | { name: 'reveal'; id: string; key: string | null }
  | { name: 'manage'; id: string; token: string | null }
  | { name: 'how' }
  | { name: 'privacy' }
  | { name: 'acceptable' }
  | { name: 'notfound' };

/**
 * Maps a path and fragment to a route. A fragment that is not a well-formed key or token is treated as
 * missing; a malformed id is a 404, decided without any request.
 */
export function parseRoute(pathname: string, fragment: string): Route {
  if (pathname === '/' || pathname === '') return { name: 'create' };
  // /about was the combined page before v1.1.
  if (pathname === '/how-it-works' || pathname === '/about') return { name: 'how' };
  if (pathname === '/privacy') return { name: 'privacy' };
  if (pathname === '/acceptable-use') return { name: 'acceptable' };
  const m = /^\/(s|m)\/([^/]+)$/.exec(pathname);
  if (!m) return { name: 'notfound' };
  const id = m[2]!;
  if (!IdSchema.safeParse(id).success) return { name: 'notfound' };
  if (m[1] === 's')
    return { name: 'reveal', id, key: isB64urlOfLength(fragment, KEY_BYTES) ? fragment : null };
  return {
    name: 'manage',
    id,
    token: isB64urlOfLength(fragment, MANAGE_TOKEN_BYTES) ? fragment : null,
  };
}

export function pathOf(route: Route): string {
  switch (route.name) {
    case 'create':
      return '/';
    case 'how':
      return '/how-it-works';
    case 'privacy':
      return '/privacy';
    case 'acceptable':
      return '/acceptable-use';
    case 'reveal':
      return `/s/${route.id}`;
    case 'manage':
      return `/m/${route.id}`;
    case 'notfound':
      return location.pathname;
  }
}

/**
 * Reads the fragment exactly once and removes it from the address bar and the current history entry
 * (PLAN section 6). Keys then live only in memory.
 */
export function takeInitialRoute(loc: Location = location, hist: History = history): Route {
  const fragment = loc.hash.startsWith('#') ? loc.hash.slice(1) : loc.hash;
  const route = parseRoute(loc.pathname, fragment);
  if (loc.hash) hist.replaceState(null, '', loc.pathname);
  return route;
}
