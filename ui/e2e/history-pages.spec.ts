// History: the pages-audited count of every row is a link that opens that report on its Pages
// list, reads "2 of 9" when pages were crawled but not audited, and flags incomplete coverage.

import { test, expect } from '@playwright/test';
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dashboard, fixtureSite, open, fillRun, startFromRun, waitFinished, nav, readReport, TOKEN, type Dash, type Site } from './harness';

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

test('History: the pages-audited count opens the report on its Pages list; "N of M" and the coverage flag say when the crawl saw more than it audited', async ({ page }) => {
  // Details closed everywhere: the link has to open the Results step's Details itself.
  await open(page, dash, '/run', { details: false });
  await fillRun(page, { url: site.base + 'about.html', token: TOKEN, maxPages: 2, advanced: { 'no-interact': true, 'no-zoom': true } });
  await startFromRun(page);
  await waitFinished(page);
  const report = readReport(dash.cwd);
  expect(report.summary.audited).toBe(2);
  expect(report.summary.pages).toBe(2);
  expect(report.summary.coverage.complete).toBe(false);

  // An earlier crawl that saw a page it could not audit: the same report, with one page in error.
  const earlier = JSON.parse(JSON.stringify(report));
  earlier.finishedAt = '2026-10-14T20:28:00.000Z';
  earlier.pages.push({ url: site.base + 'missing.html', title: '', status: 0, error: 'net::ERR_FAILED', findings: [], passes: {}, errors: [] });
  earlier.summary.pages = 3;
  earlier.summary.coverage = { complete: true, warnings: [], notes: [] };
  const dir = join(dash.dirs().history, earlier.finishedAt.replace(/:/g, '-'));
  cpSync(dash.dirs().report, dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), JSON.stringify(earlier, null, 2));

  await nav(page, 'History');
  const rows = page.getByTestId('history');
  const latest = rows.locator('tr[data-source="latest"]');
  const link = latest.getByTestId('audited-link');
  await expect(link).toHaveText('2');
  await expect(link).toHaveAccessibleName(`See which 2 pages were audited in Crawl of /about.html (${site.base}about.html)`);
  await expect(latest.getByTestId('coverage-flag')).toHaveText(/coverage incomplete/);

  const old = rows.locator('tr[data-source="history"]');
  const oldLink = old.getByTestId('audited-link');
  await expect(oldLink).toHaveText('2 of 3');
  await expect(oldLink).toHaveAccessibleName(/^See which 2 of 3 pages were audited in Earlier crawl of/);
  await expect(old.getByTestId('coverage-flag')).toHaveCount(0);

  // The latest: the count opens the latest report on its Pages list, Details open, the heading focused.
  await link.click();
  await expect(page).toHaveURL(/\/report#pages$/);
  await expect(page.getByTestId('details')).toHaveJSProperty('open', true);
  const heading = page.getByRole('heading', { name: 'Pages', level: 2 });
  await expect(heading).toBeFocused();
  const listed = page.getByTestId('report-pages').locator('tbody tr');
  await expect(listed).toHaveCount(2);
  for (const p of report.pages) await expect(page.getByTestId('report-pages').locator(`tr[data-url="${p.finalUrl || p.url}"]`)).toHaveCount(1);

  // An earlier report: the same, at its own address, with the page that was not audited in the list.
  await nav(page, 'History');
  await oldLink.click();
  await expect(page).toHaveURL(/\/report\/h-[^#]+#pages$/);
  await expect(page.getByTestId('details')).toHaveJSProperty('open', true);
  await expect(page.getByRole('heading', { name: 'Pages', level: 2 })).toBeFocused();
  await expect(listed).toHaveCount(3);
  await expect(page.getByTestId('report-pages').locator(`tr[data-url="${site.base}missing.html"]`)).toContainText('net::ERR_FAILED');
  // The findings-by-page list above holds the audited pages (and Site-wide), never the page in error.
  await expect(page.getByTestId('routes').locator('[data-testid="route"]:not([data-url="site-wide"])')).toHaveCount(2);
  await expect(page.getByTestId('routes').locator(`[data-url="${site.base}missing.html"]`)).toHaveCount(0);
});
