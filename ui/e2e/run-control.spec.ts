// Notices, Stop, the run slot, and the way out when a crawl cannot get in.

import { test, expect } from '@playwright/test';
import { moreOptions, dashboard, fixtureSite, open, fillRun, startFromRun, waitFinished, nav, api, cliChromePids, status, TOKEN, type Dash, type Site } from './harness';

let site: Site;
let dash: Dash;
test.beforeEach(async () => {
  site = await fixtureSite();
  dash = await dashboard();
});
test.afterEach(async () => {
  await dash.stop();
  site.close();
});

test('AC 3: warnings and errors are separate notices during and after a run; raw output only on request', async ({ page }) => {
  await open(page, dash, '/run');
  await fillRun(page, { url: site.base, maxPages: 2 });
  await moreOptions(page);
  await page.getByLabel('No sign-in').check();
  await startFromRun(page);
  const warn = page.locator('[data-notice="warn"]');
  const error = page.locator('[data-notice="error"]');
  // During the run: the TOKEN warning is a notice of its own, and no raw output is on screen.
  await expect(warn).toContainText('TOKEN is not set');
  await expect(status(page)).toHaveText(/^Running/);
  await expect(page.getByTestId('raw-output')).toHaveCount(0);
  await waitFinished(page);
  // After: the error is a separate notice; the warning is still there and not inside it.
  await expect(error).toContainText('the start page could not be audited: HTTP 401');
  await expect(warn).toContainText('TOKEN is not set');
  await expect(error).not.toContainText('TOKEN is not set');
  await expect(page.getByTestId('raw-output')).toHaveCount(0);
  await page.getByText('Show raw output').click();
  await expect(page.getByTestId('raw-output')).toBeVisible();
  await expect(page.getByTestId('raw-output')).toContainText('"type":"warn"');
});

test('AC 7: Stop ends a crawl within 10 seconds, its Chrome is gone, and the screen says Stopped', async ({ page }) => {
  const before = new Set(cliChromePids());
  await open(page, dash, '/run');
  await fillRun(page, { url: site.base, token: TOKEN, maxPages: 50 });
  await startFromRun(page);
  await expect(page.locator('#crawl-progress-label')).toHaveText(/pages found/, { timeout: 120_000 });
  const ours = cliChromePids().filter((p) => !before.has(p));
  expect(ours.length).toBeGreaterThan(0);
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(status(page)).toHaveText('Stopped', { timeout: 10_000 });
  const took = Date.now() - t0;
  console.log(`AC 7: Stopped ${took} ms after Stop`);
  expect(took).toBeLessThan(10_000);
  const alive = ours.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  expect(alive, `the run's Chrome processes still running: ${alive.join(', ')}`).toEqual([]);
});

test('AC 8: a run that cannot get in offers Troubleshoot; the next step is a button that reruns with its flag', async ({ page }) => {
  await open(page, dash, '/run');
  await fillRun(page, { url: site.base, token: 'wrong-token', maxPages: 2 });
  await startFromRun(page);
  await waitFinished(page);
  await page.getByRole('button', { name: 'Troubleshoot with these settings' }).click();
  await expect(page).toHaveURL(/\/troubleshoot$/);
  const hops = page.getByTestId('hops');
  await expect(hops).toContainText(`GET ${new URL(site.base).pathname}`, { timeout: 120_000 });
  await expect(hops).toContainText('HTTP 401');
  await expect(page.getByTestId('verdict')).toHaveText('The start URL answered HTTP 401.');
  await expect(page.getByTestId('next')).toContainText('the server rejected it');
  await expect(page.getByTestId('header-went-out')).toContainText('Authorization header was sent');

  // An app that reads its token from a web storage key the crawler did not seed.
  await nav(page, 'Run');
  await fillRun(page, { url: site.base + 'app.html', token: TOKEN, maxPages: 1, advanced: { 'no-token-storage': true } });
  await startFromRun(page);
  await waitFinished(page);
  await page.getByRole('button', { name: 'Troubleshoot with these settings' }).click();
  await expect(page.getByTestId('next')).toContainText('--token-storage access_token', { timeout: 120_000 });
  await expect(page.getByTestId('hops')).toContainText('The page script navigated to /login.html');
  await page.getByTestId('next-button').click();
  await expect(page).toHaveURL(/\/live$/);
  await expect(page.getByTestId('run-command')).toContainText('--token-storage access_token');
  await waitFinished(page);
});

test('AC 18: while a run is active, Start is disabled and POST /api/runs returns 409', async ({ page }) => {
  await open(page, dash, '/run');
  await fillRun(page, { url: site.base, token: TOKEN, maxPages: 50 });
  await startFromRun(page);
  await nav(page, 'Run');
  await page.getByLabel('Start URL').fill(site.base + 'about.html');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  const r = await api(dash, '/api/runs', { method: 'POST', body: { kind: 'crawl', url: site.base, options: {}, auth: { mode: 'none' } } });
  expect(r.status).toBe(409);
  const t = await api(dash, '/api/runs', { method: 'POST', body: { kind: 'troubleshoot', url: site.base, options: {}, auth: { mode: 'none' } } });
  expect(t.status).toBe(409);
  await api(dash, '/api/runs/current/stop', { method: 'POST' });
  await nav(page, 'Live run');
  await expect(status(page)).toHaveText('Stopped', { timeout: 15_000 });
  await nav(page, 'Run');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
});
