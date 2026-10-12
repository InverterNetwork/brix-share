import { expect } from '@playwright/test';
import {
  consumeDirect,
  bodyHash,
  createViaUi,
  local,
  noHorizontalOverflow,
  shot,
  status,
  test,
  watch,
} from './helpers.ts';

const SECRET = '-----BEGIN KEY-----\nline two ü € 🔑\n-----END KEY-----';

test('burn after reading: create, reveal once, then gone; fragment stripped; nothing stored; no foreign requests', async ({
  page,
  freshPage,
  request,
  baseURL,
}, info) => {
  // CSP checks run before screenshots on the same page: Playwright's WebKit screenshots inject an inline
  // <style>, which the strict CSP (correctly) reports.
  const w = await watch(page);
  const c = await createViaUi(page, { text: SECRET, title: 'Deployer key' });
  await noHorizontalOverflow(page);
  await w.assertClean(baseURL!);
  await shot(page, info, '1-result');

  const recipient = await freshPage();
  const rw = await watch(recipient);
  await recipient.goto(local(c.shareUrl), { waitUntil: 'domcontentloaded' });
  await expect(recipient).toHaveURL(new RegExp(`/s/${c.id}$`));
  expect(await recipient.evaluate(() => location.hash)).toBe('');
  await expect(
    recipient.getByRole('heading', { name: 'You have been sent a secret.' }),
  ).toBeVisible();
  await noHorizontalOverflow(recipient);
  await recipient.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(recipient.getByLabel('Secret', { exact: true })).toHaveValue(SECRET);
  await expect(recipient.getByRole('heading', { name: 'Deployer key' })).toBeVisible();
  await expect(recipient.getByText('This was the only retrieval.')).toBeVisible();
  await noHorizontalOverflow(recipient);
  const storage = await recipient.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookies: document.cookie,
    idb: 'databases' in indexedDB ? (await indexedDB.databases()).length : 0,
  }));
  expect(storage).toEqual({ local: 0, session: 0, cookies: '', idb: 0 });
  await rw.assertClean(baseURL!);
  await shot(recipient, info, '3-revealed');
  await recipient.getByRole('button', { name: 'Clear from screen' }).click();
  await expect(recipient.getByText('This was the last retrieval. Once cleared')).toBeVisible();
  await recipient.getByRole('button', { name: 'Keep it on screen' }).click();
  await expect(recipient.getByLabel('Secret', { exact: true })).toHaveValue(SECRET);
  await recipient.getByRole('button', { name: 'Clear from screen' }).click();
  await recipient.getByRole('button', { name: 'Clear anyway' }).click();
  await expect(recipient.getByText(SECRET)).toHaveCount(0);

  // A used-up link says so on load, without a click.
  const again = await freshPage();
  await again.goto(local(c.shareUrl), { waitUntil: 'domcontentloaded' });
  await expect(again.getByRole('heading', { name: 'This secret is not available.' })).toBeVisible();
  await expect(again.getByRole('button', { name: 'Reveal secret' })).toHaveCount(0);

  const s = await status(request, c);
  expect(s).toMatchObject({ status: 'ended', endedReason: 'consumed', retrievalCount: 1 });
  expect(s.retrievals).toEqual([expect.objectContaining({ country: 'DE' })]);
});

test('passphrase: wrong passphrase retries in memory without a second retrieval', async ({
  page,
  freshPage,
  request,
}, info) => {
  const c = await createViaUi(page, { text: 'with passphrase', passphrase: true });
  await expect(page.getByLabel('Passphrase', { exact: true })).toHaveText(c.passphrase!);
  const recipient = await freshPage();
  let consumes = 0;
  recipient.on('request', (r) => {
    if (r.url().endsWith('/consume')) consumes++;
  });
  await recipient.goto(local(c.shareUrl), { waitUntil: 'domcontentloaded' });
  await recipient.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(recipient.getByRole('heading', { name: 'Enter the passphrase.' })).toBeVisible();
  await recipient
    .getByRole('textbox', { name: 'Passphrase' })
    .fill('wrong-wrong-wrong-wrong-wrong');
  await recipient.getByRole('button', { name: 'Decrypt' }).click();
  await expect(recipient.getByText('That passphrase did not decrypt the secret.')).toBeVisible({
    timeout: 20_000,
  });
  await noHorizontalOverflow(recipient);
  await shot(recipient, info, 'passphrase-wrong');
  await recipient.getByRole('textbox', { name: 'Passphrase' }).fill(c.passphrase!);
  await recipient.getByRole('button', { name: 'Decrypt' }).click();
  await expect(recipient.getByLabel('Secret', { exact: true })).toHaveValue('with passphrase', {
    timeout: 20_000,
  });
  expect(consumes).toBe(1);
  expect((await status(request, c)).retrievalCount).toBe(1);
});

