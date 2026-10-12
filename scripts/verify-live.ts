/**
 * End-to-end verification of a deployed stage with the real client crypto (web/src/crypto) and PoW solver.
 * Usage: node scripts/verify-live.ts <stage> <base-url> [release-tag] [--local]
 * With a tag, every served file is compared with that release's manifest (downloaded with gh).
 * Creates 6 secrets (WAF allows 20 per 5 minutes per IP: do not run it twice back to back).
 * Writes every id, token, key and ciphertext it produced to a temp file for scripts/scrub-logs.ts.
 */
import { readStageFile } from '../infra/lib/stage-file.ts';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  b64urlEncode,
  hashManageToken,
  secToIso,
  type ConsumeResponse,
  type Envelope,
} from '../shared/src/index.ts';
import {
  checkEnvelope,
  deriveKey,
  envelopeSalt,
  newId,
  newLinkKey,
  newManageToken,
  newSalt,
  openFile,
  openText,
  sealFile,
  sealText,
} from '../web/src/crypto/envelope.ts';
import { solvePow } from '../web/src/pow/solver.ts';
import {
  checkDelivery,
  filesOriginFromCsp,
  get,
  randomId,
  stageFilesOrigin,
  userAgent,
} from './live-checks.ts';
import { parseManifest, sha256Hex } from './manifest.ts';

const argv = process.argv.slice(2);
// --local: against web/e2e/server.ts, which has no CloudFront OAC or WAF in front of it.
const local = argv.includes('--local');
const [stage, base, tag] = argv.filter((a) => !a.startsWith('--'));
if (!stage || !base) {
  console.error('usage: node scripts/verify-live.ts <stage> <base-url> [release-tag] [--local]');
  process.exit(2);
}

const stages = readStageFile() as Record<string, { filesBucketSuffix: string; region: string }>;
if (!local && !stages[stage]) throw new Error(`unknown stage ${stage}`);

