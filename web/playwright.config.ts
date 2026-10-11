import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  // PBKDF2 at 600k iterations in five engines at once saturates small machines; keep parallelism modest.
  workers: process.env.CI ? 2 : 4,
  forbidOnly: Boolean(process.env.CI),
  // One retry: browser drivers occasionally lose a navigation (see DECISIONS). Retried tests show up as
  // "flaky" in the report; a test failing twice still fails the run.
  retries: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'firefox',
      // Pages without COOP for this driver only; headers.spec asserts COOP in every other project.
      use: { ...devices['Desktop Firefox'], extraHTTPHeaders: { 'x-e2e-no-coop': '1' } },
      testIgnore: /headers\.spec\.ts/,
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 14'] } },
  ],
  webServer: {
    command: 'node --experimental-strip-types --disable-warning=ExperimentalWarning e2e/server.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: String(PORT),
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8000',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
