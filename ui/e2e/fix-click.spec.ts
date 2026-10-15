// A click on Fix the violations is never lost, and a reload (or Chrome's crash restore) shows the
// live run or the last run's outcome, never a blank start state. docs/plans/resume.md, criteria 8–9.

import { test, expect, type Page } from '@playwright/test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { api, dashboard, fixtureSite, gitRepo, moreOptions, nav, open, removeTemp, run, stub, systemPath, tempDir, BIN, ROOT, TOKEN, type Dash, type Site } from './harness';

const FAKE = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'test', 'fake-agent.mjs'))} {promptFile} {resultFile}`;
const QUICK = ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A repository with the fixture's start page under site/, a committed config, and the crawl the
// person just ran, as the wizard leaves it before the Fix step.
async function appWithReport(site: Site, prefix: string, config: Record<string, unknown> = {}): Promise<{ cwd: string; g: (...a: string[]) => string }> {
  const cwd = tempDir(prefix);
  const g = gitRepo(cwd);
  mkdirSync(join(cwd, 'site'));
  cpSync(join(ROOT, 'test', 'fixtures', 'index.html'), join(cwd, 'site', 'index.html'));
  writeFileSync(join(cwd, '.gitignore'), 'a11y-508-work/\na11y-508-report/\na11y-508-history/\n');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({ url: site.base, args: QUICK, agent: FAKE, source: ['site'], push: false, deployed: 'none', triageBatch: 50, ...config }, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'app');
  const crawl = await run(process.execPath, [BIN, site.base, ...QUICK, '--out', 'a11y-508-report', '--quiet', '--fail-on', 'none'], { cwd, env: { ...process.env, TOKEN } });
  expect(crawl.status, crawl.output).toBe(0);
  return { cwd, g };
}

// The way in chosen on Set up (a token), so Fix the violations does not open a sign-in window.
async function withToken(page: Page): Promise<void> {
  await nav(page, 'Run');
  await moreOptions(page);
  await page.getByLabel('A token').check();
  await page.getByLabel(/^Token \(sent as/).fill(TOKEN);
  await nav(page, 'Fix loop');
  await expect(page.getByTestId('assistant-line')).toHaveText(/Fixing with/, { timeout: 60_000 });
}

// The tab as Chrome restores it after a crash: the address it had, loaded afresh.
async function restore(page: Page, dash: Dash, path = '/fix-loop?start=1'): Promise<void> {
  await page.goto(`${dash.origin}${path}#secret=${dash.secret}`);
  await expect(page.locator('h1')).toHaveText('Fix loop');
}

const runId = async (dash: Dash): Promise<string | null> => (await api(dash, '/api/runs/current')).json?.id ?? null;