const terms: string[] = [];
const failures: string[] = [];
let checks = 0;
const check = (ok: boolean, label: string) => {
  checks++;
  if (!ok) failures.push(label);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}\n`);
};

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const res = await fetch(new URL(path, base), {
    method,
    headers: {
      'user-agent': userAgent,
      'x-amz-content-sha256': sha256Hex(text),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? null : text,
  });
  const raw = await res.text();
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = raw;
  }
  return { status: res.status, json: json as Record<string, unknown> | null, headers: res.headers };
}

interface Made {
  id: string;
  kLink: Uint8Array<ArrayBuffer>;
  token: string;
  passphrase: string | null;
  envelope: Envelope;
}

async function create(opts: {
  maxViews: number | null;
  availableIn?: number;
  passphrase?: string;
  text: string;
  files?: Uint8Array<ArrayBuffer>[];
}): Promise<Made> {
  const id = newId();
  const kLink = newLinkKey();
  const salt = opts.passphrase ? newSalt() : null;
  const token = newManageToken();
  const key = await deriveKey(kLink, opts.passphrase ?? null, salt);
  const attachments = await Promise.all(
    (opts.files ?? []).map(async (bytes, i) => {
      const fileId = newId();
      return {
        fileId,
        bytes,
        stored: await sealFile(id, fileId, key, bytes),
        name: `verify-${i}.bin`,
      };
    }),
  );
  const envelope = await sealText({
    id,
    key,
    salt,
    payload: {
      title: 'verify-live',
      text: opts.text,
      files: attachments.map((a) => ({
        fileId: a.fileId,
        name: a.name,
        size: a.bytes.length,
        mime: 'application/octet-stream',
      })),
    },
  });
  const ch = await api('GET', '/api/challenge');
  const challenge = ch.json!.challenge as string;
  const now = Math.floor(Date.parse(ch.headers.get('date') ?? new Date().toUTCString()) / 1000);
  const nonce = solvePow(challenge, ch.json!.difficulty as number);
  const res = await api('POST', '/api/secrets', {
    envelope,
    policy: {
      maxViews: opts.maxViews,
      expiresAt: secToIso(now + 2 * 3600),
      availableFrom: opts.availableIn ? secToIso(now + opts.availableIn) : null,
    },
    manageTokenHash: await hashManageToken(token),
    pow: { challenge, nonce },
    files: attachments.map((a) => ({ fileId: a.fileId, size: a.bytes.length })),
  });
  terms.push(
    id,
    token,
    b64urlEncode(kLink),
    envelope.ct.slice(0, 40),
    await hashManageToken(token),
  );
  if (opts.passphrase) terms.push(opts.passphrase);
  if (res.status !== 201)
    throw new Error(`create failed: ${res.status} ${JSON.stringify(res.json)}`);
  const uploads = (res.json!.uploads ?? []) as { fileId: string; url: string }[];
  if (attachments.length) {
    const premature = await api('POST', `/api/secrets/${id}/finalize`, undefined, {
      'x-manage-token': token,
    });
    check(
      premature.status === 409,
      `finalize before any upload answers 409 (got ${premature.status})`,
    );
  }
  for (const a of attachments) {
    const url = uploads.find((u) => u.fileId === a.fileId)!.url;
    // The bucket's CORS rule must let the site upload from the browser.
    const pre = await fetch(url, {
      method: 'OPTIONS',
      headers: { origin: new URL(base!).origin, 'access-control-request-method': 'PUT' },
    });
    check(
      pre.headers.get('access-control-allow-origin') === new URL(base!).origin,
      `files bucket CORS allows uploads from ${new URL(base!).origin}`,
    );
    const put = await fetch(url, { method: 'PUT', body: a.stored });
    check(put.ok, `encrypted file uploaded with its presigned URL (${put.status})`);
    const tooBig = await fetch(url, { method: 'PUT', body: new Uint8Array(a.stored.length + 1) });
    check(!tooBig.ok, 'presigned PUT refuses a different length');
    await fetch(url, { method: 'PUT', body: a.stored });
  }
  if (attachments.length) {
    const early = await consume(id);
    check(early.status === 404, 'secret with files is not retrievable before finalize');
    const fin = await api('POST', `/api/secrets/${id}/finalize`, undefined, {
      'x-manage-token': token,
    });
    check(fin.status === 200, 'finalize releases the secret');
  }
  return { id, kLink, token, passphrase: opts.passphrase ?? null, envelope };
}

const consume = (id: string) => api('POST', `/api/secrets/${id}/consume`);
const status = (m: Made) =>
  api('GET', `/api/secrets/${m.id}/status`, undefined, { 'x-manage-token': m.token });

async function decrypts(
  m: Made,
  res: { json: Record<string, unknown> | null },
  passphrase: string | null,
  text: string,
) {
  const env = checkEnvelope((res.json as unknown as ConsumeResponse).envelope, m.id);
  const payload = await openText(env, await deriveKey(m.kLink, passphrase, envelopeSalt(env)));
  return payload.text === text;
}

async function edgeChecks() {
  const wrongHash = await fetch(new URL(`/api/secrets/${randomId()}/consume`, base), {
    method: 'POST',
    headers: { 'user-agent': userAgent, 'x-amz-content-sha256': sha256Hex('not the body') },
  });
  check(
    wrongHash.status === 403,
    `CloudFront OAC rejects a wrong body hash (got ${wrongHash.status})`,
  );
  const big = await fetch(new URL('/api/secrets', base), {
    method: 'POST',
    headers: {
      'user-agent': userAgent,
      'content-type': 'application/json',
      'x-amz-content-sha256': sha256Hex('x'.repeat(140_000)),
    },
    body: 'x'.repeat(140_000),
  });
  check(
    big.status === 403 || big.status === 413,
    `bodies over 128 KB are refused (got ${big.status})`,
  );
}

async function main() {
  process.stdout.write(`Verifying ${base}${tag ? ` against release ${tag}` : ''}\n`);

  let files: Record<string, string> | null = null;
  if (tag) {
    const text = execFileSync(
      'gh',
      ['release', 'download', tag, '--pattern', 'manifest.json', '--output', '-'],
      { encoding: 'utf8' },
    );
    files = parseManifest(text).files;
  }
  // The files origin the CSP must allow comes from the stage config, never from the response being checked.
  // --local: the test server's own fake origin, read from its CSP.
  const expectedOrigin = local
    ? (filesOriginFromCsp((await get(base!, '/')).res.headers.get('content-security-policy')) ?? '')
    : stageFilesOrigin(stage!, stages[stage!]!.filesBucketSuffix, stages[stage!]!.region);
  const delivery = await checkDelivery(base!, files, expectedOrigin, tag);
  for (const f of delivery) check(false, `delivery: ${f}`);
  check(
    delivery.length === 0,
    `delivery: headers, caching${files ? ' and every file of the release' : ''}`,
  );

  check((await api('GET', '/api/nope')).status === 404, 'unknown API route is 404');
  check((await api('GET', '/api/secrets/short/status')).status === 404, 'malformed id is 404');
  if (!local) await edgeChecks();

  // Burn after reading; a plain GET of the share page (what link previews do) consumes nothing.
  const once = await create({ maxViews: 1, text: 'verify once' });
  const preview = await get(base!, `/s/${once.id}`);
  check(preview.res.status === 200, 'share page loads without the fragment');
  // What the share page asks on load: availability, which must not count either.
  const avail = await api('GET', `/api/secrets/${once.id}`);
  check(
    avail.status === 200 && avail.json?.availableFrom === null,
    'availability check: 200, available now',
  );
  check(
    ((await status(once)).json?.retrievalCount as number) === 0,
    'a plain GET of the share page and the availability check consume nothing',
  );
  const first = await consume(once.id);
  check(
    first.status === 200 && (await decrypts(once, first, null, 'verify once')),
    'one-time secret: first retrieval decrypts',
  );
  check((await consume(once.id)).status === 404, 'one-time secret: second retrieval is 404');
  check(
    (await api('GET', `/api/secrets/${once.id}`)).status === 404,
    'availability check: 404 once used up',
  );
  const s1 = await status(once);
  check(
    s1.json?.status === 'ended' && s1.json.endedReason === 'consumed',
    'one-time secret: tombstone with reason consumed',
  );
  const country =
    ((s1.json?.retrievals as { country: string }[] | undefined) ?? [])[0]?.country ?? '';
  check(/^[A-Z]{2}$/.test(country), `retrieval country recorded (${country})`);

  // N views.
  const three = await create({ maxViews: 3, text: 'verify three' });
  // The country comes from CloudFront; a header sent by the client must not override it.
  const spoof = await api('POST', `/api/secrets/${three.id}/consume`, undefined, {
    'cloudfront-viewer-country': 'ZZ',
  });
  const afterSpoof = await status(three);
  const countries = ((afterSpoof.json?.retrievals as { country: string }[] | undefined) ?? []).map(
    (r) => r.country,
  );
  check(
    spoof.status === 200 && !countries.includes('ZZ'),
    `client-sent CloudFront-Viewer-Country is ignored (${countries.join(',')})`,
  );
  const codes = [200];
  for (let i = 0; i < 3; i++) codes.push((await consume(three.id)).status);
  check(codes.join(',') === '200,200,200,404', `three views: ${codes.join(',')}`);

  // Passphrase.
  const pass = await create({
    maxViews: 1,
    passphrase: 'verify-live-orbit-cactus-harbor',
    text: 'verify pass',
  });
  const pr = await consume(pass.id);
  check(
    pr.status === 200 &&
      (await decrypts(pass, pr, 'verify-live-orbit-cactus-harbor', 'verify pass')),
    'passphrase secret decrypts',
  );
  let wrongFails = false;
  try {
    await decrypts(pass, pr, 'wrong', 'verify pass');
  } catch {
    wrongFails = true;
  }
  check(wrongFails, 'wrong passphrase fails');

  // Release later.
  const later = await create({ maxViews: 1, availableIn: 3600, text: 'verify later' });
  const early = await consume(later.id);
  check(
    early.status === 425 && typeof early.json?.availableFrom === 'string',
    'release later: 425 before availableFrom',
  );
  check(
    (await api('GET', `/api/secrets/${later.id}`)).json?.availableFrom ===
      early.json?.availableFrom,
    'availability check: reports the release time',
  );
  check(
    ((await status(later)).json?.retrievalCount as number) === 0,
    'release later: nothing retrieved',
  );

  // Files: upload, finalize, download within the 2-minute window, decrypt, compare.
  const fileBytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31) & 0xff);
  const withFile = await create({
    maxViews: 1,
    text: 'verify file',
    files: [fileBytes, new Uint8Array(0)],
  });
  const fr = await consume(withFile.id);
  const downloads = (fr.json?.downloads ?? []) as { fileId: string; url: string }[];
  check(fr.status === 200 && downloads.length === 2, 'consume returns two download URLs');
  const fkey = await deriveKey(withFile.kLink, null, null);
  const got = await Promise.all(
    downloads.map(async (d) => {
      const r = await fetch(d.url);
      return openFile(withFile.id, d.fileId, fkey, new Uint8Array(await r.arrayBuffer()));
    }),
  );
  check(
    Buffer.from(got[0]!).equals(Buffer.from(fileBytes)) && got[1]!.length === 0,
    'downloaded files decrypt byte-identical',
  );
  terms.push(
    ...downloads
      .map((d) => new URL(d.url).searchParams.get('X-Amz-Signature') ?? '')
      .filter(Boolean),
  );

  // Delete.
  const del = await create({ maxViews: null, text: 'verify delete' });
  check(
    (
      await api('DELETE', `/api/secrets/${del.id}`, undefined, {
        'x-manage-token': b64urlEncode(newLinkKey()),
      })
    ).status === 404,
    'delete with a wrong token is 404',
  );
  check(
    (await api('DELETE', `/api/secrets/${del.id}`, undefined, { 'x-manage-token': del.token }))
      .status === 204,
    'delete with the token is 204',
  );
  check((await consume(del.id)).status === 404, 'deleted secret is gone');
  const sd = await status(del);
  check(
    sd.json?.endedReason === 'deleted' && typeof sd.json.historyUntil === 'string',
    'tombstone with reason deleted and history date',
  );
  // Clean up the release-later secret too.
  await api('DELETE', `/api/secrets/${later.id}`, undefined, { 'x-manage-token': later.token });

  const termsFile = join(tmpdir(), `brix-verify-${Date.now()}.json`);
  writeFileSync(
    termsFile,
    JSON.stringify({ base, startedAt: started, terms: [...new Set(terms)] }, null, 2),
    { mode: 0o600 },
  );
  process.stdout.write(
    `\n${checks - failures.length}/${checks} checks passed. Terms for scrub-logs: ${termsFile}\n`,
  );
  if (failures.length) process.exit(1);
}

const started = Date.now();
main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
