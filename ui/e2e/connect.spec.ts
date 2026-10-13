// --connect: the CLI attaches to a browser that is already running (the dashboard's own window),
// opens its tabs there, crawls in the sign-in tab, and closes its tabs but never the browser.

import { test, expect, chromium } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureSite, run, tempDir, BIN, removeTemp } from './harness';

test('--connect: the sign-in tab opens in the running browser, the crawl continues in it, and its tabs close while the browser stays', async () => {
  const site = await fixtureSite({ autoLogin: true });
  const profile = tempDir('a11y-508-connect-profile-');
  const out = tempDir('a11y-508-connect-out-');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, args: ['--remote-debugging-port=0'] });
  try {
    // Chrome writes the port it chose to DevToolsActivePort in its profile.
    await expect.poll(() => existsSync(join(profile, 'DevToolsActivePort'))).toBe(true);
    const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    const before = context.pages().length;
    let opened = 0;
    context.on('page', () => opened++);
    const r = await run(process.execPath, [BIN, site.base, '--connect', port, '--login', '--max-pages', '4', '--no-interact', '--no-zoom', '--no-screenshots', '--out', out, '--json'], { cwd: out, env: { ...process.env, TOKEN: '' }, timeout: 240_000 });
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    expect(opened, r.output.slice(-3000)).toBeGreaterThan(0);
    expect(report.options.connected).toBe(true);
    expect(report.options.stay).toBe(true);
    expect(report.options.concurrency).toBe(1);
    expect(report.pages.filter((p: any) => !p.error && !p.skipped).length, r.output.slice(-3000)).toBeGreaterThanOrEqual(3);
    // Its tabs are closed; the browser is still open and answers.
    await expect.poll(() => context.pages().length).toBe(before);
    const page = await context.newPage();
    await page.goto('about:blank');
    await page.close();
  } finally {
    await context.close();
    site.close();
    removeTemp(profile);
    removeTemp(out);
  }
});
