import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { noHorizontalOverflow, shot, watch } from './helpers.ts';

test('footer identity and verify page: navigation, copyable commands, CSP and phone layout', async ({
  page,
  baseURL,
}) => {
  const w = await watch(page);
  await page.goto('/');
  const identity = await page.locator('meta[name="brix-share-version"]').getAttribute('content');
  expect(identity).toMatch(/^(dev dev|v[0-9][\w.-]* [0-9a-f]{7})$/);
  const [version, commit] = identity!.split(' ');
  await expect(page.locator('footer')).toContainText(version!);
  await expect(page.locator('footer')).toContainText(`build ${commit!}`);
  const footer = page.locator('footer');
  if ((await page.evaluate(() => window.innerWidth)) >= 640) {
    const links = await footer.locator('p').nth(1).boundingBox();
    const identityRow = await footer.locator('p').nth(2).boundingBox();
    expect(identityRow!.y).toBeGreaterThanOrEqual(links!.y + links!.height);
  }
  await page.getByRole('link', { name: 'Verify this site' }).click();
  await expect(page).toHaveURL(/\/verify$/);
  await expect(page).toHaveTitle('Verify this site · Brix Share');
  await expect(page.getByRole('heading', { name: 'Verify this site.' })).toBeVisible();
  await expect(page.locator('#verify-attestation')).not.toHaveAttribute('open');
  await expect(page.locator('#verify-attestation pre')).not.toBeVisible();
  await expect(page.getByRole('link', { name: 'the latest release on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/InverterNetwork/brix-share/releases/latest',
  );
  await expect(page.locator('#verify-commit')).not.toHaveAttribute('open');
  await expect(page.locator('main')).toContainText(
    'every page path must return byte-identical index.html',
  );
  await expect(page.locator('main')).not.toContainText('Playwright');
  await noHorizontalOverflow(page);
  await w.assertClean(baseURL!);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Verify this site.' })).toBeVisible();
  await w.assertClean(baseURL!);
});

test('OS selector changes every command; details, keyboard, copying, CSP and screenshots', async ({
  page,
  browserName,
  context,
  baseURL,
}, info) => {
  if (browserName === 'chromium')
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  else
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: (text: string) => {
            (window as unknown as { __clip: string }).__clip = text;
            return Promise.resolve();
          },
        },
      });
    });
  const w = await watch(page);
  await page.goto('/verify');
  const selector = page.getByRole('radiogroup', { name: 'Command operating system' });
  await expect(selector.getByRole('radio', { name: 'macOS / Linux' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  for (const detail of ['attestation', 'commit', 'browser', 'workers', 'files']) {
    await expect(page.locator(`#verify-${detail}`)).not.toHaveAttribute('open');
    await page.locator(`#verify-${detail} summary`).click();
    await expect(page.locator(`#verify-${detail}`)).toHaveAttribute('open', '');
  }
  const unix = await page.locator('pre code').allTextContents();
  expect(unix).toHaveLength(8);
  await selector.getByRole('radio', { name: 'macOS / Linux' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(selector.getByRole('radio', { name: 'Windows' })).toBeFocused();
  await expect(selector.getByRole('radio', { name: 'Windows' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const windows = await page.locator('pre code').allTextContents();
  for (let i = 0; i < unix.length; i++) expect(windows[i]).not.toBe(unix[i]);
  await expect(page.locator('#verify-version pre')).toContainText('Invoke-WebRequest');
  await expect(page.locator('#verify-hash pre')).toContainText('Get-FileHash');
  await expect(page.locator('#verify-browser pre')).toContainText('WriteAllBytes');
  await page.locator('#verify-hash').getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(
    page.locator('#verify-hash').getByRole('button', { name: 'Copied', exact: true }),
  ).toBeVisible();
  const clip =
    browserName === 'chromium'
      ? await page.evaluate(() => navigator.clipboard.readText())
      : await page.evaluate(() => (window as unknown as { __clip: string }).__clip);
  expect(clip).toBe(windows[2]);
  await page.locator('#verify-browser').getByRole('button', { name: 'Copy', exact: true }).click();
  const deeperClip =
    browserName === 'chromium'
      ? await page.evaluate(() => navigator.clipboard.readText())
      : await page.evaluate(() => (window as unknown as { __clip: string }).__clip);
  expect(deeperClip).toBe(windows[6]);
  await noHorizontalOverflow(page);
  await w.assertClean(baseURL!);
  await selector.getByRole('radio', { name: 'Windows' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(selector.getByRole('radio', { name: 'macOS / Linux' })).toBeFocused();
  expect(await page.locator('pre code').allTextContents()).toEqual(unix);
  for (const detail of ['commit', 'browser', 'workers', 'files'])
    await page.locator(`#verify-${detail} summary`).click();
  await noHorizontalOverflow(page);
  await w.assertClean(baseURL!);
  // Capture only after CSP assertions: screenshots can inject a style in WebKit.
  await shot(page, info, 'verify-unix');
  await selector.getByRole('radio', { name: 'Windows' }).click();
  await noHorizontalOverflow(page);
  await shot(page, info, 'verify-windows');
  await page.setViewportSize({ width: 320, height: 740 });
  await noHorizontalOverflow(page);
  await page.reload();
  await expect(selector.getByRole('radio', { name: 'macOS / Linux' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.locator('details[open]')).toHaveCount(0);
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
  await noHorizontalOverflow(page);
});

for (const documentPath of ['/', '/s/AAAAAAAAAAAAAAAAAAAAAA']) {
  test(`HAR document extraction preserves original UTF-8 bytes on ${documentPath}`, async ({
    browser,
    baseURL,
  }, info) => {
    const path = info.outputPath('browser.har');
    const context = await browser.newContext({ recordHar: { path, content: 'embed' } });
    const page = await context.newPage();
    const url = `${baseURL}${documentPath}`;
    await page.route(url, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()) + '<!-- ü € 🔑 -->\n\n' });
    });
    const response = await page.goto(url);
    const original = await response!.body();
    await context.close();
    const har = JSON.parse(await readFile(path, 'utf8')) as {
      log: {
        entries: {
          request: { url: string };
          response: { content: { text: string; encoding?: string } };
        }[];
      };
    };
    const entries = har.log.entries.filter((e) => e.request.url === url);
    expect(entries).toHaveLength(1);
    const content = entries[0]!.response.content;
    const extracted = Buffer.from(content.text, content.encoding === 'base64' ? 'base64' : 'utf8');
    expect(extracted).toEqual(original);
    expect(createHash('sha256').update(extracted).digest('hex')).toBe(
      createHash('sha256').update(original).digest('hex'),
    );
  });
}
