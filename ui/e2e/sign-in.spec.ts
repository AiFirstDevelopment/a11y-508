// AC 9: Sign in runs --login-only against the fixture's autoLogin mode. The nav
// no longer links to the Sign in screen (the Run screen's Sign in runs a
// --login --stay crawl; docs/plans/run-simple.md); the route still works by address.
// --login --stay: the CLI crawls in the signed-in window.

import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dashboard, fixtureSite, open, nav, moreOptions, run, startFromRun, waitFinished, readReport, tempDir, BIN, api } from './harness';

test('AC 9: Sign in waits for the session, saves it, switches Run to the saved session, and the next crawl audits app.html', async ({ page }) => {
  const site = await fixtureSite({ autoLogin: true });
  const dash = await dashboard();
  try {
    await open(page, dash, '/sign-in');
    await page.getByLabel('Start URL').fill(site.base);
    await page.getByRole('button', { name: 'Open the sign-in window' }).click();
    const st = page.getByTestId('signin-status');
    await expect(st).toContainText('A Chrome window has opened', { timeout: 60_000 });
    await expect(st).toContainText('Signed in. The session was saved to', { timeout: 120_000 });
    await nav(page, 'Run');
    await moreOptions(page);
    await expect(page.getByLabel(/^Use saved session/)).toBeChecked();
    await expect(page.getByLabel(/^Use saved session/)).toBeEnabled();
    await page.getByLabel('Start URL').fill(site.base + 'app.html');
    await page.getByLabel('Maximum pages').fill('1');
    await startFromRun(page);
    await expect(page.getByTestId('run-command')).toContainText(`--state ${(await api(dash, '/api/env')).json.session.file}`);
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

test('--login --stay: the CLI signs in, saves the session, and crawls in the same visible window, one tab, with the session', async () => {
  const site = await fixtureSite({ autoLogin: true });
  const cwd = tempDir('a11y-508-stay-');
  try {
    const out = join(cwd, 'report');
    // Asynchronously: this process serves the fixture site.
    const r = await run(process.execPath, [BIN, site.base, '--login', '--stay', '--max-pages', '6', '--no-interact', '--no-zoom', '--no-screenshots', '--out', out, '--json'], { cwd, env: { ...process.env, TOKEN: '' }, timeout: 240_000 });
    expect(existsSync(join(out, 'report.json')), r.output.slice(-4000)).toBe(true);
    expect(existsSync(join(cwd, 'a11y-508-state.json')), 'the session file is still saved').toBe(true);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    // The crawl ran in the sign-in window: recorded as such, one tab at a time.
    expect(report.options.stay).toBe(true);
    expect(report.options.concurrency).toBe(1);
    expect(report.options.session).not.toBeNull();
    const audited = report.pages.filter((p: any) => !p.error && !p.skipped);
    expect(audited.length, r.output.slice(-4000)).toBeGreaterThanOrEqual(3);
    // Every audited page is the app's own, not the sign-in page.
    for (const p of audited) expect(new URL(p.finalUrl || p.url).pathname).not.toBe('/login.html');
  } finally {
    site.close();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10 });
  }
});
