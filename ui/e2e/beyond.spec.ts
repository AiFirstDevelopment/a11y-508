// docs/plans/checks-beyond-508.md AC 13: the Advanced checkbox turns on the WCAG 2.2 profile
// (--wcag 2.2), in the command shown and in the run itself, and Diagnostics lists the rules beyond
// Section 508 with the latest report's findings.

import { test, expect } from '@playwright/test';
import { dashboard, fixtureSite, goInApp, moreOptions, open, fillRun, startFromRun, waitFinished, readReport, TOKEN } from './harness';

test('checks-beyond-508 AC 13: the Advanced checkbox adds --wcag 2.2 to the command and the run; Diagnostics lists the new rules\' findings', async ({ page }) => {
  const site = await fixtureSite();
  const dash = await dashboard();
  try {
    await open(page, dash);
    await fillRun(page, { url: site.base + 'checks-beyond-index.html', token: TOKEN, maxPages: 3, advanced: { wcag: true, 'no-zoom': true } });
    await moreOptions(page);
    await page.getByLabel('Only audit URLs matching (one pattern per line)').fill('checks-beyond-');
    await expect(page.getByLabel(/^Also check WCAG 2\.2 \(beyond Section 508\)/)).toBeChecked();
    await expect(page.getByTestId('command')).toHaveText(/ --wcag 2\.2( |$)/);
    await startFromRun(page);
    await waitFinished(page);

    const report = readReport(dash.cwd);
    expect(report.options.wcag).toBe('2.2');
    const findings = report.pages.flatMap((p: any) => p.findings);
    const beyond = [...new Set(findings.filter((f: any) => f.beyond508 && report.catalog[f.test]?.beyond508).map((f: any) => f.test))] as string[];
    expect(beyond.length).toBeGreaterThan(0);
    // Diagnostics lists them with the rest of the latest report's findings.
    await goInApp(page, '/diagnostics');
    await expect(page.getByTestId('d-finding').first()).toBeVisible();
    const tests = await page.getByTestId('d-finding').locator('td:first-child').allTextContents();
    for (const t of beyond) expect(tests, t).toContain(t);
  } finally {
    await dash.stop();
    site.close();
  }
});