test('N views: three retrievals, then gone; manage page shows the log', async ({
  page,
  request,
}, info) => {
  const c = await createViaUi(page, { text: 'three views', views: '3 times' });
  for (let i = 0; i < 3; i++) expect((await consumeDirect(request, c)).status()).toBe(200);
  expect((await consumeDirect(request, c)).status()).toBe(404);
  await page.goto(local(c.manageUrl), { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Ended · opened 3 times')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(4);
  await noHorizontalOverflow(page);
  await shot(page, info, 'manage-ended');
});

test('release later: countdown, nothing retrieved', async ({ page, freshPage, request }, info) => {
  const c = await createViaUi(page, { text: 'later', releaseLater: true });
  const recipient = await freshPage();
  await recipient.goto(local(c.shareUrl), { waitUntil: 'domcontentloaded' });
  // Known on load, from the non-counting availability check.
  await expect(recipient.getByRole('heading', { name: 'Not yet available.' })).toBeVisible();
  await expect(recipient.getByRole('timer')).toBeVisible();
  await noHorizontalOverflow(recipient);
  await shot(recipient, info, 'reveal-too-early');
  const s = await status(request, c);
  expect(s).toMatchObject({ status: 'ready', retrievalCount: 0 });
});

test('manage: delete now with confirmation; share link stops working', async ({
  page,
  freshPage,
}, info) => {
  const c = await createViaUi(page, { text: 'delete me', views: 'Unlimited' });
  await page.getByRole('button', { name: 'Open manage page' }).click();
  await expect(page).toHaveURL(new RegExp(`/m/${c.id}$`));
  await expect(page.getByText('Live · opened 0 times')).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, info, 'manage-live');
  await page.getByRole('button', { name: 'Delete now' }).click();
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByText('Deleted. Nothing remains on our servers.')).toBeVisible();
  await shot(page, info, 'manage-deleted');
  const recipient = await freshPage();
  await recipient.goto(local(c.shareUrl), { waitUntil: 'domcontentloaded' });
  await expect(
    recipient.getByRole('heading', { name: 'This secret is not available.' }),
  ).toBeVisible();
});

test('manage page survives a reload and refreshes on demand', async ({ page, freshPage }) => {
  const c = await createViaUi(page, { text: 'reload me', views: '3 times' });
  await page.getByRole('button', { name: 'Open manage page' }).click();
  await expect(page.getByText('Live · 3 of 3 retrievals left')).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Live · 3 of 3 retrievals left')).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe('');
  const recipient = await freshPage();
  await recipient.goto(local(c.shareUrl), { waitUntil: 'domcontentloaded' });
  await recipient.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(recipient.getByLabel('Secret', { exact: true })).toHaveValue('reload me');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Live · 2 of 3 retrievals left')).toBeVisible();
  // Another tab without the fragment knows nothing.
  const other = await freshPage();
  await other.goto(local(c.manageUrl).split('#')[0]!, { waitUntil: 'domcontentloaded' });
  await expect(
    other.getByRole('heading', { name: 'Nothing found for this manage link.' }),
  ).toBeVisible();
});

test('result page: passphrase advice only with a passphrase; copy keeps its width', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() },
    });
  });
  await createViaUi(page, { text: 'no phrase' });
  await expect(page.getByText('Anyone with the link can open the secret.')).toBeVisible();
  await expect(page.getByText(/through different channels/)).toHaveCount(0);
  const copy = page.getByRole('button', { name: 'Copy' }).first();
  const before = (await copy.boundingBox())!.width;
  await copy.click();
  const after = (await page.getByRole('button', { name: 'Copied' }).first().boundingBox())!.width;
  // Sub-pixel tolerance: WebKit measures mid-transition; the old jump was several pixels.
  expect(Math.abs(after - before)).toBeLessThan(1);
});

