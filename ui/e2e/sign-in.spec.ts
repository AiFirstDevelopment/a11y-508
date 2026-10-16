// AC 9: Start, with no way in chosen, signs in through the fixture's autoLogin portal and crawls in
// the signed-in tab (docs/plans/simple-screen.md). --login --stay: the CLI crawls in the signed-in window.

import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dashboard, fixtureSite, fillRun, now, open, run, startFromRun, waitFinished, readReport, tempDir, BIN, api, removeTemp } from './harness';

test('AC 9: Start signs in through the app\'s portal (no way in chosen), saves the session, and the crawl audits app.html', async ({ page }) => {
  const site = await fixtureSite({ autoLogin: true });
  const dash = await dashboard();
  try {
    await open(page, dash);
    await fillRun(page, { url: site.base + 'app.html', maxPages: 1 });
    await startFromRun(page);
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.meta?.command || '', { timeout: 30_000 }).toMatch(/ --login( |$)/);
    await waitFinished(page, 180_000);
    await expect(now(page)).toHaveText(/^Done: crawled 1 page, /);
    expect((await api(dash, '/api/env')).json.session.exists).toBe(true);
    const report = readReport(dash.cwd);
    expect(report.pages[0].finalUrl).toBe(site.base + 'app.html');
    expect(report.pages[0].error).toBeNull();
    expect(report.pages[0].title).toBe('Application - a11y-508 test site');
  } finally {
    await dash.stop();
    site.close();
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
    removeTemp(cwd);
  }
});
