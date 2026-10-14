// The analysis belongs to the URL, not the folder: changing the repository folder on Set up keeps
// the report (moved along) and returns to Results without a crawl; only a changed URL means a new crawl.

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { api, dashboard, fillRun, fixtureSite, gitRepo, nav, open, readReport, startFromRun, tempDir, waitFinished, QUICK, TOKEN } from './harness';

test('carry: a new folder with the same URL keeps the report and goes back to Results; a new URL is a new crawl', async ({ page }) => {
  const site = await fixtureSite();
  const a = tempDir('a11y-508-carry-a-');
  const b = tempDir('a11y-508-carry-b-');
  gitRepo(a);
  gitRepo(b);
  const dash = await dashboard({ cwd: a });
  try {
    await open(page, dash, '/run');
    await fillRun(page, { url: site.base, token: TOKEN, ...QUICK });
    await startFromRun(page);
    await waitFinished(page);
    const finishedAt = readReport(a).finishedAt;
    const runId = (await api(dash, '/api/runs/current')).json.id;
    await nav(page, 'Results');
    // Set up: the folder changes, the URL does not.
    await nav(page, 'Set up');
    const start = page.getByTestId('setup-start').first();
    await expect(start).toHaveText(/^Continue/);
    await expect(start).toHaveAccessibleName('Continue to the results for this URL');
    await expect(page.getByTestId('crawl-again').first()).toBeVisible();
    await page.getByTestId('setup-folder').first().fill(b);
    await start.click();
    await expect(page).toHaveURL(/\/report$/);
    expect((await api(dash, '/api/env')).json.cwd).toBe(b);
    expect(readReport(b, dash.home).finishedAt).toBe(finishedAt);
    expect(existsSync(dash.dirs(a).report), 'moved, not copied').toBe(false);
    for (const d of [a, b]) expect(existsSync(join(d, 'a11y-508-report')), `nothing of the tool's in ${d}`).toBe(false);
    await expect(page.getByTestId('result-line')).toBeVisible();
    // No run started.
    expect((await api(dash, '/api/runs/current')).json?.id ?? runId).toBe(runId);
    await expect(page.getByRole('navigation', { name: 'Steps' }).locator('[data-step="Results"]')).toHaveAttribute('aria-current', 'step');
    // A changed URL is a new analysis: Start, and the Crawl step.
    await nav(page, 'Set up');
    await page.getByLabel('Start URL').first().fill(site.base + 'about.html');
    await expect(start).toHaveText('Start');
    await expect(page.getByTestId('crawl-again')).toHaveCount(0);
    await start.click();
    await expect(page).toHaveURL(/\/live$/);
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.id).not.toBe(runId);
    await api(dash, '/api/runs/current/stop', { method: 'POST' });
  } finally {
    await dash.stop();
    site.close();
  }
});
