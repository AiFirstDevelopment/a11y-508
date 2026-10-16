// A search screen through the dashboard: the crawler fills the form, presses its Search button once
// the fill has enabled it, follows the results, and Diagnostics shows the search, the result page and
// what was pressed.

import { test, expect } from '@playwright/test';
import { dashboard, fixtureSite, goInApp, open, fillRun, startFromRun, waitFinished, readReport, TOKEN, type Dash, type Site } from './harness';

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

test('search: a Search button disabled until the dates are filled is pressed, the result page is crawled, and Diagnostics says so', async ({ page }) => {
  await open(page, dash);
  await fillRun(page, { url: site.base + 'search-disabled.html', token: TOKEN, maxPages: 3, advanced: { 'no-zoom': true } });
  await startFromRun(page);
  await waitFinished(page);
  const report = readReport(dash.cwd);
  const start = report.pages.find((p: any) => /search-disabled\.html$/.test(p.url));
  expect(start.search.forms[0].pressed).toBe('Search');
  await goInApp(page, '/diagnostics');
  const rows = page.getByTestId('d-routes-table').locator('tbody tr');
  await expect(rows.filter({ hasText: '/search-disabled.html' }).getByTestId('d-route-found')).toContainText('1 search → 1 result');
  await expect(rows.filter({ hasText: '/result-65.html' })).toHaveCount(1);
  await expect(page.getByTestId('d-coverage-notes')).toContainText(/Search form on \/search-disabled\.html: filled \d{2}\/\d{2}\/\d{4} to \d{2}\/\d{2}\/\d{4}\. Pressed "Search": 1 result\./);
});
