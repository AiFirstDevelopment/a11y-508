// The dashboard in a browser of its own: launched without --no-open it opens Chrome with a
// persistent profile and a DevTools port, and a crawl's sign-in and pages are a tab in that same
// window (the CLI's --connect); the tab closes when the crawl ends and the dashboard's stays.

import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAIN, fixtureSite, stopTree, tempDir, removeTemp } from './harness';

test('own browser: the dashboard opens in Chrome of its own, and a crawl runs as a tab in that window', async () => {
  const site = await fixtureSite({ autoLogin: true });
  const home = join(tempDir('a11y-508-ownhome-'), '.a11y-508');
  const cwd = tempDir('a11y-508-owncwd-');
  const proc = spawn(process.execPath, [MAIN, '--port', '0'], { cwd, env: { ...process.env, TOKEN: '', A11Y_508_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    await expect.poll(() => out, { timeout: 30_000 }).toContain('opened in its own browser window');
    const portFile = join(home, 'browser-profile', 'DevToolsActivePort');
    expect(existsSync(portFile)).toBe(true);
    const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const origin = /open: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)![1];
    await expect.poll(() => context.pages().filter((p) => p.url().startsWith(origin)).length, { timeout: 30_000 }).toBe(1);
    const dash = context.pages().find((p) => p.url().startsWith(origin))!;
    // A first visit: Set up. The URL, then the page limit at /run/advanced, then Start.
    const dialog = dash.getByRole('dialog', { name: 'Set up' });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByLabel('Start URL').fill(site.base + 'app.html');
    await dash.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await dash.evaluate(() => {
      history.pushState(null, '', '/run/advanced');
      dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });
    await dash.getByLabel('Maximum pages').fill('1');
    const pagesBefore = context.pages().length;
    await dash.getByRole('button', { name: 'Start', exact: true }).click();
    // The sign-in and the crawl: a tab in this window.
    await expect.poll(() => context.pages().length, { timeout: 30_000 }).toBe(pagesBefore + 1);
    await expect(dash.getByTestId('run-command')).toContainText(`--connect ${port} --login`);
    await expect(dash.getByTestId('crawl-status')).toHaveText(/^(Sign in in the tab that just opened|Analyzing|Loading|Taking|Starting|Done)/);
    // Done: the tab is closed, the dashboard's stays and moves on to Results.
    await expect(dash).toHaveURL(/\/report$/, { timeout: 180_000 });
    await expect.poll(() => context.pages().length, { timeout: 30_000 }).toBe(pagesBefore);
    const report = JSON.parse(readFileSync(join(cwd, 'a11y-508-report', 'report.json'), 'utf8'));
    expect(report.options.connected).toBe(true);
    expect(report.pages[0].finalUrl).toBe(site.base + 'app.html');
    expect(report.pages[0].error).toBeNull();
  } finally {
    await browser?.close().catch(() => {});
    await stopTree(proc, 'SIGINT');
    site.close();
    removeTemp(cwd);
  }
});
