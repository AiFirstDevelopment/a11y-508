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

// A loop from the report the person just saw, while its assistant is slow, silent or refused: what the Fix step says.
async function fromReportLoop(page: Page, prefix: string, config: Record<string, unknown>, env: Record<string, string>, body: (dash: Dash) => Promise<void>): Promise<void> {
  const site = await fixtureSite();
  const { cwd } = await appWithReport(site, prefix, config);
  const marks = tempDir('a11y-508-fake-marks-');
  const dash: Dash = await dashboard({ cwd, env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace('MARKS', marks)])) });
  try {
    await api(dash, '/api/settings', { method: 'PUT', body: { rounds: 1 } });
    await open(page, dash, '/fix-loop');
    await withToken(page);
    await page.getByRole('button', { name: 'Fix the violations' }).click();
    await body(dash);
    await api(dash, '/api/runs/current/stop', { method: 'POST' }).catch(() => {});
    await expect(page.getByTestId('loop-step')).toHaveText(/finished|stopped/, { timeout: 120_000 });
  } finally {
    await dash.stop();
    removeTemp(cwd);
    removeTemp(marks);
    site.close();
  }
}

test('loop-resilience AC9/10: a round from the report shows no crawl, and triage reads "asking the assistant about N review items" with what review items are', async ({ page }) => {
  await fromReportLoop(page, 'a11y-508-triage-', {}, { FAKE_AGENT_SLOW_ONCE: join('MARKS', 'slow'), FAKE_AGENT_SLOW_MS: '8000' }, async () => {
    const status = page.getByTestId('fix-status');
    await expect(status).toHaveText(/^Round 1: asking the assistant about \d+ review items? from the report you just saw · \d+ s$/, { timeout: 60_000 });
    await expect(page.getByTestId('fix-hint')).toHaveText('Review items are findings the checker could not decide by itself; the assistant says which are real violations.');
    // Details is open: during this triage nothing about a crawl is there.
    await expect(page.getByTestId('loop-step')).toHaveText('Round 1: triage');
    const details = page.getByTestId('details');
    await expect(details).not.toContainText('Starting the browser');
    await expect(details.getByTestId('page-list')).toHaveCount(0);
    await expect(details.getByTestId('crawl-round')).toHaveCount(0);
    await expect(status).toHaveText(/^Round 1: asking the assistant about \d+ review items? from the report you just saw · \d+ s$/);
  });
});

test('loop-resilience AC11a/c: an assistant silent past the threshold is "still being waited on", and a call given up says so', async ({ page }) => {
  await fromReportLoop(page, 'a11y-508-quiet-', { quietAfter: 1000, agentTimeout: 4000 }, { FAKE_AGENT_SLOW_ONCE: join('MARKS', 'slow'), FAKE_AGENT_SLOW_MS: '8000', FAKE_AGENT_QUIET: '1' }, async () => {
    await expect(page.getByTestId('fix-hint')).toHaveText(/^Waiting on the assistant — no output for [1-4] s; it may take a few minutes\. The call is given up after 4 s\.$/, { timeout: 60_000 });
    await expect(page.getByTestId('agent-gave-up')).toHaveText(/^The assistant did not answer within 4 s; the \d+ review items? stays? in review and the loop goes on\.$/, { timeout: 30_000 });
  });
});

test('loop-resilience AC11b: an assistant refused for rate limit shows the countdown to its retry', async ({ page }) => {
  await fromReportLoop(page, 'a11y-508-ratelimit-', { quotaDelays: [6000] }, { FAKE_AGENT_429_ONCE: join('MARKS', 'refused') }, async () => {
    await expect(page.getByTestId('fix-status')).toHaveText(/^The assistant is rate-limited; trying again in [1-6] s \(retry 1 of 1\)$/, { timeout: 60_000 });
    // The retry answers and the loop goes on to the end.
    await expect(page.getByTestId('fix-status')).toHaveText('Loop finished.', { timeout: 60_000 });
  });
});

test('loop-resilience AC12: the assistant\'s streamed actions reach the pane as readable lines while it works', async ({ page }) => {
  await fromReportLoop(page, 'a11y-508-stream-', {}, { FAKE_AGENT_STREAM_ONCE: join('MARKS', 'streamed'), FAKE_AGENT_STREAM_MS: '2500' }, async () => {
    const last = page.getByTestId('agent-last-line');
    const status = page.getByTestId('fix-status');
    // The first action is on screen while the call still runs, and the last line moves on with it.
    await expect(last).toHaveText('Reading site/index.html', { timeout: 60_000 });
    await expect(status).toHaveText(/^Round 1: asking the assistant about /);
    await expect(last).toHaveText('Looking at the finding.', { timeout: 10_000 });
    await expect(last).toHaveText('Running npm run build', { timeout: 10_000 });
    await expect(status).toHaveText(/^Round 1: asking the assistant about /);
    await expect(page.getByTestId('agent-output')).not.toContainText('{"type"');
    await expect(page.getByTestId('agent-output')).toContainText('Started (fake-model)\nReading site/index.html\nLooking at the finding.\nRunning npm run build');
  });
});
