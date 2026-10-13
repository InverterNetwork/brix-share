/**
 * Local stand-in for CloudFront in front of S3 and the API Lambda, for the Playwright suite.
 * - static files from web/dist with the production security headers, the SPA rewrite of the CloudFront
 *   function and the cache headers the upload script sets (index.html no-store, hashed assets immutable);
 * - /api/* into the real API handler (`handle`) on DynamoDB Local with in-memory SSM parameters;
 * - enforces x-amz-content-sha256 like CloudFront OAC on Lambda Function URLs;
 * - adds CloudFront-Viewer-Country;
 * - test-only hooks: `x-test-drop-response` (commit the request, then cut the connection) and /__kat.
 * Test infrastructure only; never deployed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { securityHeaders } from '@brix-share/shared';
import { handle } from '../../api/src/app.ts';
import type { Deps } from '../../api/src/deps.ts';
import { Responder } from '../../api/src/http.ts';
import { cachedParams, type ParamStore } from '../../api/src/params.ts';
import { MemoryStore as FileMemoryStore } from '../../api/src/files.ts';
import { Repo, documentClients } from '../../api/src/repo.ts';
import { cacheControl, contentType } from '../delivery.ts';

const PORT = Number(process.env.PORT ?? 4173);
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const KAT_DIR = fileURLToPath(new URL('./.kat/', import.meta.url));
// Fake S3 for attachments: a second local server at its own origin, like the files bucket.
const FILES_PORT = Number(process.env.FILES_PORT ?? PORT + 1);
export const FILES_ORIGIN = `http://127.0.0.1:${FILES_PORT}`;
const SITE_ORIGIN = `http://127.0.0.1:${PORT}`;
// Test-only clock offsets per secret id for the fake S3: one test can push its presigned URLs past their
// expiry without affecting tests running in parallel.
const filesClockOffsets = new Map<string, number>();
const files = new FileMemoryStore(FILES_ORIGIN);
const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8000';

class MemoryStore implements ParamStore {
  values = new Map<string, string>([
    ['/e2e/powDifficulty', process.env.POW_DIFFICULTY ?? '8'],
    ['/e2e/createEnabled', 'true'],
  ]);
  get(name: string) {
    return Promise.resolve(this.values.get(name));
  }
  createSecure(name: string, value: string) {
    if (this.values.has(name)) return Promise.resolve(false);
    this.values.set(name, value);
    return Promise.resolve(true);
  }
}

async function makeDeps(): Promise<Deps> {
  const clients = documentClients(endpoint);
  const table = `e2e${randomBytes(4).toString('hex')}`;
  await clients.read.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    }),
  );
  return {
    repo: new Repo(clients, table),
    params: cachedParams(new MemoryStore(), '/e2e'),
    files,
    http: new Responder(FILES_ORIGIN),
    now: () => Math.floor(Date.now() / 1000) + Number(process.env.CLOCK_SKEW_SEC ?? 0),
  };
}

const staticHeaders = securityHeaders(FILES_ORIGIN);
const withoutCoop = Object.fromEntries(
  Object.entries(staticHeaders).filter(([k]) => k !== 'cross-origin-opener-policy'),
);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function serveApi(deps: Deps, req: IncomingMessage, res: ServerResponse, path: string) {
  const body = await readBody(req);
  const method = req.method ?? 'GET';
  // CloudFront OAC: the viewer must send the SHA-256 of the body for requests with a body; Lambda rejects
  // mismatches with 403. The app always sends it, so check it on every non-GET request.
  if (method !== 'GET' && method !== 'HEAD') {
    const expected = createHash('sha256').update(body).digest('hex');
    if (req.headers['x-amz-content-sha256'] !== expected) {
      res
        .writeHead(403, { 'content-type': 'application/json' })
        .end('{"message":"signature mismatch"}');
      return;
    }
  }
  const headers: Record<string, string> = {};
  for (const name of ['x-manage-token', 'x-consume-token', 'content-type']) {
    const v = req.headers[name];
    if (typeof v === 'string') headers[name] = v;
  }
  headers['cloudfront-viewer-country'] = 'DE';
  const result = await handle(deps, {
    rawPath: path,
    headers,
    requestContext: { http: { method } },
    ...(body.length ? { body: body.toString('base64'), isBase64Encoded: true } : {}),
  });
  if (req.headers['x-test-drop-response'] === '1') {
    req.socket.destroy();
    return;
  }
  res.writeHead(result.statusCode, result.headers).end(result.body);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
  if (path === '/__kat') {
    // Test-only page without CSP that runs the crypto module's known-answer checks (see kat.spec.ts).
    res.writeHead(200, { 'content-type': contentType('.html'), 'cache-control': 'no-store' });
    res.end(
      '<!doctype html><meta charset="utf-8"><title>kat</title><script type="module" src="/__kat.js"></script>',
    );
    return;
  }
  if (path === '/__kat.js') {
    res.writeHead(200, { 'content-type': contentType('.js'), 'cache-control': 'no-store' });
    res.end(await readFile(join(KAT_DIR, 'kat.js')));
    return;
  }
  // Same rule as the CloudFront viewer-request function: extensionless paths serve index.html.
  const last = path.slice(path.lastIndexOf('/') + 1);
  const file = last.includes('.') ? normalize(path).replace(/^(\.\.[/\\])+/, '') : '/index.html';
  try {
    const content = await readFile(join(DIST, file));
    // Test-only: Playwright's Firefox driver intermittently loses a navigation across the process swap that
    // Cross-Origin-Opener-Policy triggers; the Firefox project asks for pages without it (see DECISIONS).
    const headers = req.headers['x-e2e-no-coop'] === '1' ? withoutCoop : staticHeaders;
    res.writeHead(200, {
      ...headers,
      'content-type': contentType(file),
      'cache-control': cacheControl(file),
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch {
    res.writeHead(404, { ...staticHeaders, 'content-type': contentType('.txt') }).end('not found');
  }
}

const deps = await makeDeps();
createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const run = path.startsWith('/api/')
    ? serveApi(deps, req, res, path)
    : serveStatic(req, res, path);
  run.catch(() => {
    if (!res.headersSent) res.writeHead(500).end();
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`e2e server on http://127.0.0.1:${PORT}`);
});

/** S3 stand-in: presigned-style grants from MemoryStore, CORS like the bucket (site origin, PUT and GET). */
createServer((req, res) => {
  const cors = {
    'access-control-allow-origin': req.headers.origin === SITE_ORIGIN ? SITE_ORIGIN : 'null',
    'access-control-allow-methods': 'PUT, GET',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '300',
    vary: 'Origin',
  };
  const url = new URL(req.url ?? '/', FILES_ORIGIN);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return;
  }
  if (url.pathname === '/__clock' && req.method === 'POST') {
    filesClockOffsets.set(
      url.searchParams.get('id') ?? '',
      Number(url.searchParams.get('offset') ?? 0),
    );
    res.writeHead(204, cors).end();
    return;
  }
  void readBody(req).then((body) => {
    const key = url.pathname.slice(1);
    const at =
      Math.floor(Date.now() / 1000) + (filesClockOffsets.get(key.split('/')[0] ?? '') ?? 0);
    const r = files.handle(
      req.method ?? 'GET',
      key,
      url.searchParams.get('token'),
      req.method === 'PUT' ? new Uint8Array(body) : undefined,
      at,
    );
    res.writeHead(r.status, { ...cors, 'content-type': 'application/octet-stream' });
    res.end(r.bytes ? Buffer.from(r.bytes) : undefined);
  });
}).listen(FILES_PORT, '127.0.0.1');
