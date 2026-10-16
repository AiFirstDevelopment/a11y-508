// Stop, the run slot, and a crawl that cannot get in, on the one screen.

import { test, expect } from '@playwright/test';
import { REMOVED_BUTTONS, asksNothing, dashboard, fixtureSite, go, now, open, fillRun, startFromRun, waitFinished, api, cliChromePids, TOKEN, type Dash, type Site } from './harness';

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

test('AC 7: Stop ends a crawl within 10 seconds, its Chrome is gone, and the sentence says Stopped', async ({ page }) => {
  const before = new Set(cliChromePids());
  await open(page, dash);
  await fillRun(page, { url: site.base, token: TOKEN, maxPages: 50 });
  await startFromRun(page);
  await expect(now(page)).toHaveText(/^Crawling 127\.0\.0\.1:\d+: [1-9]\d* pages? so far/, { timeout: 120_000 });
  const ours = cliChromePids().filter((p) => !before.has(p));
  expect(ours.length).toBeGreaterThan(0);
  const t0 = Date.now();
  await go(page).click();
  await expect(now(page)).toHaveText('Stopped', { timeout: 10_000 });
  const took = Date.now() - t0;
  console.log(`AC 7: Stopped ${took} ms after Stop`);
  expect(took).toBeLessThan(10_000);
  await expect(go(page)).toHaveText('Start');
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

// docs/plans/turnkey-loop.md AC 1: a crawl that cannot get in says so, and offers nothing to decide.
test('AC 8, turnkey AC1: a run that cannot get in says so, with Start and nothing else', async ({ page }) => {
  await open(page, dash);
  await fillRun(page, { url: site.base, token: 'wrong-token', maxPages: 2 });
  await startFromRun(page);
  await waitFinished(page);
  await expect(now(page)).toHaveText(/^Could not get into 127\.0\.0\.1:\d+$/);
  await expect(page.getByRole('button', { name: REMOVED_BUTTONS })).toHaveCount(0);
  await asksNothing(page);
});

test('AC 18: while a run is active, Start is Stop and POST /api/runs returns 409', async ({ page }) => {
  await open(page, dash);
  await fillRun(page, { url: site.base, token: TOKEN, maxPages: 50 });
  await startFromRun(page);
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
  const r = await api(dash, '/api/runs', { method: 'POST', body: { kind: 'crawl', url: site.base, options: {}, auth: { mode: 'none' } } });
  expect(r.status).toBe(409);
  const t = await api(dash, '/api/runs', { method: 'POST', body: { kind: 'troubleshoot', url: site.base, options: {}, auth: { mode: 'none' } } });
  expect(t.status).toBe(409);
  await api(dash, '/api/runs/current/stop', { method: 'POST' });
  await expect(now(page)).toHaveText('Stopped', { timeout: 15_000 });
  await expect(go(page)).toHaveText('Start');
  await expect(go(page)).toBeEnabled();
});