test('fix-click AC8 / guard 8: a click while the assistants are still being detected waits, says Starting…, and starts the loop', async ({ page }) => {
  const site = await fixtureSite();
  // A stand-in Claude Code on PATH that takes its time, so the loop stays live.
  const bin = join(tempDir('a11y-508-stub-'), 'bin');
  stub(bin, 'claude', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "1.2.3 (stub claude)"; exit 0; fi\nsleep 60\n');
  const { cwd } = await appWithReport(site, 'a11y-508-click-pending-', { agent: 'claude' });
  const dash = await dashboard({ cwd, env: { PATH: systemPath(bin, dirname(process.execPath)), A11Y_508_DETECT_DELAY_MS: '8000' } });
  try {
    // No way in chosen: the loop signs in first, in a window of its own; that wait is the run too.
    await open(page, dash, '/fix-loop');
    await expect(page.getByTestId('assistant-line')).toHaveText('Detecting assistants…');
    const fix = page.getByTestId('loop-start');
    await expect(fix).toBeEnabled({ timeout: 5000 });
    await fix.click();
    // Still detecting: the click is taken, and the screen says so.
    await expect(page.getByTestId('fix-status')).toHaveText('Starting…');
    await expect(page.getByTestId('loop-start')).toBeDisabled();
    expect(await runId(dash)).toBeNull();
    // Once ready, the loop starts by itself: the running view, with Stop.
    await expect(page.getByTestId('loop-stop')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('fix-status')).toBeVisible();
    expect((await api(dash, '/api/runs/current')).json.kind).toBe('loop');
    await expect(page.getByTestId('loop-start')).toHaveCount(0);
    await page.getByTestId('loop-stop').click();
    await expect(page.getByTestId('loop-step')).toHaveText(/finished/, { timeout: 60_000 });
  } finally {
    await dash.stop();
    removeTemp(cwd);
    removeTemp(dirname(bin));
    site.close();
  }
});

test('fix-click AC8: a click while detecting that then finds no assistant says why it did not start', async ({ page }) => {
  const site = await fixtureSite();
  const { cwd } = await appWithReport(site, 'a11y-508-click-none-', { agent: 'claude' });
  const empty = join(tempDir('a11y-508-stub-'), 'bin');
  mkdirSync(empty, { recursive: true });
  const dash = await dashboard({ cwd, env: { PATH: systemPath(empty, dirname(process.execPath)), A11Y_508_DETECT_DELAY_MS: '5000' } });
  try {
    await open(page, dash, '/fix-loop');
    await expect(page.getByTestId('assistant-line')).toHaveText('Detecting assistants…');
    await page.getByTestId('loop-start').click({ timeout: 5000 });
    await expect(page.getByTestId('fix-status')).toHaveText('Starting…');
    await expect(page.getByTestId('run-error')).toHaveText('Choose an installed assistant first.', { timeout: 60_000 });
    await expect(page.getByTestId('fix-status')).toHaveCount(0);
    expect(await runId(dash)).toBeNull();
  } finally {
    await dash.stop();
    removeTemp(cwd);
    removeTemp(dirname(empty));
    site.close();
  }
});

test('fix-click AC8–9: a reload 1–3 s after the click shows the live run, never the start button, and starts no second run', async ({ page }) => {
  const site = await fixtureSite();
  const { cwd } = await appWithReport(site, 'a11y-508-click-reload-');
  const marks = tempDir('a11y-508-click-marks-');
  const dash = await dashboard({ cwd, env: { FAKE_AGENT_SLOW_ONCE: join(marks, 'slow'), FAKE_AGENT_SLOW_MS: '60000' } });
  try {
    await open(page, dash, '/fix-loop');
    await withToken(page);
    await page.getByTestId('loop-start').click();
    await sleep(1500);
    await restore(page, dash);
    // The live run, as it was: its status line and Stop; the start button nowhere.
    await expect(page.getByTestId('loop-stop')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('fix-status')).toBeVisible();
    await expect(page.getByTestId('loop-start')).toHaveCount(0);
    const id = await runId(dash);
    expect(id).not.toBeNull();
    // start=1 on the restored tab started nothing more.
    await sleep(3000);
    expect(await runId(dash)).toBe(id);
    await expect(page.locator('.notice.error')).toHaveCount(0);
    await page.getByTestId('loop-stop').click();
    await expect(page.getByTestId('loop-step')).toHaveText(/finished/, { timeout: 60_000 });
  } finally {
    await dash.stop();
    removeTemp(cwd);
    removeTemp(marks);
    site.close();
  }
});

test('fix-click AC9 / guard 9a: a loop that could not start still says so after a reload and after a relaunch, with its remedy and that it starts by itself', async ({ page }) => {
  const site = await fixtureSite();
  const { cwd } = await appWithReport(site, 'a11y-508-click-pre-');
  let dash: Dash = await dashboard({ cwd, keepCwd: true });
  try {
    // An edit nobody committed: the loop stops before its first round.
    writeFileSync(join(cwd, 'site', 'index.html'), readFileSync(join(cwd, 'site', 'index.html'), 'utf8') + '\n<!-- an edit in progress -->\n');
    await open(page, dash, '/fix-loop');
    await withToken(page);
    await page.getByTestId('loop-start').click();
    const heading = page.getByTestId('loop-problem').getByRole('heading', { name: 'The fix loop could not start' });
    await expect(heading).toBeVisible({ timeout: 60_000 });
    const id = await runId(dash);

    const shown = async () => {
      await expect(heading).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('problem-message')).toHaveText('uncommitted changes under site: site/index.html');
      await expect(page.getByTestId('problem-remedy')).toHaveText(/^Commit or stash them/);
      // docs/plans/turnkey-loop.md AC 5: no Try again; it starts by itself, and Stop is the one button.
      await expect(page.getByTestId('problem-next')).toHaveText('The loop starts by itself once that is done.');
      await expect(page.getByTestId('loop-stop')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
      await expect(page.getByTestId('loop-start')).toHaveCount(0);
    };
    // A reload: the outcome, as it was.
    await page.reload();
    await shown();
    // Chrome's crash restore of the tab opened from Results: the same, and start=1 starts nothing.
    await restore(page, dash);
    await shown();
    await sleep(3000);
    expect(await runId(dash)).toBe(id);
    // A relaunch of the dashboard: the outcome comes from the run journal.
    await dash.stop();
    // The same state base: the run journal is in the tool's own folder for the repository there.
    dash = await dashboard({ cwd, keepCwd: true, env: { A11Y_508_HOME: dash.home } });
    await restore(page, dash, '/fix-loop');
    await shown();
    expect(await runId(dash)).toBe(id);
  } finally {
    await dash.stop();
    removeTemp(cwd);
    site.close();
  }
});

test('fix-click AC9 / guard 9b: after a stopped loop, a reload with start=1 shows "Loop finished" with Fix the violations and starts nothing', async ({ page }) => {
  const site = await fixtureSite();
  const { cwd } = await appWithReport(site, 'a11y-508-click-done-');
  const marks = tempDir('a11y-508-click-marks-');
  const dash = await dashboard({ cwd, env: { FAKE_AGENT_SLOW_ONCE: join(marks, 'slow'), FAKE_AGENT_SLOW_MS: '60000' } });
  try {
    await open(page, dash, '/fix-loop');
    await withToken(page);
    await page.getByTestId('loop-start').click();
    await page.getByTestId('loop-stop').click({ timeout: 30_000 });
    await expect(page.getByTestId('loop-step')).toHaveText('Loop finished (stopped).', { timeout: 60_000 });
    const id = await runId(dash);
    await restore(page, dash);
    await expect(page.getByTestId('loop-step')).toHaveText('Loop finished (stopped).', { timeout: 30_000 });
    // The headline says what happened in a person's words, with Fix the violations as the one step forward.
    await expect(page.getByTestId('fix-status')).toHaveText('Stopped. Nothing was changed.');
    await expect(page.getByTestId('loop-start')).toHaveText('Fix the violations');
    await expect(page.locator('main button.big:visible, main a.button.big:visible')).toHaveCount(1);
    await expect(page.getByTestId('loop-continue-next')).toHaveCount(0);
    await sleep(3000);
    expect(await runId(dash)).toBe(id);
    expect((await api(dash, '/api/runs/current')).json.status).toBe('done');
  } finally {
    await dash.stop();
    removeTemp(cwd);
    removeTemp(marks);
    site.close();
  }
});
