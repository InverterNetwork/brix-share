import { randomBytes } from 'node:crypto';
import { b64urlDecode, type Envelope } from '@brix-share/shared';
import { deriveKey, openText, openFile, DecryptError } from '../src/crypto/envelope.ts';
import { expect, type Page } from '@playwright/test';
import {
  FILES_ORIGIN,
  createViaUi,
  local,
  noHorizontalOverflow,
  shot,
  status,
  test,
  watch,
} from './helpers.ts';

const PGP = Buffer.from(
  '-----BEGIN PGP PUBLIC KEY BLOCK-----\nexample\n-----END PGP PUBLIC KEY BLOCK-----\n',
);
const BIN = randomBytes(300_000);

/**
 * Bytes behind each Download link, saved the way a user does (fetching blob: URLs is blocked by the CSP).
 * Collects every download by file name while clicking each link.
 */
async function savedFiles(page: Page): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  const pending: Promise<void>[] = [];
  page.on('download', (download) => {
    pending.push(
      (async () => {
        const chunks: Buffer[] = [];
        for await (const c of (await download.createReadStream()) as AsyncIterable<Buffer>)
          chunks.push(c);
        out[download.suggestedFilename()] = Buffer.concat(chunks);
      })(),
    );
  });
  const links = page.locator('a[download]');
  const names = await links.evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).download));
  for (let i = 0; i < names.length; i++) await links.nth(i).click();
  await expect
    .poll(async () => {
      await Promise.all(pending);
      return names.every((n) => n in out);
    })
    .toBe(true);
  return out;
}

test('files round trip: three files (one empty), byte-identical, CSP clean', async ({
  page,
  freshPage,
  request,
  baseURL,
}, info) => {
  const w = await watch(page);
  let createBody = '';
  page.on('request', (rq) => {
    if (rq.url().endsWith('/api/secrets') && rq.method() === 'POST')
      createBody = rq.postData() ?? '';
  });
  const c = await createViaUi(page, {
    text: 'see attachments',
    files: [
      { name: 'audit-handover.pub.asc', mimeType: 'application/pgp-keys', buffer: PGP },
      { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
      { name: 'blob.bin', mimeType: 'application/octet-stream', buffer: BIN },
    ],
  });
  await w.assertClean(baseURL!);
  expect(w.requests.filter((u) => u.startsWith(FILES_ORIGIN))).toHaveLength(3);
  expect(await status(request, c)).toMatchObject({ status: 'ready' });

  const r = await freshPage();
  const rw = await watch(r);
  // Capture before delivery: mobile Chromium may evict no-store bodies before response.json().
  let consumed: { envelope: Envelope } | undefined;
  await r.route(`**/api/secrets/${c.id}/consume`, async (route) => {
    const response = await route.fetch();
    consumed = (await response.json()) as { envelope: Envelope };
    await route.fulfill({ response });
  });
  const stored: { fileId: string; bytes: Buffer }[] = [];
  await r.route(`${FILES_ORIGIN}/${c.id}/**`, async (route) => {
    const response = await route.fetch();
    stored.push({
      fileId: new URL(route.request().url()).pathname.split('/').at(-1)!,
      bytes: await response.body(),
    });
    await route.fulfill({ response });
  });
  await r.goto(local(c.shareUrl), { waitUntil: 'domcontentloaded' });
  await r.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.getByRole('list', { name: 'Files' }).getByRole('listitem')).toHaveCount(3);
  // Nothing downloads on its own: only a click saves a file.
  let early = 0;
  r.on('download', () => early++);
  await r.waitForTimeout(500);
  expect(early).toBe(0);
  expect(consumed !== undefined).toBe(true);
  const textKey = await deriveKey(b64urlDecode(c.shareUrl.split('#')[1]!), null, null);
  const payload = await openText(consumed!.envelope, textKey);
  expect(new Set(payload.files.map((f) => f.key)).size).toBe(3);
  expect(payload.files.every((f) => !createBody.includes(f.key))).toBe(true);
  expect(stored).toHaveLength(3);
  for (const { fileId, bytes } of stored) {
    await expect(openFile(c.id, fileId, textKey, new Uint8Array(bytes))).rejects.toBeInstanceOf(
      DecryptError,
    );
  }
  const saved = await savedFiles(r);
  expect(saved['audit-handover.pub.asc']).toEqual(PGP);
  expect(saved['empty.txt']!.length).toBe(0);
  expect(saved['blob.bin']!.equals(BIN)).toBe(true);
  await noHorizontalOverflow(r);
  await rw.assertClean(baseURL!);
  await shot(r, info, 'reveal-files');
});

