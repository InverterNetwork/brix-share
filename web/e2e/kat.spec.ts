import { expect, test } from '@playwright/test';

test('crypto module passes every known-answer vector in this engine', async ({ page }) => {
  await page.goto('/__kat', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__kat !== undefined, undefined, { timeout: 45_000 });
  const kat = await page.evaluate(() => window.__kat!);
  expect(kat.results.filter((r) => !r.ok)).toEqual([]);
  // 6 text, 2 file, 8 negative text and 2 negative file vectors.
  expect(kat.results.length).toBe(18);
  expect(kat.ok).toBe(true);
});

declare global {
  interface Window {
    __kat?: { ok: boolean; results: { name: string; ok: boolean; detail?: string }[] };
  }
}
