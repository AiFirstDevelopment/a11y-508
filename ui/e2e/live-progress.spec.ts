// The Live screen while a page is audited (progress events), a page served with 404 that the app
// rendered, and page rows that show the route and open its findings. docs/plans/run-simple.md.

import { test, expect } from '@playwright/test';
import { dashboard, fixtureSite, open, fillRun, startFromRun, waitFinished, readReport, TOKEN, type Dash, type Site } from './harness';

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

test('live progress: a phase line says what the page in flight is doing; the progress events are in the raw stream; rows show the route and open its findings', async ({ page }) => {
  await open(page, dash, '/run');
  await fillRun(page, { url: site.base + 'variants.html', token: TOKEN, maxPages: 3, advanced: { 'no-zoom': true, 'no-screenshots': true } });
  // Record every phase line drawn during the run.
  await page.evaluate(() => {
    const w = window as any;
    w.__phases = [];
    new MutationObserver(() => {
      const t = document.querySelector('[data-testid="phase-line"]')?.textContent?.trim();
      if (t && w.__phases[w.__phases.length - 1] !== t) w.__phases.push(t);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await startFromRun(page);
  await waitFinished(page);
  const phases: string[] = await page.evaluate(() => (window as any).__phases);
  expect(phases.some((p) => /^(Checking [\d,]+ elements|Keyboard pass: \d+ of \d+ tab stops) · \d+ s$/.test(p)), phases.join(' | ')).toBe(true);
  await page.getByText('Show raw output').click();
  await expect(page.getByTestId('raw-output')).toContainText('"type":"progress"');

  // Each row shows the route, its query collapsed; the row opens that page's findings.
  const report = readReport(dash.cwd);
  const variant = report.pages.find((p: any) => /variant-target\.html\?from=/.test(p.finalUrl || p.url) && !p.error && !p.skipped);
  expect(variant, JSON.stringify(report.pages.map((p: any) => p.finalUrl))).toBeTruthy();
  const row = page.getByTestId('page-list').locator(`tr[data-url="${variant.finalUrl || variant.url}"]`);
  await expect(row.locator('th')).toHaveText(/^\s*\/variant-target\.html\s*\?…\s*$/);
  expect(await row.innerText()).not.toContain('?from=');
  await row.getByRole('link').click();
  await expect(page).toHaveURL(/\/report\?route=/);
  const selected = page.getByTestId('routes').locator('[data-testid="route"][aria-current="true"]');
  await expect(selected).toHaveAttribute('data-url', variant.finalUrl || variant.url);
  expect(await selected.innerText()).not.toContain('?from=');
});

test('soft 404: a page the server answers 404 for and the app renders is listed as ok, and nothing says 404', async ({ page }) => {
  await open(page, dash, '/run');
  await fillRun(page, { url: site.base + 'soft-404.html', token: TOKEN, maxPages: 1, advanced: { 'no-zoom': true, 'no-screenshots': true } });
  await startFromRun(page);
  await waitFinished(page);
  const status = page.getByTestId('page-list').locator('tbody tr').first().locator('td').first();
  await expect(status).toHaveText(/^\s*ok\s*$/);
  const report = readReport(dash.cwd);
  // The status is in the JSON; no note and no warning mention it (confusing, by request).
  expect(report.pages[0].servedWith).toBe(404);
  expect([...report.summary.coverage.notes, ...report.summary.coverage.warnings].some((n: string) => /404/.test(n))).toBe(false);
});