test('passphrase entered after the download URLs expired still decrypts the files', async ({
  page,
  freshPage,
  request,
}) => {
  const c = await createViaUi(page, {
    text: 'late passphrase',
    passphrase: true,
    files: [{ name: 'k.txt', mimeType: 'text/plain', buffer: PGP }],
  });
  const r = await freshPage();
  await r.goto(local(c.shareUrl), { waitUntil: 'domcontentloaded' });
  await r.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.getByRole('heading', { name: 'Enter the passphrase.' })).toBeVisible();
  // Push the fake S3 clock past the 2-minute download window.
  await request.post(`${FILES_ORIGIN}/__clock?id=${c.id}&offset=300`);
  try {
    await r.getByRole('textbox', { name: 'Passphrase' }).fill(c.passphrase!);
    await r.getByRole('button', { name: 'Decrypt' }).click();
    await expect(r.getByRole('list', { name: 'Files' }).getByRole('listitem')).toHaveCount(1, {
      timeout: 20_000,
    });
    expect((await savedFiles(r))['k.txt']).toEqual(PGP);
  } finally {
    await request.post(`${FILES_ORIGIN}/__clock?id=${c.id}&offset=0`);
  }
});

test('more than 25 MB of files is refused before anything is sent', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  let sent = 0;
  page.on('request', (rq) => {
    if (rq.url().includes('/api/')) sent++;
  });
  await page.getByLabel('Attach files').setInputFiles([
    { name: 'a.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(13 * 1024 * 1024) },
    { name: 'b.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(13 * 1024 * 1024) },
  ]);
  await expect(page.getByText(/2 of 10 files, 26\.0 MB of 25 MB/)).toBeVisible();
  await page.getByRole('button', { name: 'Create secure link' }).click();
  await expect(page.getByText('Files are larger than 25 MB in total.')).toBeVisible();
  expect(sent).toBe(0);
});

test('a files-only secret (no text) works', async ({ page, freshPage }) => {
  const c = await createViaUi(page, {
    text: '',
    files: [{ name: 'only.txt', mimeType: 'text/plain', buffer: PGP }],
  });
  const r = await freshPage();
  await r.goto(local(c.shareUrl), { waitUntil: 'domcontentloaded' });
  await r.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.getByRole('list', { name: 'Files' }).getByRole('listitem')).toHaveCount(1);
  await expect(r.getByLabel('Secret', { exact: true })).toHaveCount(0);
});

test('a failed upload says nothing was shared', async ({ page }) => {
  await page.route(`${FILES_ORIGIN}/**`, (route) =>
    route.request().method() === 'PUT' ? route.abort() : route.continue(),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Secret', { exact: true }).fill('upload fails');
  await page
    .getByLabel('Attach files')
    .setInputFiles([{ name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }]);
  await page.getByRole('button', { name: 'Create secure link' }).click();
  await expect(
    page.getByText('The files could not be uploaded. Nothing was shared; please try again.'),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Your secret is ready.' })).toHaveCount(0);
});

test('a tampered attachment fails decryption while the text still opens', async ({
  page,
  freshPage,
}) => {
  const c = await createViaUi(page, {
    text: 'intact text',
    files: [{ name: 'tampered.txt', mimeType: 'text/plain', buffer: PGP }],
  });
  const r = await freshPage();
  await r.route(`${FILES_ORIGIN}/${c.id}/**`, async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    body[body.length - 1]! ^= 1;
    await route.fulfill({ response, body });
  });
  await r.goto(local(c.shareUrl), { waitUntil: 'domcontentloaded' });
  await r.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.getByLabel('Secret', { exact: true })).toHaveValue('intact text');
  await expect(r.getByText('Could not be fetched')).toBeVisible();
  await expect(r.locator('a[download]')).toHaveCount(0);
});
