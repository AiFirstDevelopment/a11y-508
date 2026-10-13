// The Fix loop works out what it can and shows it: the assistant, the sign-in state, one line of
// what will happen (from GET /api/loop/defaults), and one button. docs/plans/run-simple.md.

import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { api, dashboard, gitRepo, moreOptions, open, stub, systemPath, tempDir, TOKEN, nav, removeTemp } from './harness';

// A stand-in Claude Code on PATH, so the installed assistant is known and harmless.
function stubClaude(): { bin: string; env: NodeJS.ProcessEnv } {
  const bin = join(tempDir('a11y-508-stub-'), 'bin');
  stub(bin, 'claude', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "1.2.3 (stub claude)"; fi\nexit 0\n');
  return { bin, env: { PATH: systemPath(bin, dirname(process.execPath)) } };
}

async function signInWithToken(page: Page, url: string): Promise<void> {
  await moreOptions(page);
  await page.getByLabel('Start URL').fill(url);
  await page.getByLabel('A token').check();
  await page.getByLabel(/^Token \(sent as/).fill(TOKEN);
}

test('fix loop: the line says what it will do from the repository; the sign-in state shows; Fix writes the inferred config', async ({ page }) => {
  const { bin, env } = stubClaude();
  const cwd = tempDir('a11y-508-fixapp-');
  const g = (...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('remote', 'add', 'origin', 'https://example.invalid/app.git');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app', scripts: { build: 'ng build', test: 'ng test' } }));
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'main.ts'), 'export {};\n');
  const dash = await dashboard({ cwd, env });
  try {
    await open(page, dash, '/run');
    await signInWithToken(page, 'http://127.0.0.1:9/');
    await nav(page, 'Fix loop');
    await expect(page.getByTestId('assistant-line')).toContainText('Fixing with Claude Code (1.2.3 (stub claude))', { timeout: 60_000 });
    // The picker stays out of the way until "change".
    await expect(page.getByTestId('picker')).toBeHidden();
    // No sign-in concept on the screen: Fix the violations signs in by itself when it needs to.
    await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0);
    // What will happen, from the repository's own facts.
    await expect(page.getByTestId('loop-plan')).toHaveText(/^\s*Edits src · gate npm run build && npm test · commits to branch a11y-508 · pushes to origin\s*$/);
    expect(existsSync(join(cwd, 'a11y-508.config.json'))).toBe(false);
    const fix = page.getByRole('button', { name: 'Fix the violations' });
    await expect(fix).toBeEnabled();
    await fix.click();
    // Written where the dashboard keeps its files, not in the repository.
    const cfgFile = (await api(dash, '/api/env')).json.config.file;
    expect(cfgFile.startsWith(cwd)).toBe(false);
    await expect.poll(() => existsSync(cfgFile)).toBe(true);
    expect(JSON.parse(readFileSync(cfgFile, 'utf8'))).toEqual({
      url: 'http://127.0.0.1:9/', agent: 'claude', source: ['src'], check: 'npm run build && npm test', branch: 'a11y-508', push: true, maxAttempts: 3, deployed: 'bundle-change', deployTimeout: 1800000, writtenBy: 'a11y-508-dashboard',
    });
    expect(existsSync(join(cwd, 'a11y-508.config.json'))).toBe(false);
    // A token was chosen on Run, so the loop does not sign in first.
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.kind).toBe('loop');
    expect((await api(dash, '/api/runs/current')).json.meta.command).not.toContain('--sign-in-first');
    await api(dash, '/api/runs/current/stop', { method: 'POST' });
    await expect(page.getByTestId('loop-step')).toHaveText(/finished/, { timeout: 60_000 });
  } finally {
    await dash.stop();
    removeTemp(cwd);
    removeTemp(dirname(bin));
  }
});

test('fix loop: in a folder that is not the app\'s repository the line says to choose it, and Fix is disabled', async ({ page }) => {
  const { bin, env } = stubClaude();
  const dash = await dashboard({ env });
  try {
    await open(page, dash, '/run');
    await signInWithToken(page, 'http://127.0.0.1:9/');
    await nav(page, 'Fix loop');
    await expect(page.getByTestId('assistant-line')).toContainText('Fixing with Claude Code', { timeout: 60_000 });
    await expect(page.getByTestId('not-git')).toHaveText(`Choose the app's repository on Set up; ${dash.cwd} is not a git repository and has no package.json.`);
    await expect(page.getByRole('button', { name: 'Fix the violations' })).toBeDisabled();
  } finally {
    await dash.stop();
    removeTemp(dirname(bin));
  }
});

test('fix loop: with no way in chosen, Fix the violations starts the loop with a sign-in first (round 1 crawls in a fresh window)', async ({ page }) => {
  const { bin, env } = stubClaude();
  const cwd = tempDir('a11y-508-fixsign-');
  gitRepo(cwd);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app', scripts: { build: 'true' } }));
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({ url: 'http://127.0.0.1:9/', agent: 'claude', check: 'npm run build', push: false }));
  const dash = await dashboard({ cwd, env });
  try {
    await open(page, dash, '/fix-loop');
    await expect(page.getByTestId('assistant-line')).toContainText('Fixing with Claude Code', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Fix the violations' }).click();
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.meta?.command || '').toContain('--sign-in-first');
    expect((await api(dash, '/api/runs/current')).json.kind).toBe('loop');
    await api(dash, '/api/runs/current/stop', { method: 'POST' });
    await expect(page.getByTestId('loop-step')).toHaveText(/finished/, { timeout: 60_000 });
  } finally {
    await dash.stop();
    removeTemp(cwd);
    removeTemp(dirname(bin));
  }
});
