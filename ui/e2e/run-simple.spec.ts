// docs/plans/run-simple.md: the Run screen for the common case. A start URL and one
// button, Start, which opens a fresh browser window to sign in in and crawls there
// (--login --stay); everything else at /run/advanced, which nothing links to.

import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { api, dashboard, fixtureSite, moreOptions, open, readReport, startFromRun, status, tempDir, waitFinished, nav, removeTemp, argPattern } from './harness';
// @ts-ignore -- plain JS fixture shared with the core's tests
import { SESSION_COOKIE, SESSION_VALUE } from '../../test/fixture-site.mjs';

const start = (page: Page) => page.getByRole('button', { name: 'Start', exact: true });
const WAITING = 'A Chrome window is open: sign in there and stay on the app page. This continues by itself once the app has loaded.';

test('run-simple (a): the Run screen shows the URL and Start and nothing else; the other settings are at /run/advanced, which nothing links to', async ({ page }) => {
  const dash = await dashboard();
  try {
    await open(page, dash, '/run');
    await expect(page.getByLabel('Start URL')).toBeVisible();
    await expect(start(page)).toBeVisible();
    // No sign-in concept on the screen: no Sign in button, no sign-in state, no session line.
    await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0);
    await expect(page.getByTestId('signin-state')).toHaveCount(0);
    await expect(page.getByTestId('session-line')).toHaveCount(0);
    // The nav no longer offers a Sign in screen.
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Sign in' })).toHaveCount(0);

    // Nothing else: no More options control, no token, advanced or command fields.
    await expect(page.getByText(/More options/)).toHaveCount(0);
    await expect(page.getByTestId('more-options')).toHaveCount(0);
    await expect(page.getByLabel('A token')).toHaveCount(0);
    await expect(page.getByLabel('Cookies')).toHaveCount(0);
    await expect(page.getByLabel('Maximum pages')).toHaveCount(0);
    await expect(page.locator('details.advanced')).toHaveCount(0);
    await expect(page.getByTestId('command')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy command' })).toHaveCount(0);
    // Nothing links to the settings route; it still answers its address, with every field.
    await expect(page.locator('a[href*="/run/advanced"]')).toHaveCount(0);
    await moreOptions(page);
    await expect(page.getByLabel('A token')).toBeVisible();
    await expect(page.getByLabel('Cookies')).toBeVisible();
    await expect(page.getByLabel('Maximum pages')).toBeVisible();
    await expect(page.locator('details.advanced > summary')).toHaveText('Advanced');
    await expect(page.getByTestId('command')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy command' })).toBeVisible();
  } finally {
    await dash.stop();
  }
});

// Start, then the Live screen: the run is the sign-in crawl.
async function startSignIn(page: Page): Promise<void> {
  await start(page).click();
  await expect(page).toHaveURL(/\/live$/);
}

test('run-simple (b): Start opens a window to sign in in and crawls there (--login --stay): the wait, then the pages; the session is saved on the way', async ({ page }) => {
  const site = await fixtureSite({ autoLogin: true });
  const dash = await dashboard();
  try {
    await open(page, dash, '/run');
    await page.getByLabel('Start URL').fill(site.base + 'app.html');
    // The run's options come from the form.
    await moreOptions(page);
    await page.getByLabel('Maximum pages').fill('1');
    await page.locator('details.advanced > summary').click();
    await page.locator('#adv-no-zoom').check();
    await startSignIn(page);
    // The wait is the Live status line, not a warning.
    await expect(status(page)).toHaveText(WAITING, { timeout: 60_000 });
    await expect(page.locator('[data-notice="warn"]', { hasText: 'A browser window is open' })).toHaveCount(0);
    // The session file is the dashboard's own, outside the working directory.
    const sessionFile = (await api(dash, '/api/env')).json.session.file;
    await expect(page.getByTestId('run-command')).toHaveText(argPattern('--state', sessionFile, '--login --stay '));
    const cur = (await api(dash, '/api/runs/current')).json;
    expect(cur.kind).toBe('crawl');
    expect(cur.meta.command).toMatch(argPattern('--state', sessionFile, '--login --stay '));
    await expect(page.getByTestId('page-list').locator('tbody tr[data-url]')).toHaveCount(1, { timeout: 180_000 });
    await waitFinished(page);
    // The CLI's own sign-in lines are not dashboard warnings.
    await expect(page.locator('[data-notice="warn"]', { hasText: 'holds live credentials' })).toHaveCount(0);
    await expect(page.locator('[data-notice="warn"]', { hasText: 'A browser window is open' })).toHaveCount(0);
    const report = readReport(dash.cwd);
    expect(report.options.stay).toBe(true);
    expect(report.pages[0].finalUrl).toBe(site.base + 'app.html');
    expect(report.pages[0].error).toBeNull();
    expect(report.pages[0].title).toBe('Application - a11y-508 test site');
    expect(existsSync(sessionFile), 'the session file, saved for the fix loop').toBe(true);
    expect(existsSync(join(dash.cwd, 'a11y-508-state.json')), 'nothing in the working directory').toBe(false);
    // Back on Set up: the analysis for this URL is done, so it reads Continue; Crawl again signs in afresh.
    await nav(page, 'Run');
    await expect(page.getByTestId('setup-start').first()).toHaveText(/^Continue/);
    await expect(page.getByTestId('setup-start').first()).toBeEnabled();
    await expect(page.getByTestId('crawl-again').first()).toBeEnabled();
    await expect(page.getByTestId('session-line')).toHaveCount(0);
  } finally {
    await dash.stop();
    site.close();
  }
});

test('run-simple (c): with a saved session, Start still signs in afresh; the saved session is used headless only when chosen at /run/advanced', async ({ page }) => {
  const site = await fixtureSite({ autoLogin: true });
  const cwd = tempDir('a11y-508-simple-');
  const origin = new URL(site.base).origin;
  const dash = await dashboard({ cwd });
  // The session where the dashboard keeps it.
  const file = (await api(dash, '/api/env')).json.session.file;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    version: 1,
    capturedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    origins: [origin],
    cookies: [{ name: SESSION_COOKIE, value: SESSION_VALUE, domain: '127.0.0.1', path: '/', secure: false, httpOnly: false, sameSite: 'Lax', expires: -1 }],
    // What the fixture's sign-in page leaves behind, which its app.html checks for.
    storage: { [origin]: { local: { access_token: SESSION_VALUE, fixture_custom_key: SESSION_VALUE, state_key: 'from-state' }, session: { id_token: SESSION_VALUE, state_session_key: 'from-state' } } },
  }));
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000 - 10_000);
  utimesSync(file, fiveMinAgo, fiveMinAgo);
  try {
    await open(page, dash, '/run');
    await page.getByLabel('Start URL').fill(site.base + 'app.html');
    await moreOptions(page);
    // The saved session is offered at /run/advanced, with its age, and is not the default.
    const saved = page.getByLabel(/^Use saved session/);
    await expect(saved).toBeEnabled();
    await expect(saved).not.toBeChecked();
    await expect(page.locator('label[for="auth-state"]')).toContainText('state.json, 5 minutes old');
    await page.getByLabel('Maximum pages').fill('1');
    await page.locator('details.advanced > summary').click();
    await page.locator('#adv-no-zoom').check();
    // Start: a fresh sign-in window, never the saved session headless.
    await startSignIn(page);
    await expect(page.getByTestId('run-command')).toContainText('--login --stay');
    await waitFinished(page);
    // Chosen at /run/advanced, the saved session runs the headless crawl.
    await nav(page, 'Run');
    await moreOptions(page);
    await page.getByLabel(/^Use saved session/).check();
    await startFromRun(page);
    await expect(page.getByTestId('run-command')).toHaveText(argPattern('--state', file));
    const cur = (await api(dash, '/api/runs/current')).json;
    expect(cur.kind).toBe('crawl');
    expect(cur.meta.command).toMatch(argPattern('--state', file));
    expect(cur.meta.command).not.toContain('--login');
    await waitFinished(page);
    const report = readReport(cwd);
    expect(report.pages[0].finalUrl).toBe(site.base + 'app.html');
    expect(report.pages[0].error).toBeNull();
    expect(report.pages[0].title).toBe('Application - a11y-508 test site');
  } finally {
    await dash.stop();
    site.close();
    removeTemp(cwd);
  }
});

