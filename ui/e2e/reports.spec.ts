// Incomplete coverage on the Report screen, and History.

import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { moreOptions, dashboard, fixtureSite, open, fillRun, startFromRun, waitFinished, nav, readReport, TOKEN, type Dash, type Site } from './harness';

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

test('AC 6: a pass with coverage warnings reads "PASS on N pages, but coverage is incomplete", never a plain PASS', async ({ page }) => {
  await open(page, dash, '/run');
  await fillRun(page, { url: site.base + 'submit', token: TOKEN, advanced: { 'no-interact': true, 'no-zoom': true, 'no-screenshots': true } });
  await startFromRun(page);
  await waitFinished(page);
  const report = readReport(dash.cwd);
  expect(report.passed).toBe(true);
  expect(report.summary.coverage.complete).toBe(false);
  await nav(page, 'Report');
  const line = page.getByTestId('result-line');
  await expect(line).toHaveText(`PASS on ${report.summary.audited} pages, but coverage is incomplete`);
  await expect(line).not.toHaveText('PASS');
  const warnings = page.getByTestId('coverage-warnings').locator('li');
  await expect(warnings).toHaveText(report.summary.coverage.warnings);
  await expect(page.locator('#crawl-progress-label')).toHaveCount(0);
  await nav(page, 'Live run');
  await expect(page.locator('#crawl-progress-label')).toHaveText(/PASS, coverage incomplete$/);
});

test('AC 15: History lists both crawls and the loop rounds; each opens on the Report screen; a11y-508-report holds only the latest', async ({ page }) => {
  // A dry-run loop first, so there is a round to list beside the crawls.
  writeFileSync(join(dash.cwd, 'a11y-508.config.json'), JSON.stringify({ url: site.base + 'about.html', args: ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots'] }));
  await open(page, dash, '/run');
  await moreOptions(page);
  await page.getByLabel('A token').check();
  await page.getByLabel(/^Token \(sent as/).fill(TOKEN);
  await nav(page, 'Fix loop');
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByTestId('loop-step')).toHaveText(/Dry run finished/, { timeout: 200_000 });

  const crawl = async (path: string) => {
    await nav(page, 'Run');
    await fillRun(page, { url: site.base + path, token: TOKEN, maxPages: 1, advanced: { 'no-interact': true, 'no-zoom': true, 'no-screenshots': true } });
    await startFromRun(page);
    await waitFinished(page);
    expect(existsSync(join(dash.cwd, 'a11y-508-report', 'report.json')), `a11y-508-report holds the crawl of ${path} that just finished`).toBe(true);
    return readReport(dash.cwd);
  };
  const first = await crawl('about.html');
  const second = await crawl('tables.html');
  // The latest stays where the runbook says; the earlier one moved to history.
  expect(readReport(dash.cwd).finishedAt).toBe(second.finishedAt);
  expect(readReport(dash.cwd).baseUrl).toBe(site.base + 'tables.html');
  const hist = readdirSync(join(dash.cwd, 'a11y-508-history'));
  expect(hist).toEqual([first.finishedAt.replace(/:/g, '-')]);
  expect(existsSync(join(dash.cwd, 'a11y-508-history', hist[0], 'report.json'))).toBe(true);

  await nav(page, 'History');
  const rows = page.getByTestId('history').locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('data-source', 'latest');
  await expect(rows.nth(1)).toHaveAttribute('data-source', 'history');
  await expect(rows.nth(2)).toHaveAttribute('data-source', 'round');
  await expect(rows.nth(0)).toContainText('tables.html');
  await expect(rows.nth(1)).toContainText('about.html');

  for (const [i, url, heading] of [[0, 'tables.html', 'Latest report'], [1, 'about.html', /Report from/], [2, 'about.html', 'Report: loop round 1']] as const) {
    await nav(page, 'History');
    await rows.nth(i).getByRole('link').click();
    await expect(page).toHaveURL(i === 0 ? /\/report$/ : /\/report\/(h-|round-)/);
    await expect(page.getByTestId('result-line')).toBeVisible();
    await expect(page.locator('h1')).toHaveText(heading);
    await expect(page.getByText(site.base + url, { exact: false }).first()).toBeVisible();
  }
});
