// docs/plans/checks-shadow-frames.md AC 11: a finding inside a web component in a same-origin frame
// is shown in the Report screen's finding detail with its whole " >>> " selector path and the frame
// it is in.

import { test, expect } from '@playwright/test';
import { dashboard, fixtureSite, open, fillRun, startFromRun, waitFinished, readReport, nav, TOKEN } from './harness';

test('checks-shadow-frames AC 11: the finding detail shows a " >>> " selector and the frame', async ({ page }) => {
  const site = await fixtureSite();
  const dash = await dashboard();
  try {
    await open(page, dash, '/run');
    await fillRun(page, { url: site.base + 'checks-frames.html', token: TOKEN, maxPages: 1, advanced: { 'no-zoom': true, 'no-screenshots': true } });
    await startFromRun(page);
    await waitFinished(page);

    const report = readReport(dash.cwd);
    const findings = report.pages.flatMap((p: any) => p.findings);
    const badge = findings.find((f: any) => f.test === '7.A' && f.selector === '#fr-same >>> #ff-badge >>> img');
    expect(badge, JSON.stringify(findings.map((f: any) => f.selector))).toBeTruthy();

    await nav(page, 'Report');
    await page.getByLabel('Text', { exact: true }).fill('#ff-badge');
    await page.getByTestId('finding-row').filter({ hasText: badge.message }).first().getByRole('button', { name: /Details/ }).click();
    const detail = page.getByTestId('detail');
    await expect(detail.getByTestId('detail-selector')).toHaveText('#fr-same >>> #ff-badge >>> img');
    await expect(detail.getByTestId('detail-frame')).toHaveText('#fr-same');
    await expect(detail.getByTestId('detail-selector-hint')).toContainText('shadow root of a web component or the document of a frame');
  } finally {
    await dash.stop();
    site.close();
  }
});
