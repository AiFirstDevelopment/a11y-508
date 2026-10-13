// The wizard: the setup dialog on a first visit, the remembered working directory, the stepper
// (Set up → Crawl → Results → Fix → History), the uncluttered default views, and a repository
// left clean (the dashboard's files live in its own directory). docs/plans/run-simple.md.

import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, dashboard, fixtureSite, gitRepo, moreOptions, open, readReport, tempDir, TOKEN, waitFinished } from './harness';

const steps = (page: Page) => page.getByRole('navigation', { name: 'Steps' });
const stepLink = (page: Page, name: string) => steps(page).getByRole('link', { name: new RegExp(`^${name}`) });
const stepOff = (page: Page, name: string) => steps(page).locator(`[aria-disabled="true"][data-step="${name}"]`);

test('setup: a first visit opens the Set up dialog; Start switches the folder, remembers both, and starts the crawl; a reload shows no dialog', async ({ page }) => {
  const dash = await dashboard();
  const repo = tempDir('a11y-508-wizrepo-');
  gitRepo(repo);
  try {
    await open(page, dash, '/run', { fresh: true });
    const dialog = page.getByRole('dialog', { name: 'Set up' });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((d: HTMLDialogElement) => d.matches(':modal') && d.contains(document.activeElement))).toBe(true);
    // The URL is still empty: Escape does nothing.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("App's repository folder").fill(repo);
    await dialog.getByLabel('Start URL').fill('http://127.0.0.1:9/');
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/live$/);
    await expect(page.getByTestId('cwd').locator('.visually-hidden')).toHaveText(repo);
    expect(await page.evaluate(() => [localStorage.getItem('a11y508.cwd'), localStorage.getItem('a11y508.startUrl')])).toEqual([repo, 'http://127.0.0.1:9/']);
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.meta?.command || '').toContain('--login --stay');
    await api(dash, '/api/runs/current/stop', { method: 'POST' });
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.status, { timeout: 30_000 }).toBe('done');
    // Remembered: a reload shows no dialog, and the header names the folder.
    await page.reload();
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.getByTestId('cwd').locator('.visually-hidden')).toHaveText(repo);
    await expect(page.getByRole('dialog', { name: 'Set up' })).toBeHidden();
  } finally {
    await dash.stop();
  }
});

test('stepper: while a crawl runs only Set up and Crawl are reachable; when it finishes the wizard is on Results, with Fix available in a repository; default views are uncluttered', async ({ page }) => {
  const site = await fixtureSite();
  const cwd = tempDir('a11y-508-wizstep-');
  gitRepo(cwd);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  const dash = await dashboard({ cwd });
  try {
    await open(page, dash, '/run', { details: false });
    await expect(stepLink(page, 'Set up')).toHaveAttribute('aria-current', 'step');
    await page.getByLabel('Start URL').fill(site.base);
    await moreOptions(page);
    await page.getByLabel('A token').check();
    await page.getByLabel(/^Token \(sent as/).fill(TOKEN);
    await page.getByLabel('Maximum pages').fill('3');
    await page.locator('details.advanced > summary').click();
    await page.locator('#adv-no-zoom').check();
    await page.locator('#adv-max-screenshots').fill('2');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page).toHaveURL(/\/live$/);
    await expect(stepLink(page, 'Crawl')).toHaveAttribute('aria-current', 'step');
    for (const s of ['Results', 'Fix', 'History']) await expect(stepOff(page, s)).toHaveCount(1);
    // The Crawl step: one status line, the bar, the counts, Stop; no table until Details is opened.
    await expect(page.getByTestId('crawl-status')).toBeVisible();
    await expect(page.getByTestId('crawl-counts')).toHaveText(/^\d+ violations? · \d+ to review$/);
    await expect(page.locator('main table:visible')).toHaveCount(0);
    await expect(page.getByTestId('run-command')).toBeHidden();
    // Finished: the wizard is on Results by itself, with Fix available.
    await expect(page).toHaveURL(/\/report$/, { timeout: 240_000 });
    await expect(stepLink(page, 'Results')).toHaveAttribute('aria-current', 'step');
    await expect(stepLink(page, 'Fix')).toBeVisible();
    await expect(stepLink(page, 'Crawl')).toHaveAccessibleName(/Crawl \(done\)/);
    // Results: no charts or totals until Details.
    await expect(page.getByTestId('result-line')).toBeVisible();
    await expect(page.getByTestId('totals')).toBeHidden();
    await expect(page.locator('app-chart-panel#by-impact')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Fix the violations' })).toBeEnabled();
    const report = readReport(cwd);
    expect(report.summary.audited).toBeGreaterThan(0);
    // The repository is left clean: the outputs are excluded, the dashboard's own files are elsewhere.
    expect(spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).stdout.split('\n').filter((l) => l && !/package\.json/.test(l))).toEqual([]);
    // Fix: the assistant line, what it will do, the button; no ledger board or page table until Details.
    await stepLink(page, 'Fix').click();
    await expect(page.getByTestId('loop-plan')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fix the violations' })).toBeVisible();
    await expect(page.locator('main table:visible')).toHaveCount(0);
    await expect(page.getByTestId('ledger-counts')).toBeHidden();
    // History: the timeline; no chart until Details.
    await stepLink(page, 'History').click();
    await expect(page.getByTestId('history')).toBeVisible();
    await expect(page.locator('app-chart-panel:visible')).toHaveCount(0);
  } finally {
    await dash.stop();
    site.close();
  }
});

test('a sign-in crawl leaves the repository clean (git status --porcelain is empty)', async ({ page }) => {
  const site = await fixtureSite({ autoLogin: true });
  const cwd = tempDir('a11y-508-wizclean-');
  const g = gitRepo(cwd);
  writeFileSync(join(cwd, 'README.md'), 'app\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  const dash = await dashboard({ cwd });
  try {
    await open(page, dash, '/run');
    await page.getByLabel('Start URL').fill(site.base + 'app.html');
    await moreOptions(page);
    await page.getByLabel('Maximum pages').fill('1');
    await page.locator('details.advanced > summary').click();
    await page.locator('#adv-no-zoom').check();
    await page.locator('#adv-no-screenshots').check();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page).toHaveURL(/\/live$/);
    await waitFinished(page);
    expect(readReport(cwd).options.stay).toBe(true);
    expect(spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).stdout).toBe('');
  } finally {
    await dash.stop();
    site.close();
  }
});
