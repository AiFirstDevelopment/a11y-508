// The fix loop's settings under Advanced: they save a config the core accepts. (The loop itself, from
// Start, is one-screen.spec.ts.)

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loopOptions, dashboard, open, BIN, api } from './harness';


test('AC 11: the loop settings under Advanced save a config a11y-508 loop accepts, and rejects what the core rejects with its message', async ({ page }) => {
  const dash = await dashboard();
  try {
    await open(page, dash, '/advanced');
    await loopOptions(page);
    // Saved as each field changes. With no start URL anywhere, the core's own message, from normalizeConfig.
    await page.getByLabel('Crawl options, one per line').fill('--max-pages\n1');
    await page.getByLabel('Crawl options, one per line').blur();
    await expect(page.getByTestId('config-errors')).toHaveText('no start URL: pass it on the command line or set "url" in the config');
    expect(existsSync(join(dash.cwd, 'a11y-508.config.json'))).toBe(false);

    await page.getByLabel('Start URL').fill('http://127.0.0.1:9/');
    await page.getByLabel('Start URL').blur();
    await page.getByLabel('Folders the assistant may edit, one per line').fill('site');
    await page.getByLabel('Folders the assistant may edit, one per line').blur();
    await page.getByLabel('Check command (build and test)').fill('npm test');
    await page.getByLabel('Check command (build and test)').blur();
    await page.getByLabel('Fix attempts per finding').fill('2');
    await page.getByLabel('Fix attempts per finding').blur();
    await page.getByLabel("Push each round's commits").uncheck();
    await expect(page.getByTestId('config-status')).toHaveText(/^Saved/);
    // Saved where the dashboard keeps its files, not in the working directory.
    const cfgFile = (await api(dash, '/api/env')).json.config.file;
    await expect.poll(() => (existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')).push : null)).toBe(false);
    expect(existsSync(join(dash.cwd, 'a11y-508.config.json'))).toBe(false);
    const { writtenBy, ...written } = JSON.parse(readFileSync(cfgFile, 'utf8'));
    expect(writtenBy).toBe('a11y-508-dashboard');
    // What was set, with the inferred branch, and the deployment watched silently (it happens outside this tool).
    // deployTimeout 0: no limit (docs/plans/turnkey-loop.md AC 2).
    expect(written).toEqual({ url: 'http://127.0.0.1:9/', args: ['--max-pages', '1'], source: ['site'], check: 'npm test', branch: 'a11y-508', maxAttempts: 2, push: false, deployed: 'bundle-change', deployTimeout: 0 });
    // No round limit on the screen either (the loop from the dashboard has none).
    await expect(page.getByLabel('Rounds per run')).toHaveCount(0);
    // No deploy settings on the screen at all.
    await expect(page.getByLabel('How the loop knows the new build is live')).toHaveCount(0);
    await expect(page.getByLabel('Deploy command')).toHaveCount(0);

    // a11y-508 loop accepts it: with an agent it passes validation and gets as far as the git check.
    writeFileSync(join(dash.cwd, 'a11y-508.config.json'), JSON.stringify({ ...written, agent: 'claude' }));
    const r = spawnSync(process.execPath, [BIN, 'loop', '--max-rounds', '1'], { cwd: dash.cwd, encoding: 'utf8', env: { ...process.env, TOKEN: '', A11Y_508_HOME: dash.home } });
    expect(r.stdout + r.stderr).toContain('is not a git repository');
    expect(r.stdout + r.stderr).not.toMatch(/no start URL|no agent|deploy" command|must be command/);
  } finally {
    await dash.stop();
  }
});
