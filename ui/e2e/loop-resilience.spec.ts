// The fix loop never dead-ends: it continues on the branch in the way, and when it cannot start or
// stops, the Fix step says so with the remedy and a Try again that continues from the same report
// and the ledger. docs/plans/loop-resilience.md.

import { test, expect, type Page } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, dashboard, fixtureSite, gitRepo, moreOptions, nav, open, removeTemp, run, tempDir, BIN, ROOT, TOKEN, type Dash, type Site } from './harness';

const FAKE = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'test', 'fake-agent.mjs'))} {promptFile} {resultFile}`;
const QUICK = ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage'];

// A repository holding the fixture's start page under site/ and a committed config, and the crawl the
// person just ran (a11y-508-report/report.json), as the wizard leaves it before the Fix step.
async function appWithReport(site: Site, prefix: string, config: Record<string, unknown>): Promise<{ cwd: string; g: (...a: string[]) => string; report: any }> {
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
  return { cwd, g, report: JSON.parse(readFileSync(join(cwd, 'a11y-508-report', 'report.json'), 'utf8')) };
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

test('loop-resilience: a set-up error shows "The fix loop could not start" with the remedy, and Try again runs the loop from the same report', async ({ page }) => {
  const site = await fixtureSite();
  const { cwd, g, report } = await appWithReport(site, 'a11y-508-cannot-start-', {});
  const dash: Dash = await dashboard({ cwd });
  try {
    await api(dash, '/api/settings', { method: 'PUT', body: { rounds: 1 } });
    // An edit nobody committed: the loop must not start (its commits would carry it).
    writeFileSync(join(cwd, 'site', 'index.html'), readFileSync(join(cwd, 'site', 'index.html'), 'utf8') + '\n<!-- an edit in progress -->\n');
    await open(page, dash, '/fix-loop');
    await withToken(page);
    await page.getByRole('button', { name: 'Fix the violations' }).click();

    const problem = page.getByTestId('loop-problem');
    await expect(problem.getByRole('heading', { name: 'The fix loop could not start' })).toBeVisible({ timeout: 60_000 });
    // The message and the remedy in the main view, not under Details.
    await expect(page.getByTestId('problem-message')).toHaveText('uncommitted changes under site: site/index.html');
    await expect(page.getByTestId('problem-remedy')).toHaveText(/^Commit or stash them \(git stash --include-untracked\), then try again, .*: site\/index\.html$/);
    expect(await problem.evaluate((el) => !!el.closest('details'))).toBe(false);
    await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
    // Never the words of a loop that ran.
    for (const words of ['Loop finished', 'fixed ·', 'pages found']) await expect(page.locator('body')).not.toContainText(words);

    // The person follows the remedy, then Try again: a loop from the same report, no crawl.
    g('commit', '-qam', 'finish the edit');
    const failed = (await api(dash, '/api/runs/current')).json;
    expect(failed.kind).toBe('loop');
    await page.getByRole('button', { name: 'Try again' }).click();
    // A new run, and it is a loop (never a crawl).
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.id, { timeout: 30_000 }).not.toBe(failed.id);
    const runNow = (await api(dash, '/api/runs/current')).json;
    expect(runNow.kind).toBe('loop');
    expect(runNow.meta.command).toContain('--from-report');
    // While it runs the screen is the normal running view.
    await expect(page.getByTestId('loop-problem')).toHaveCount(0);
    await expect(page.getByTestId('loop-step')).toHaveText(/Loop finished/, { timeout: 200_000 });
    const ledger = JSON.parse(readFileSync(join(cwd, 'a11y-508-work', 'ledger.json'), 'utf8'));
    expect(ledger.rounds[0].source).toBe('report');
    expect(ledger.rounds[0].reportFinishedAt).toBe(report.finishedAt);
    // No crawl ran: the report is the one the person saw, and nothing moved to history.
    expect(JSON.parse(readFileSync(join(cwd, 'a11y-508-report', 'report.json'), 'utf8')).finishedAt).toBe(report.finishedAt);
    expect(existsSync(join(cwd, 'a11y-508-history'))).toBe(false);
    expect((await api(dash, '/api/runs/current')).json.id).toBe(runNow.id);
  } finally {
    await dash.stop();
    removeTemp(cwd);
    site.close();
  }
});

test('loop-resilience: with a11y-508/fixes in the repository the Fix step and the loop use it; a loop that stops after a round says why, with its counts, Try again and Run again', async ({ page }) => {
  const site = await fixtureSite();
  // push with no remote: the round commits its fixes, then the push fails and the loop stops.
  const { cwd, g } = await appWithReport(site, 'a11y-508-stopped-', { branch: 'a11y-508', push: true });
  g('branch', 'a11y-508/fixes');
  const dash: Dash = await dashboard({ cwd });
  try {
    await api(dash, '/api/settings', { method: 'PUT', body: { rounds: 1 } });
    await open(page, dash, '/fix-loop');
    await withToken(page);
    await expect(page.getByTestId('loop-plan')).toContainText('commits to branch a11y-508/fixes');
    await page.getByRole('button', { name: 'Fix the violations' }).click();

    const problem = page.getByTestId('loop-problem');
    await expect(problem.getByRole('heading', { name: 'The fix loop stopped' })).toBeVisible({ timeout: 200_000 });
    await expect(page.getByTestId('problem-message')).toHaveText(/^push failed: /);
    // The real ledger counts.
    const ledger = JSON.parse(readFileSync(join(cwd, 'a11y-508-work', 'ledger.json'), 'utf8'));
    const n = (s: string) => Object.values<any>(ledger.findings).filter((e) => e.status === s).length;
    expect(n('pending')).toBeGreaterThan(0);
    const nh = n('needs-human');
    await expect(page.getByTestId('fix-counts')).toHaveText(`${n('verified') + n('pending')} fixed · ${n('open')} remaining${nh ? ` · ${nh} need${nh === 1 ? 's' : ''} a person` : ''}`);
    await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Run again' })).toBeEnabled();
    await expect(page.locator('body')).not.toContainText('Loop finished');
    // The round's fixes were committed on the branch the Fix step named.
    expect(g('rev-parse', '--abbrev-ref', 'HEAD')).toBe('a11y-508/fixes');
    expect(g('log', '--format=%s', 'main..a11y-508/fixes')).toMatch(/^a11y-508: /m);
  } finally {
    await dash.stop();
    removeTemp(cwd);
    site.close();
  }
});
