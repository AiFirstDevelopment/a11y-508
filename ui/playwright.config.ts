import { defineConfig } from '@playwright/test';

// Every test drives the real server and the real CLI against the fixture
// site, with the Chrome already on the machine. One worker: crawls are heavy,
// and two Chrome-driving tests at once time out tests that pass alone.
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  // In CI, also an HTML report the workflow uploads when a run fails.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
    trace: 'off',
  },
});