test('a plain GET of the share page consumes nothing', async ({ page, request }) => {
  const c = await createViaUi(page, { text: 'preview safe' });
  const res = await request.get(local(c.shareUrl).split('#')[0]!);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('<div id="app">');
  expect(await status(request, c)).toMatchObject({ status: 'ready', retrievalCount: 0 });
});

test('lost consume response: the retrieval is burnt and the page never retries', async ({
  page,
  freshPage,
  request,
}, info) => {
  const c = await createViaUi(page, { text: 'lost response' });
  const recipient = await freshPage();
  let consumes = 0;
  await recipient.route('**/consume', async (route) => {
    consumes++;
    await route.continue({
      headers: { ...route.request().headers(), 'x-test-drop-response': '1' },
    });
  });
  await recipient.goto(local(c.shareUrl), { waitUntil: 'domcontentloaded' });
  await recipient.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(
    recipient.getByRole('heading', { name: 'The secret could not be shown.' }),
  ).toBeVisible();
  await expect(recipient.getByRole('button', { name: /Reveal|Try again/ })).toHaveCount(0);
  await shot(recipient, info, 'reveal-lost');
  expect(consumes).toBe(1);
  expect(await status(request, c)).toMatchObject({
    status: 'ended',
    endedReason: 'consumed',
    retrievalCount: 1,
  });
});

test('incomplete link and unknown routes', async ({ page }, info) => {
  await page.goto('/s/AAAAAAAAAAAAAAAAAAAAAA', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'This link is incomplete.' })).toBeVisible();
  await shot(page, info, 'reveal-incomplete');
  await page.goto('/s/not-an-id#abc', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Page not found.' })).toBeVisible();
  await page.goto('/how-it-works', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'How Brix Share works.' })).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, info, 'about');
});

test('acceptable use: linked above the create button and in the footer', async ({ page }, info) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const note = page.getByRole('link', { name: 'Acceptable use policy' });
  await expect(note).toHaveAttribute('href', '/acceptable-use');
  await expect(note).toHaveAttribute('target', '_blank');
  await page.getByRole('contentinfo').getByRole('link', { name: 'Acceptable use' }).click();
  await expect(page.getByRole('heading', { name: 'Acceptable use.' })).toBeVisible();
  await expect(
    page.getByText('We reserve the right to report suspected illegal use'),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, info, 'acceptable-use');
});

test('copy buttons put the link on the clipboard', async ({ page, browserName, context }) => {
  if (browserName === 'chromium')
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  else
    await page.addInitScript(() => {
      const w = window as unknown as { __clip: string };
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: (t: string) => ((w.__clip = t), Promise.resolve()) },
      });
    });
  const c = await createViaUi(page, { text: 'copy me' });
  await page.getByRole('button', { name: 'Copy' }).first().click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  const clip =
    browserName === 'chromium'
      ? await page.evaluate(() => navigator.clipboard.readText())
      : await page.evaluate(() => (window as unknown as { __clip: string }).__clip);
  expect(clip).toBe(c.shareUrl);
});

test('every screen renders without CSP violations', async ({ page, freshPage, baseURL }, info) => {
  const w = await watch(page);
  const c = await createViaUi(page, { text: 'csp sweep', passphrase: true, views: '3 times' });
  await page.getByRole('button', { name: 'Open manage page' }).click();
  await expect(page.getByText(/Live/)).toBeVisible();
  await page.goto('/how-it-works', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'How Brix Share works.' })).toBeVisible();
  await w.assertClean(baseURL!);
  const recipient = await freshPage();
  const rw = await watch(recipient);
  await recipient.goto(local(c.shareUrl), { waitUntil: 'domcontentloaded' });
  await expect(
    recipient.getByRole('heading', { name: 'You have been sent a secret.' }),
  ).toBeVisible();
  await rw.assertClean(baseURL!);
  await shot(recipient, info, 'reveal-intro');
  const r2 = await freshPage();
  const w2 = await watch(r2);
  await r2.goto(local(c.shareUrl), { waitUntil: 'domcontentloaded' });
  await r2.getByRole('button', { name: 'Reveal secret' }).click();
  await r2.getByRole('textbox', { name: 'Passphrase' }).fill(c.passphrase!);
  await r2.getByRole('button', { name: 'Decrypt' }).click();
  await expect(r2.getByLabel('Secret', { exact: true })).toHaveValue('csp sweep', {
    timeout: 20_000,
  });
  await w2.assertClean(baseURL!);
});

