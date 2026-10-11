import { IdSchema, MAX_BODY_BYTES } from '@brix-share/shared';
import type { Deps } from './deps.ts';
import type { FunctionUrlEvent, FunctionUrlResult } from './http.ts';
import { logEvent } from './log.ts';
import { getChallenge } from './routes/challenge.ts';
import { consumeSecret, getAvailability } from './routes/consume.ts';
import { createSecret } from './routes/create.ts';
import { deleteSecret, finalizeSecret, getStatus } from './routes/manage.ts';

type Route = {
  template: string;
  run: (
    deps: Deps,
    event: FunctionUrlEvent,
    body: string,
    id: string,
  ) => Promise<FunctionUrlResult>;
};

const SECRET_PATH = /^\/api\/secrets\/([^/]+)(\/consume|\/status|\/finalize)?$/;

function match(
  method: string,
  path: string,
): Route | { template: string; id: string; run: Route['run'] } | undefined {
  if (path === '/api/health' && method === 'GET')
    return { template: 'health', run: (d) => Promise.resolve(d.http.empty(200)) };
  if (path === '/api/challenge' && method === 'GET')
    return { template: 'challenge', run: (d) => getChallenge(d) };
  if (path === '/api/secrets' && method === 'POST')
    return { template: 'create', run: (d, _e, b) => createSecret(d, b) };
  const m = SECRET_PATH.exec(path);
  if (!m) return undefined;
  const id = m[1]!;
  if (!IdSchema.safeParse(id).success) return undefined;
  const sub = m[2];
  if (sub === '/consume' && method === 'POST')
    return { template: 'consume', id, run: (d, e) => consumeSecret(d, id, e) };
  if (sub === '/finalize' && method === 'POST')
    return { template: 'finalize', id, run: (d, e) => finalizeSecret(d, id, e) };
  if (sub === '/status' && method === 'GET')
    return { template: 'status', id, run: (d, e) => getStatus(d, id, e) };
  if (sub === undefined && method === 'GET')
    return { template: 'availability', id, run: (d) => getAvailability(d, id) };
  if (sub === undefined && method === 'DELETE')
    return { template: 'delete', id, run: (d, e) => deleteSecret(d, id, e) };
  return undefined;
}

/** Decoded request body, or undefined when it is over the cap (checked before decoding base64). */
function decodeBody(event: FunctionUrlEvent): Buffer | undefined {
  if (!event.body) return Buffer.alloc(0);
  if (event.isBase64Encoded) {
    if (Math.floor((event.body.length * 3) / 4) > MAX_BODY_BYTES + 2) return undefined;
    const buf = Buffer.from(event.body, 'base64');
    return buf.length > MAX_BODY_BYTES ? undefined : buf;
  }
  if (event.body.length > MAX_BODY_BYTES) return undefined;
  const buf = Buffer.from(event.body, 'utf8');
  return buf.length > MAX_BODY_BYTES ? undefined : buf;
}

export async function handle(deps: Deps, event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const started = Date.now();
  const method = event.requestContext.http.method;
  const route = match(method, event.rawPath);
  let res: FunctionUrlResult;
  try {
    if (!route) {
      res = deps.http.error('not_found', 'Not found.');
    } else {
      const body = decodeBody(event);
      res =
        body === undefined
          ? deps.http.error('payload_too_large', 'Request body too large.')
          : await route.run(deps, event, body.toString('utf8'), 'id' in route ? route.id : '');
    }
  } catch (e) {
    // Error names only: messages from the SDK can echo request data.
    logEvent({
      event: 'error',
      route: route?.template ?? 'none',
      name: e instanceof Error ? e.name : 'unknown',
    });
    res = deps.http.error('internal', 'Something went wrong. Please try again.');
  }
  logEvent({
    event: 'request',
    route: route?.template ?? 'none',
    method,
    status: res.statusCode,
    ms: Date.now() - started,
  });
  return res;
}
