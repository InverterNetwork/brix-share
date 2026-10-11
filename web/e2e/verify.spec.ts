import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { noHorizontalOverflow, watch } from './helpers.ts';

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
  await expect(page.locator('pre').filter({ hasText: 'gh attestation verify' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'the latest release on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/InverterNetwork/brix-share/releases/latest',
  );
  await expect(page.locator('pre').filter({ hasText: 'git branch -r --contains' })).toBeVisible();
  await expect(page.locator('main')).toContainText('Every path must return the same bytes');
  await expect(page.locator('main')).not.toContainText('Playwright');
  await noHorizontalOverflow(page);
  await w.assertClean(baseURL!);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Verify this site.' })).toBeVisible();
  await w.assertClean(baseURL!);
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
