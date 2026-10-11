/**
 * How each built file is served: content type and Cache-Control. One table for the deploy upload and the
 * e2e test server, so tests exercise exactly what production serves. Every file gets an explicit type:
 * `X-Content-Type-Options: nosniff` makes browsers refuse scripts and styles served with a guessed one.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

export function extension(path: string): string {
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot === -1 ? '' : last.slice(dot).toLowerCase();
}

export function contentType(path: string): string {
  const type = TYPES[extension(path)];
  if (!type) throw new Error(`no content type for ${path}`);
  return type;
}

/** Hashed assets never change; index.html must never be cached; the rest briefly. */
export function cacheControl(path: string): string {
  if (path === '/index.html') return 'no-store';
  if (path.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=300';
}
