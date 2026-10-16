// Diagnostics (docs/plans/simple-screen.md AC 4, guard e): one page with everything useful to the
// tool's developer, in one order, copied or downloaded whole as text; Change folder or URL and
// Advanced at its bottom. And the diagnostics diary in it (docs/plans/browser-diary.md): when the
// dashboard's own browser goes away, a notice says why, with Reopen the window and Details.

import { test, expect } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, dashboard, gitRepo, go, now, open, tempDir, useToken, fixtureSite, ROOT } from './harness';

const FAKE = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'test', 'fake-agent.mjs'))} {promptFile} {resultFile}`;

const launches = (home: string): unknown[] => {
  const f = join(home, 'browser-profile', 'fake-launches.log');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
};

// AC 4's sections, in its order.
const HEADINGS = ['Build and setup', 'Counts', 'What happened', 'Rounds', 'Routes crawled', 'Findings in the latest report', 'Could not be fixed', 'Deploy record', 'Changes by round', 'Assistants', 'Diagnostics diary', /^Output of the (current|last) run$/];

test('diagnostics AC4, guard e: every section in order, the whole page copied and downloaded as text; Change folder or URL and Advanced at the bottom', async ({ page, context }) => {
  test.setTimeout(400_000);
  const site = await fixtureSite();
  const cwd = tempDir('a11y-508-diag-loop-');
  const g = gitRepo(cwd);
  mkdirSync(join(cwd, 'site'));
  cpSync(join(ROOT, 'test', 'fixtures', 'index.html'), join(cwd, 'site', 'index.html'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({ url: site.base, args: ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage'], agent: FAKE, source: ['site'], push: false, deployed: 'none', maxAttempts: 1, triageBatch: 50 }, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'app');
  const dash = await dashboard({ cwd });
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: dash.origin });
    // A loop that ran: rounds, a report with findings, changes.
    await open(page, dash);
    await useToken(page);
    await go(page).click();
    await expect(now(page)).toHaveText(/^Done: /, { timeout: 300_000 });
    await page.getByTestId('diagnostics-link').click();
    await expect(page).toHaveURL(/\/diagnostics$/);
    const pageEl = page.getByTestId('diagnostics-page');
    // Guard e: every heading, in order.
    await expect(pageEl.locator('h2:visible')).toHaveText(HEADINGS);
    await expect(page.getByTestId('d-folder')).toHaveText(cwd);
    await expect(page.getByTestId('d-config')).toContainText('"agent"');
    await expect(page.getByTestId('d-counts-line')).toHaveText(/^\d+ found · /);
    await expect(page.getByTestId('d-tally')).toHaveText(/^\d+ rounds? /);
    const firstRound = page.getByTestId('d-rounds-table').locator('tbody tr').first();
    await expect(firstRound).toBeVisible();
    await expect(page.getByTestId('d-routes-table').locator('tbody tr').first()).toBeVisible();
    const firstFinding = page.getByTestId('d-finding').first();
    await expect(firstFinding).toBeVisible();
    await expect(page.getByTestId('d-output-text')).not.toHaveText('(no output)');
    // Copy diagnostics: the whole page as text, the rounds table's first row and the first finding in it.
    await page.getByTestId('copy-diagnostics').click();
    await expect(page.getByTestId('diagnostics-copied')).toHaveText('Copied the whole page.');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    for (const h of HEADINGS) expect(copied).toMatch(typeof h === 'string' ? new RegExp(`^${h}$`, 'm') : new RegExp(h.source, 'm'));
    expect(copied).toContain(await firstRound.innerText());
    expect(copied).toContain(await firstFinding.innerText());
    // Download diagnostics: the same text, as a .txt file.
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-diagnostics').click()]);
    expect(download.suggestedFilename()).toMatch(/^a11y-508-diagnostics-.+\.txt$/);
    const saved = readFileSync((await download.path())!, 'utf8');
    expect(saved).toContain(await firstRound.innerText());
    expect(saved).toContain(await firstFinding.innerText());
    // At the bottom, and nowhere else: Change folder or URL (the setup dialog), and Advanced.
    const links = page.locator('main a');
    await expect(links.last()).toBeVisible();
    await page.getByTestId('advanced-link').click();
    await expect(page).toHaveURL(/\/advanced$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Advanced');
    await expect(page.getByTestId('picker')).toBeVisible();
    await expect(page.getByTestId('more-options')).toBeVisible();
    await expect(page.getByTestId('loop-more')).toBeVisible();
    await page.goBack();
    await page.getByTestId('change-setup').click();
    await expect(page.getByRole('dialog', { name: 'Set up' })).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    await api(dash, '/api/runs/current/stop', { method: 'POST' }).catch(() => {});
    await dash.stop();
    site.close();
  }
});

test('guard 4, AC4: the own browser goes away: the notice says why, Reopen the window starts it again, Details opens Diagnostics', async ({ page }) => {
  const dash = await dashboard({ ownBrowser: true, env: { A11Y_508_NO_RESTORE: '1' } });
  try {
    await expect.poll(() => dash.output(), { timeout: 20_000 }).toContain('opened in its own browser window');
    await open(page, dash, '/', { url: 'http://127.0.0.1:9/' });
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

test('guard 6, AC5: Diagnostics lists the diary newest first, and Copy diagnostics copies it with the rest of the page', async ({ page, context }) => {
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
    await open(page, dash, '/', { url: 'http://127.0.0.1:9/' });
    await page.getByTestId('diagnostics-link').click();
    await expect(page).toHaveURL(/\/diagnostics$/);
    const entries = page.getByTestId('diagnostics-text');
    // Newest first: the dashboard's own start, then the seeded exit, then the Stop before it.
    await expect(entries.first()).toHaveText(new RegExp(`^The dashboard started for ${dash.cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(process \\d+\\)\\.$`));
    await expect(entries.nth(1)).toHaveText(seeded);
    await expect(entries.nth(2)).toHaveText('a11y-508 ran Stop, ending process 4242 (the loop run).');
    await page.getByRole('button', { name: 'Copy diagnostics' }).click();
    await expect(page.getByTestId('diagnostics-copied')).toHaveText('Copied the whole page.');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('The dashboard started for ');
    expect(copied).toContain(seeded);
    expect(copied).toContain('exit code 1, signal none');
    expect(copied).toContain('[1014/165200.000:ERROR:browser_main_loop.cc] seeded stderr line');
    expect(copied).toContain('a11y-508 ran Stop, ending process 4242 (the loop run).');
  } finally {
    await dash.stop();
  }
});
