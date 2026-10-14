// The diagnostics diary in the dashboard (docs/plans/browser-diary.md): when the dashboard's own
// browser goes away, a notice at the top of the wizard says why, with Reopen the window and
// Details; the Diagnostics screen lists the diary newest first and copies it as text.

import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dashboard, open, tempDir } from './harness';

const launches = (home: string): unknown[] => {
  const f = join(home, 'browser-profile', 'fake-launches.log');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
};

test('guard 4, AC4: the own browser goes away: the notice says why, Reopen the window starts it again, Details opens Diagnostics', async ({ page }) => {
  const dash = await dashboard({ ownBrowser: true, env: { A11Y_508_NO_RESTORE: '1' } });
  try {
    await expect.poll(() => dash.output(), { timeout: 20_000 }).toContain('opened in its own browser window');
    await open(page, dash, '/run');
    await expect(page.getByTestId('browser-notice')).toHaveCount(0);
    const port = readFileSync(join(dash.home, 'browser-profile', 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    await fetch(`http://127.0.0.1:${port}/exit?code=3`).catch(() => {});
    const text = page.getByTestId('browser-notice-text');
    await expect(text).toHaveText(/^The dashboard's browser window closed at \d{1,2}:\d{2} [AP]M \(Chrome exited unexpectedly — exit code 3, signal none\)\.$/, { timeout: 15_000 });
    // The terminal printed the same sentence.
    expect(dash.output()).toContain((await text.textContent())!.trim());
    const reopen = page.getByRole('button', { name: 'Reopen the window' });
    await expect(reopen).toBeVisible();
    expect(launches(dash.home)).toHaveLength(1);
    await reopen.click();
    await expect(page.getByTestId('browser-reopened')).toHaveText('The window is open again.', { timeout: 20_000 });
    expect(launches(dash.home)).toHaveLength(2);
    // Still there after a reload, until dismissed.
    await page.reload();
    await expect(page.getByTestId('browser-notice-text')).toBeVisible();
    await page.getByTestId('browser-details').click();
    await expect(page).toHaveURL(/\/diagnostics$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Diagnostics' })).toBeVisible();
    await page.getByTestId('browser-dismiss').click();
    await expect(page.getByTestId('browser-notice')).toHaveCount(0);
  } finally {
    await dash.stop();
  }
});

test('guard 6, AC5: Diagnostics lists the diary newest first, and Copy diagnostics copies it as text', async ({ page, context }) => {
  const home = join(tempDir('a11y-508-diag-home-'), '.a11y-508');
  mkdirSync(home, { recursive: true });
  const seeded = "The dashboard's browser window closed at 4:52 PM (Chrome was killed — exit code 1, signal none — during round 2, checking fix 3; a11y-508 had just run Stop).";
  const lines = [
    { at: '2026-10-14T20:51:00.000Z', pid: 1, type: 'kill', kill: 'stop', target: 4242, run: 'loop' },
    { at: '2026-10-14T20:52:00.000Z', pid: 1, type: 'own-browser-exit', code: 1, signal: null, stderr: ['[1014/165200.000:ERROR:browser_main_loop.cc] seeded stderr line'], doing: 'round 2, checking fix 3', kill: 'stop', message: seeded },
  ];
  writeFileSync(join(home, 'diary.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const dash = await dashboard({ env: { A11Y_508_HOME: home } });
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: dash.origin });
    await open(page, dash, '/run');
    await page.getByTestId('diagnostics-link').click();
    await expect(page).toHaveURL(/\/diagnostics$/);
    const entries = page.getByTestId('diagnostics-text');
    // Newest first: the dashboard's own start, then the seeded exit, then the Stop before it.
    await expect(entries.first()).toHaveText(new RegExp(`^The dashboard started for ${dash.cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(process \\d+\\)\\.$`));
    await expect(entries.nth(1)).toHaveText(seeded);
    await expect(entries.nth(2)).toHaveText('a11y-508 ran Stop, ending process 4242 (the loop run).');
    await page.getByRole('button', { name: 'Copy diagnostics' }).click();
    await expect(page.getByTestId('diagnostics-copied')).toHaveText('Copied the last 3 entries.');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const rows = copied.split('\n');
    expect(rows[0]).toMatch(/Z {2}The dashboard started for /);
    expect(copied).toContain(`2026-10-14T20:52:00.000Z  ${seeded}\n    exit code 1, signal none\n    Chrome's last output:\n      [1014/165200.000:ERROR:browser_main_loop.cc] seeded stderr line`);
    expect(copied).toContain('2026-10-14T20:51:00.000Z  a11y-508 ran Stop, ending process 4242 (the loop run).');
  } finally {
    await dash.stop();
  }
});