test('run-simple (d): a run bounced to a sign-in page on another origin offers Sign in on the Live screen, which signs in and crawls', async ({ page }) => {
  const listen = async (s: Server) => {
    await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
    return `http://127.0.0.1:${(s.address() as any).port}`;
  };
  const portal = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="en"><title>Sign in - portal</title><main><h1>Sign in</h1><form><label>User <input name="u"></label></form></main></html>');
  });
  const portalBase = await listen(portal);
  const app = createServer((_req, res) => {
    res.writeHead(302, { location: `${portalBase}/sso/login` });
    res.end();
  });
  const appBase = await listen(app);
  const dash = await dashboard();
  try {
    await open(page, dash, '/run');
    await page.getByLabel('Start URL').fill(appBase + '/');
    await moreOptions(page);
    // No session: running without one is a choice made at /run/advanced.
    await page.getByLabel('No sign-in').check();
    await page.getByLabel('Maximum pages').fill('1');
    await startFromRun(page);
    await waitFinished(page);
    const notice = page.locator('[data-notice="cannot-get-in"]');
    await expect(notice).toContainText('The crawler could not get into the app.');
    await expect(notice).toContainText('sent the crawler to a sign-in page');
    await expect(notice.getByRole('button', { name: 'Troubleshoot with these settings' })).toBeVisible();
    await notice.getByRole('button', { name: 'Sign in', exact: true }).click();
    // A new crawl that signs in and stays in the window; Live follows it.
    await expect(page).toHaveURL(/\/live$/);
    await expect(page.getByTestId('run-status')).toHaveText(/^A Chrome window is open/, { timeout: 60_000 });
    const cur = (await api(dash, '/api/runs/current')).json;
    expect(cur.kind).toBe('crawl');
    expect(cur.meta.command).toContain('--login --stay');
    expect(cur.meta.url).toBe(appBase + '/');
    // This portal never lets anyone in: Stop ends the sign-in, and Start is ready again.
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(status(page)).toHaveText('Stopped', { timeout: 30_000 });
    await nav(page, 'Run');
    await expect(start(page)).toBeEnabled();
  } finally {
    await dash.stop();
    app.closeAllConnections?.();
    app.close();
    portal.closeAllConnections?.();
    portal.close();
  }
});

test('run-simple (e): the Start URL is remembered in this browser, from a started run and from a typed URL on blur', async ({ page, context }) => {
  const dash = await dashboard();
  try {
    await open(page, dash, '/run');
    await expect(page.getByLabel('Start URL')).toHaveValue('');
    const started = 'http://127.0.0.1:9/remembered';
    await page.getByLabel('Start URL').fill(started);
    await moreOptions(page);
    await page.getByLabel('No sign-in').check();
    await page.getByLabel('Maximum pages').fill('1');
    await startFromRun(page);
    await waitFinished(page);
    const again = await context.newPage();
    await open(again, dash, '/run');
    await expect(again.getByLabel('Start URL')).toHaveValue(started);
    // A URL typed and left (blur) is kept too.
    const typed = 'http://127.0.0.1:9/typed';
    await again.getByLabel('Start URL').fill(typed);
    await again.getByLabel('Start URL').blur();
    const third = await context.newPage();
    await open(third, dash, '/run');
    await expect(third.getByLabel('Start URL')).toHaveValue(typed);
  } finally {
    await dash.stop();
  }
});
