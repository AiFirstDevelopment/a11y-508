// The analysis belongs to the URL, not the folder: changing the repository folder on Set up carries
// the report along (it is the new folder's history once Start crawls). Start is Set up's one button:
// it always crawls (docs/plans/turnkey-loop.md AC 7).

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { api, dashboard, fillRun, fixtureSite, gitRepo, nav, open, readReport, startFromRun, tempDir, waitFinished, QUICK, TOKEN } from './harness';

test('carry, turnkey AC7: a new folder with the same URL carries the report along, and Start crawls; there is no Continue or Crawl again', async ({ page }) => {
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
    // Set up: the folder changes, the URL does not. Start, and nothing else.
    await nav(page, 'Set up');
    const start = page.getByTestId('setup-start').first();
    await expect(start).toHaveText('Start');
    await expect(page.getByTestId('crawl-again')).toHaveCount(0);
    await page.getByTestId('setup-folder').first().fill(b);
    await start.click();
    await expect(page).toHaveURL(/\/live$/);
    expect((await api(dash, '/api/env')).json.cwd).toBe(b);
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.id).not.toBe(runId);
    // The report came along (moved, not copied), and is the new folder's history now that it crawls again.
    expect(existsSync(dash.dirs(a).report), 'moved, not copied').toBe(false);
    await expect.poll(() => existsSync(join(dash.dirs(b).history, finishedAt.replace(/:/g, '-'), 'report.json'))).toBe(true);
    for (const d of [a, b]) expect(existsSync(join(d, 'a11y-508-report')), `nothing of the tool's in ${d}`).toBe(false);
    await api(dash, '/api/runs/current/stop', { method: 'POST' });
  } finally {
    await dash.stop();
    site.close();
  }
});
