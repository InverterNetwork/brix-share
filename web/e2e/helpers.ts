import { createHash } from 'node:crypto';
import {
  test as base,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';

/** The e2e server's fake S3 (port + 1), the only other origin the app may talk to. */
export const FILES_ORIGIN = 'http://127.0.0.1:4174';

export interface Created {
  shareUrl: string;
  manageUrl: string;
  id: string;
  manageToken: string;
  passphrase: string | null;
}

/** Records CSP violations and every request host; call before the first navigation. */
export async function watch(page: Page) {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(
        `${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber} ${e.sample}`,
      ),
    );
  });
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  return {
    requests,
    consoleErrors,
    async assertClean(baseURL: string) {
      const csp = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
      expect(csp, 'CSP violations').toEqual([]);
      expect(
        consoleErrors.filter((e) => /Content Security Policy|CSP/i.test(e)),
        'CSP console errors',
      ).toEqual([]);
      const foreign = requests.filter(
        (u) =>
          !u.startsWith(baseURL) &&
          !u.startsWith(FILES_ORIGIN) &&
          !u.startsWith('data:') &&
          !u.startsWith('blob:'),
      );
      expect(foreign, 'requests to other hosts').toEqual([]);
    },
  };
}

export async function createViaUi(
  page: Page,
  opts: {
    text: string;
    title?: string;
    passphrase?: boolean;
    views?: '1 time' | '3 times' | '10 times' | 'Unlimited';
    releaseLater?: boolean;
    files?: { name: string; mimeType: string; buffer: Buffer }[];
  },
): Promise<Created> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  if (opts.title) await page.getByLabel('Title').fill(opts.title);
  await page.getByLabel('Secret', { exact: true }).fill(opts.text);
  if (opts.files) await page.getByLabel('Attach files').setInputFiles(opts.files);
  if (opts.views) await page.getByRole('radio', { name: opts.views }).click();
  if (opts.releaseLater) await page.getByRole('switch', { name: 'Release later' }).click();
  if (opts.passphrase) {
    await page.getByRole('switch', { name: 'Passphrase' }).click();
    await expect(page.getByRole('textbox', { name: 'Passphrase' })).toHaveValue(
      /^[a-z]+(-[a-z]+){4}$/,
    );
  }
  const passphrase = opts.passphrase
    ? await page.getByRole('textbox', { name: 'Passphrase' }).inputValue()
    : null;
  await page.getByRole('button', { name: 'Create secure link' }).click();
  await expect(page.getByRole('heading', { name: 'Your secret is ready.' })).toBeVisible({
    timeout: 30_000,
  });
  const shareUrl = (await page.getByLabel('Share link').textContent())!;
  const manageUrl = (await page.getByLabel('Manage link').textContent())!;
  const id = /\/s\/([A-Za-z0-9_-]{22})#/.exec(shareUrl)![1]!;
  return { shareUrl, manageUrl, id, manageToken: manageUrl.split('#')[1]!, passphrase };
}

export function bodyHash(body = ''): string {
  return createHash('sha256').update(body).digest('hex');
}

export async function status(request: APIRequestContext, c: Created) {
  const res = await request.get(`/api/secrets/${c.id}/status`, {
    headers: { 'x-manage-token': c.manageToken },
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    status: string;
    endedReason: string | null;
    retrievalCount: number;
    viewsRemaining: number | null;
    retrievals: { country: string }[];
  };
}

export async function consumeDirect(request: APIRequestContext, id: string) {
  return request.post(`/api/secrets/${id}/consume`, {
    headers: { 'x-amz-content-sha256': bodyHash() },
  });
}

export async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0);
}

export async function shot(page: Page, info: TestInfo, name: string) {
  // Screenshot options inject an inline <style> in some engines, which the strict CSP reports: take
  // screenshots only after a page's CSP assertions.
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}

/** Path plus fragment of an absolute app URL, so tests stay on the configured baseURL. */
export const local = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');

/** Adds `freshPage()`: a page in a new browser context (a different person), closed after the test. */
export const test = base.extend<{ freshPage: () => Promise<Page> }>({
  freshPage: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async () => {
      const ctx = await browser.newContext();
      contexts.push(ctx);
      return ctx.newPage();
    });
    await Promise.all(contexts.map((c) => c.close()));
  },
});
