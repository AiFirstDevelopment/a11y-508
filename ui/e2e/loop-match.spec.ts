// The wrong-repository safeguard: GET /api/loop/match looks for the latest report's markup in the
// folders the loop edits; when none of it is there, the Fix step says so in one line of information,
// never a gate (docs/plans/turnkey-loop.md AC 1).

import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { api, dashboard, fixtureSite, gitRepo, moreOptions, nav, open, run, stub, systemPath, tempDir, BIN, ROOT, TOKEN } from './harness';

function stubClaude(): NodeJS.ProcessEnv {
  const bin = join(tempDir('a11y-508-stub-'), 'bin');
  stub(bin, 'claude', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "1.2.3 (stub claude)"; fi\nexit 0\n');
  return { PATH: systemPath(bin, dirname(process.execPath)) };
}

async function crawl(url: string, out: string): Promise<void> {
  const r = await run(process.execPath, [BIN, url, '--max-pages', '4', '--no-interact', '--no-zoom', '--no-screenshots', '--fail-on', 'none', '--quiet', '--out', out], { env: { ...process.env, TOKEN } });
  expect(r.status, r.output).toBe(0);
}

async function toFix(page: Page, url: string): Promise<void> {
  await moreOptions(page);
  await page.getByLabel('Start URL').fill(url);
  await page.getByLabel('A token').check();
  await page.getByLabel(/^Token \(sent as/).fill(TOKEN);
  await nav(page, 'Fix loop');
  await expect(page.getByTestId('assistant-line')).toContainText('Fixing with Claude Code', { timeout: 60_000 });
}

test('wrong repository: a copy of a11y-508 holds none of the fixture report\'s markup; the Fix step says so, and Fix the violations is ready all the same', async ({ page }) => {
  const site = await fixtureSite();
  // The tool's own repository, as committed, in a directory of the test's (never the checkout itself).
  const cwd = tempDir('a11y-508-selfrepo-');
  const tar = join(tempDir('a11y-508-archive-'), 'head.tar');
  expect(spawnSync('git', ['-C', ROOT, 'archive', '--format=tar', '-o', tar, 'HEAD']).status).toBe(0);
  expect(spawnSync('tar', ['-xf', tar, '-C', cwd]).status).toBe(0);
  gitRepo(cwd);
  await crawl(site.base, join(cwd, 'a11y-508-report'));
  const dash = await dashboard({ cwd, env: stubClaude() });
  try {
    const m = (await api(dash, '/api/loop/match')).json;
    expect(m.report).toBe(true);
    expect(m.source).toEqual(['src']);
    expect(m.checked).toBeGreaterThan(5);
    expect(m.found, JSON.stringify(m.examples)).toBe(0);
    await open(page, dash, '/run');
    await toFix(page, site.base);
    await expect(page.getByTestId('wrong-repo')).toContainText("This repository does not seem to contain the app's code: none of the findings' markup was found under src. Choose the app's repository on Set up.");
    // Information, not a question: no Start anyway, and the loop can start.
    await expect(page.getByTestId('wrong-repo')).not.toHaveAttribute('role', 'alert');
    await expect(page.getByRole('button', { name: 'Start anyway' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Fix the violations' })).toBeEnabled();
  } finally {
    await dash.stop();
    site.close();
  }
});

test('right repository: the loop app matches its own report, and Fix is ready', async ({ page }) => {
  const cwd = tempDir('a11y-508-loopapp-');
  const setup = spawnSync(process.execPath, [join(ROOT, 'test', 'loop-app', 'setup.mjs'), cwd, '--agent', 'claude', '--port', '4399'], { encoding: 'utf8' });
  expect(setup.status, setup.stderr).toBe(0);
  // The Fix step wants a package.json (its build is the gate).
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'loop-app', private: true, scripts: { build: 'node check.mjs' } }));
  spawnSync('git', ['add', 'package.json'], { cwd });
  spawnSync('git', ['commit', '-q', '-m', 'package.json'], { cwd });
  const { startServer } = await import(pathToFileURL(join(cwd, 'server.mjs')).href);
  const server = await startServer(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  await crawl(url, join(cwd, 'a11y-508-report'));
  const dash = await dashboard({ cwd, env: stubClaude() });
  try {
    const m = (await api(dash, '/api/loop/match')).json;
    expect(m.source).toEqual(['site']);
    expect(m.found).toBeGreaterThan(0);
    for (const e of m.examples) expect(e.file).toMatch(/^site\//);
    await open(page, dash, '/run');
    await toFix(page, url);
    await expect(page.getByRole('button', { name: 'Fix the violations' })).toBeEnabled();
    await expect(page.getByTestId('wrong-repo')).toHaveCount(0);
  } finally {
    await dash.stop();
    server.close();
  }
});
