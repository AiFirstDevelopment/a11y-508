// docs/plans/checks-beyond-508.md AC 13: the Run form's Advanced checkbox turns on the WCAG 2.2
// profile (--wcag 2.2), in the command shown and in the run itself, and the Report screen lists the
// rules beyond Section 508 under a heading of their own, in its table and in its test filter.

import { test, expect } from '@playwright/test';
import { dashboard, fixtureSite, open, fillRun, startFromRun, waitFinished, readReport, nav, TOKEN } from './harness';

test('checks-beyond-508 AC 13: the Advanced checkbox adds --wcag 2.2 to the command and the run; the Report screen groups the new rules under their heading', async ({ page }) => {
  const site = await fixtureSite();
  const dash = await dashboard();
  try {
    await open(page, dash, '/run');
    await fillRun(page, { url: site.base + 'checks-beyond-index.html', token: TOKEN, maxPages: 3, advanced: { wcag: true, 'no-zoom': true, 'no-screenshots': true } });
    await page.getByLabel('Only audit URLs matching (one pattern per line)').fill('checks-beyond-');
    await expect(page.getByLabel(/^Also check WCAG 2\.2 \(beyond Section 508\)/)).toBeChecked();
    const command = page.getByTestId('command');
    await expect(command).toHaveText(/ --wcag 2\.2( |$)/);
    await startFromRun(page);
    await waitFinished(page);

    const report = readReport(dash.cwd);
    expect(report.options.wcag).toBe('2.2');
    const findings = report.pages.flatMap((p: any) => p.findings);
    const beyond = [...new Set(findings.filter((f: any) => f.beyond508 && report.catalog[f.test]?.beyond508).map((f: any) => f.test))] as string[];
    expect(beyond.length).toBeGreaterThan(0);

    await nav(page, 'Report');
    await expect(page.getByTestId('beyond-heading')).toHaveText('Beyond Section 508 (WCAG 2.2)');
    // The table under the heading: one row per rule with findings, with report.json's counts.
    const rows = await page.getByTestId('beyond-tests').locator('tbody tr').evaluateAll((trs) => trs.map((tr) => Array.from(tr.children).map((c) => c.textContent!.trim())));
    const expected = Object.entries(report.summary.byTest as Record<string, any>)
      .filter(([t, c]) => report.catalog[t]?.beyond508 && (c.violations || c.reviews))
      .map(([t, c]) => [t, report.catalog[t].name, report.catalog[t].wcag, String(c.violations), String(c.reviews)]);
    expect(rows).toEqual(expected);
    expect(rows.map((r) => r[0]).sort()).toEqual([...beyond].sort());
    // The test filter lists them in a group with the same heading, apart from the Trusted Tester tests.
    const group = page.locator('#f-test optgroup[label="Beyond Section 508 (WCAG 2.2)"]');
    expect((await group.locator('option').allTextContents()).sort()).toEqual([...beyond].sort());
    const tt = await page.locator('#f-test optgroup[label="Trusted Tester"] option').allTextContents();
    expect(tt.length).toBeGreaterThan(0);
    for (const t of tt) expect(report.catalog[t]?.beyond508).toBeFalsy();
  } finally {
    await dash.stop();
    site.close();
  }
});
