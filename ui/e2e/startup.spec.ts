// Startup never shows a blank screen, never waits for the assistants, and starts where the person
// left off even in a browser that remembers nothing (the dashboard's own new Chrome profile).

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { api, dashboard, gitRepo, goInApp, open, tempDir, ROOT } from './harness';

test('startup: with a 20 s assistant lookup the Set up dialog is up within 2 s, and the Fix step says it is detecting, then shows the result', async ({ page }) => {
  const dash = await dashboard({ env: { A11Y_508_DETECT_DELAY_MS: '20000' } });
  try {
    const t0 = Date.now();
    await page.goto(`${dash.origin}/run#secret=${dash.secret}`);
    const dialog = page.getByRole('dialog', { name: 'Set up' });
    await expect(dialog).toBeVisible({ timeout: 2000 });
    expect(Date.now() - t0).toBeLessThan(2500);
    await dialog.getByLabel('Start URL').fill('http://127.0.0.1:9/');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await goInApp(page, '/fix-loop');
    await expect(page.getByTestId('assistant-line')).toHaveText(/Detecting assistants…/i, { timeout: 5000 });
    await expect(page.getByTestId('assistant-line')).toHaveText(/Fixing with|No assistant/, { timeout: 40_000 });
  } finally {
    await dash.stop();
  }
});

test('startup: the folder and URL chosen last time are restored by the server, in a browser that remembers nothing', async ({ browser }) => {
  const home = tempDir('a11y-508-home-');
  const repo = tempDir('a11y-508-startrepo-');
  gitRepo(repo);
  const first = await dashboard({ env: { A11Y_508_HOME: home } });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${first.origin}/run#secret=${first.secret}`);
    const dialog = page.getByRole('dialog', { name: 'Set up' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("App's repository folder").fill(repo);
    await dialog.getByLabel('Start URL').fill('http://127.0.0.1:9/remembered');
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await api(first, '/api/runs/current')).json?.status, { timeout: 30_000 }).toBe('running');
    await api(first, '/api/runs/current/stop', { method: 'POST' });
    await expect.poll(async () => (await api(first, '/api/runs/current')).json?.status, { timeout: 30_000 }).toBe('done');
    await ctx.close();
  } finally {
    await first.stop();
  }
  // A new launch elsewhere, and a new browser profile: the same folder and URL, no Set up dialog.
  const second = await dashboard({ env: { A11Y_508_HOME: home } });
  try {
    expect((await api(second, '/api/env')).json.cwd).toBe(repo);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${second.origin}/run#secret=${second.secret}`);
    await expect(page.locator('h1')).toHaveText('Set up');
    await expect(page.getByTestId('setup-folder').first()).toHaveValue(repo);
    await expect(page.getByLabel('Start URL').first()).toHaveValue('http://127.0.0.1:9/remembered');
    await expect(page.getByRole('dialog', { name: 'Set up' })).toBeHidden();
    await ctx.close();
  } finally {
    await second.stop();
  }
});

test('startup: while the server is slow the page says Loading…, then what it waits on, then offers Retry', async ({ page }) => {
  test.setTimeout(90_000);
  const dash = await dashboard();
  try {
    let hold = true;
    await page.route('**/api/env*', async (route) => {
      if (hold) await new Promise((r) => setTimeout(r, 17_000));
      await route.continue().catch(() => {});
    });
    await page.goto(`${dash.origin}/run#secret=${dash.secret}`);
    await expect(page.getByTestId('startup')).toBeVisible({ timeout: 2000 });
    await expect(page.locator('h1')).toHaveText('Loading…');
    await expect(page.getByTestId('startup-note')).toHaveText('Still waiting: reading the working directory…', { timeout: 5000 });
    await expect(page.getByTestId('startup-retry')).toBeVisible({ timeout: 16_000 });
    hold = false;
    await page.getByTestId('startup-retry').click();
    await expect(page.getByRole('dialog', { name: 'Set up' })).toBeVisible({ timeout: 10_000 });
  } finally {
    await dash.stop();
  }
});

// The build the dashboard runs is on every screen, so two versions at once can be seen at a glance.
test('startup: the header names the commit the dashboard runs', async ({ page }) => {
  const dash = await dashboard();
  try {
    await open(page, dash, '/run');
    const git = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' });
    const rev = git.status === 0 ? git.stdout.trim() : '';
    await expect(page.getByTestId('build-revision')).toHaveText(rev ? `build ${rev}` : /^build v\d/);
  } finally {
    await dash.stop();
  }
});
