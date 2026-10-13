// AC 9: Sign in runs --login-only against the fixture's autoLogin mode.
// The nav no longer links to the Sign in screen: the Run screen signs in in place
// (docs/plans/run-simple.md). The route still answers a direct address.

import { test, expect } from '@playwright/test';
import { dashboard, fixtureSite, open, moreOptions, startFromRun, waitFinished, readReport } from './harness';

test('AC 9: Sign in waits for the session, saves it, switches Run to the saved session, and the next crawl audits app.html', async ({ page }) => {
  const site = await fixtureSite({ autoLogin: true });
  const dash = await dashboard();
  try {
    await open(page, dash, '/run');
    await page.getByLabel('Start URL').fill(site.base);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const st = page.getByTestId('signin-state');
    await expect(st).toContainText('A Chrome window is open', { timeout: 60_000 });
    await expect(st).toContainText('Signed in · session saved', { timeout: 120_000 });
    await moreOptions(page);
    await expect(page.getByLabel(/^Use saved session/)).toBeChecked();
    await expect(page.getByLabel(/^Use saved session/)).toBeEnabled();
    await page.getByLabel('Start URL').fill(site.base + 'app.html');
    await page.getByLabel('Maximum pages').fill('1');
    await startFromRun(page);
    await expect(page.getByTestId('run-command')).toContainText('--state a11y-508-state.json');
    await waitFinished(page);
    const report = readReport(dash.cwd);
    expect(report.pages[0].finalUrl).toBe(site.base + 'app.html');
    expect(report.pages[0].error).toBeNull();
    expect(report.pages[0].title).toBe('Application - a11y-508 test site');
  } finally {
    await dash.stop();
    site.close();
  }
});

test('AC 9: the Sign in route still answers a direct address, though the nav no longer links to it', async ({ page }) => {
  const dash = await dashboard();
  try {
    await open(page, dash, '/sign-in');
    await expect(page.locator('h1')).toHaveText('Sign in');
    await expect(page.getByRole('button', { name: 'Open the sign-in window' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Sign in' })).toHaveCount(0);
  } finally {
    await dash.stop();
  }
});
