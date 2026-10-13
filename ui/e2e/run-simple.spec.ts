// docs/plans/run-simple.md: the Run screen for the common case. A start URL,
// the sign-in state with a Sign in button that runs the login flow in place,
// Start, and everything else behind a closed "More options…".

import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, dashboard, fixtureSite, moreOptions, open, readReport, startFromRun, tempDir, waitFinished } from './harness';
// @ts-ignore -- plain JS fixture shared with the core's tests
import { SESSION_COOKIE, SESSION_VALUE } from '../../test/fixture-site.mjs';

const start = (page: Page) => page.getByRole('button', { name: 'Start', exact: true });
const signInState = (page: Page) => page.getByTestId('signin-state');

test('run-simple (a): the Run screen shows the URL, the sign-in state and Start; the rest stays hidden until More options… is opened', async ({ page }) => {
  const dash = await dashboard();
  try {
    await open(page, dash, '/run');
    await expect(page.getByLabel('Start URL')).toBeVisible();
    await expect(signInState(page)).toBeVisible();
    await expect(signInState(page)).toHaveAttribute('role', 'status');
    await expect(signInState(page)).toHaveText('Not signed in');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    // One assumed way in: with no session there is no Start button, only Sign in.
    await expect(start(page)).toHaveCount(0);
    // The nav no longer offers a Sign in screen.
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Sign in' })).toHaveCount(0);

    const more = page.getByTestId('more-options');
    await expect(more).toHaveJSProperty('open', false);
    await expect(more.locator('> summary')).toHaveText('More options…');
    await expect(page.getByLabel('A token')).toBeHidden();
    await expect(page.getByLabel('Cookies')).toBeHidden();
    await expect(page.getByLabel('Maximum pages')).toBeHidden();
    await expect(page.locator('details.advanced > summary')).toBeHidden();
    await expect(page.getByTestId('command')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Copy command' })).toBeHidden();

    await page.getByText('More options…').click();
    await expect(more).toHaveJSProperty('open', true);
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

test('run-simple (b): with no session, Sign in runs one crawl that signs in and stays in that window: the wait, then the pages, with --login --stay', async ({ page }) => {
  const site = await fixtureSite({ autoLogin: true });
  const dash = await dashboard();
  try {
    await open(page, dash, '/run');
    await expect(signInState(page)).toHaveText('Not signed in');
    await page.getByLabel('Start URL').fill(site.base + 'app.html');
    await expect(start(page)).toHaveCount(0);
    // The run's options come from the form, as for Start.
    await moreOptions(page);
    await page.getByLabel('Maximum pages').fill('1');
    await page.locator('details.advanced > summary').click();
    await page.locator('#adv-no-zoom').check();
    await page.locator('#adv-no-screenshots').check();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // No Start: the sign-in is the run, and Live follows it.
    await expect(page).toHaveURL(/\/live$/);
    // The wait is the Live status line, not a warning.
    await expect(page.getByTestId('run-status')).toHaveText('A Chrome window is open: sign in there and stay on the app page. This continues by itself once the app has loaded.', { timeout: 60_000 });
    await expect(page.locator('[data-notice="warn"]', { hasText: 'A browser window is open' })).toHaveCount(0);
    await expect(page.getByTestId('run-command')).toContainText('--login --stay --state a11y-508-state.json');
    const cur = (await api(dash, '/api/runs/current')).json;
    expect(cur.kind).toBe('crawl');
    expect(cur.meta.command).toContain('--login --stay --state a11y-508-state.json');
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
    // Back on Run: the session is saved, and Start uses it from now on.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Run', exact: true }).click();
    await expect(signInState(page)).toHaveText(/^Signed in · session saved just now \(.+\)$/);
    // The time saved, in local time, with the ISO string for precision.
    const t = signInState(page).locator('time');
    const iso = await t.getAttribute('datetime');
    await expect(t).toHaveText(await page.evaluate((a) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(a!)), iso));
    await expect(page.getByRole('button', { name: 'Sign in again' })).toBeVisible();
    await expect(start(page)).toBeEnabled();
  } finally {
    await dash.stop();
    site.close();
  }
});

test('run-simple (c): a session saved before launch is shown with its age, and Start uses it without a sign-in', async ({ page }) => {
  const site = await fixtureSite({ autoLogin: true });
  const cwd = tempDir('a11y-508-simple-');
  const origin = new URL(site.base).origin;
  const file = join(cwd, 'a11y-508-state.json');
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
  const dash = await dashboard({ cwd });
  try {
    await open(page, dash, '/run');
    await expect(signInState(page)).toHaveText(/^Signed in · session saved 5 min ago \(.+\)$/);
    await expect(page.getByRole('button', { name: 'Sign in again' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
    await expect(start(page)).toBeVisible();
    await page.getByLabel('Start URL').fill(site.base + 'app.html');
    await expect(start(page)).toBeEnabled();
    // On first load the saved session is the mode in effect, not "A token".
    await moreOptions(page);
    await expect(page.getByLabel(/^Use saved session/)).toBeChecked();
    await expect(page.getByLabel('A token')).not.toBeChecked();
    await expect(page.getByTestId('command')).toContainText('--state a11y-508-state.json');
    await page.getByLabel('Maximum pages').fill('1');
    await page.locator('details.advanced > summary').click();
    await page.locator('#adv-no-zoom').check();
    await page.locator('#adv-no-screenshots').check();
    await startFromRun(page);
    await expect(page.getByTestId('run-command')).toContainText('--state a11y-508-state.json');
    const cur = (await api(dash, '/api/runs/current')).json;
    expect(cur.kind).toBe('crawl');
    expect(cur.meta.command).toContain('--state a11y-508-state.json');
    // A session that already exists: the faster headless crawl, no sign-in window.
    expect(cur.meta.command).not.toContain('--login');
    await waitFinished(page);
    const report = readReport(cwd);
    expect(report.pages[0].finalUrl).toBe(site.base + 'app.html');
    expect(report.pages[0].error).toBeNull();
    expect(report.pages[0].title).toBe('Application - a11y-508 test site');
  } finally {
    await dash.stop();
    site.close();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10 });
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
    // No session: running without one is a choice made under More options.
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
    // This portal never lets anyone in: on Run, cancel the sign-in, which says so in place with Try again.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Run', exact: true }).click();
    await expect(signInState(page)).toContainText('A Chrome window is open');
    await page.getByRole('button', { name: 'Cancel sign-in' }).click();
    await expect(signInState(page)).toContainText('Sign-in did not finish', { timeout: 30_000 });
    await expect(signInState(page)).toBeFocused();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
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