test('create screen with every option open fits the viewport', async ({ page }, info) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Title').fill('PGP key for the audit handover');
  await page
    .getByLabel('Secret', { exact: true })
    .fill(
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQdGBGcSx0ABEADJq3P2S3Z7T8zq0v7n5K8m1Yk5pJc7eC2hWv4tA9q0bK2qRz3H\n-----END PGP PRIVATE KEY BLOCK-----',
    );
  await page.getByRole('radio', { name: 'Custom' }).first().click();
  await page.getByRole('radio', { name: 'Custom' }).nth(1).click();
  await page.getByRole('switch', { name: 'Release later' }).click();
  await page.getByRole('switch', { name: 'Passphrase' }).click();
  await expect(page.getByRole('textbox', { name: 'Passphrase' })).toHaveValue(/-/);
  await noHorizontalOverflow(page);
  await shot(page, info, 'create-all-options');
  await page.getByRole('textbox', { name: 'Passphrase' }).fill('hunter2');
  await expect(page.getByText(/Too short/)).toBeVisible();
});

test('leaving a revealed secret asks first; back from the manage page shows the links again', async ({
  page,
  freshPage,
}) => {
  const c = await createViaUi(page, { text: 'guarded' });
  await page.getByRole('button', { name: 'Open manage page' }).click();
  await expect(page).toHaveURL(new RegExp(`/m/${c.id}$`));
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Your secret is ready.' })).toBeVisible();
  await expect(page.getByLabel('Share link')).toHaveText(c.shareUrl);

  const recipient = await freshPage();
  await recipient.goto(local(c.shareUrl), { waitUntil: 'domcontentloaded' });
  await recipient.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(recipient.getByLabel('Secret', { exact: true })).toHaveValue('guarded');
  const dialogs: string[] = [];
  recipient.once('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await recipient
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'How it works' })
    .click();
  expect(dialogs[0]).toContain('If you leave, it is gone');
  await expect(recipient.getByLabel('Secret', { exact: true })).toHaveValue('guarded');
  recipient.once('dialog', (d) => void d.accept());
  await recipient
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'How it works' })
    .click();
  await expect(recipient.getByRole('heading', { name: 'How Brix Share works.' })).toBeVisible();
});

test('path-only requests cannot poll or burn a passphrase-protected secret', async ({
  page,
  request,
  freshPage,
}) => {
  const c = await createViaUi(page, { text: 'protected capability', passphrase: true });
  expect((await request.get(`/api/secrets/${c.id}`)).status()).toBe(404);
  expect(
    (
      await request.post(`/api/secrets/${c.id}/consume`, {
        headers: { 'x-amz-content-sha256': bodyHash() },
      })
    ).status(),
  ).toBe(404);
  expect((await status(request, c)).retrievalCount).toBe(0);
  const recipient = await freshPage();
  const headers: string[] = [];
  recipient.on('request', (r) => {
    if (r.url().includes(`/api/secrets/${c.id}`))
      headers.push(r.headers()['x-consume-token'] ?? '');
  });
  await recipient.goto(local(c.shareUrl));
  await recipient.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(recipient.getByRole('heading', { name: 'Enter the passphrase.' })).toBeVisible();
  expect(headers).toHaveLength(2);
  expect(headers.every((h) => /^[A-Za-z0-9_-]{43}$/.test(h))).toBe(true);
  expect(headers[0]).toBe(headers[1]);
  await recipient.getByLabel('Passphrase', { exact: true }).fill(c.passphrase!);
  await recipient.getByRole('button', { name: 'Decrypt', exact: true }).click();
  await expect(recipient.getByLabel('Secret', { exact: true })).toHaveValue('protected capability');
});
