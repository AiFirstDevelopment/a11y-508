// docs/plans/checks-shadow-frames.md AC 11: a finding inside a web component in a same-origin frame
// is shown in Diagnostics with its whole " >>> " selector path and the frame it is in.

import { test, expect } from '@playwright/test';
import { dashboard, fixtureSite, goInApp, open, fillRun, startFromRun, waitFinished, readReport, TOKEN } from './harness';

test('checks-shadow-frames AC 11: Diagnostics shows the finding\'s " >>> " selector and the frame', async ({ page }) => {
  const site = await fixtureSite();
  const dash = await dashboard();
  try {
    await open(page, dash);
    await fillRun(page, { url: site.base + 'checks-frames.html', token: TOKEN, maxPages: 1, advanced: { 'no-zoom': true } });
    await startFromRun(page);
    await waitFinished(page);

    const report = readReport(dash.cwd);
    const findings = report.pages.flatMap((p: any) => p.findings);
    // The image inside the web component inside the frame, found by what it renders.
    const badge = findings.find((f: any) => f.test === '7.A' && /badge\.png/.test(f.html || ''));
    expect(badge, JSON.stringify(findings.map((f: any) => f.selector))).toBeTruthy();

    // Diagnostics: the finding with its whole " >>> " selector path and the frame it is in.
    await goInApp(page, '/diagnostics');
    const row = page.getByTestId('d-finding').filter({ hasText: badge.message }).filter({ hasText: '#fr-same >>> #ff-badge >>> img' });
    await expect(row.getByTestId('d-finding-selector')).toHaveText('#fr-same >>> #ff-badge >>> img (in frame #fr-same)');
  } finally {
    await dash.stop();
    site.close();
  }
});
