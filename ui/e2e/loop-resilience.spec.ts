// The fix loop never dead-ends: it continues on the branch in the way, and when it cannot start or
// stops, the Fix step says so with the remedy and a Try again that continues from the same report
// and the ledger. docs/plans/loop-resilience.md.

import { test, expect, type Page } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, countsLine, dashboard, fixtureSite, gitRepo, moreOptions, nav, open, removeTemp, run, tempDir, BIN, ROOT, TOKEN, type Dash, type Site } from './harness';

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
    await expect(page.getByTestId('fix-counts')).toHaveText(countsLine({ verified: n('verified'), pending: n('pending'), open: n('open'), 'needs-human': n('needs-human') }));
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

test('loop-resilience AC13-18: one pane log for the run, the gate and the commit on screen with time, counts that move after each commit, one status for pane and page, the changed files and the check times', async ({ page }) => {
  const site = await fixtureSite();
  const check = `${JSON.stringify(process.execPath)} check.mjs`;
  const { cwd, g } = await appWithReport(site, 'a11y-508-pane-', { check });
  writeFileSync(join(cwd, 'check.mjs'), "import { readFileSync } from 'node:fs';\nconsole.log('building the site');\nawait new Promise((r) => setTimeout(r, 2500));\nif (readFileSync('site/index.html', 'utf8').includes('BREAK-THE-BUILD')) { console.error('error: the build is broken'); process.exit(1); }\nconsole.log('tests passed');\n");
  g('add', 'check.mjs');
  g('commit', '-qm', 'the gate');
  const dash: Dash = await dashboard({ cwd, env: { FAKE_AGENT_DELAY_MS: '800' } });
  try {
    await api(dash, '/api/settings', { method: 'PUT', body: { rounds: 1 } });
    await open(page, dash, '/fix-loop');
    await withToken(page);
    // Every rendered state of the pane and the counts, to see what the counts said when the next fix began.
    await page.evaluate(() => {
      const w = window as any;
      w.__pane = [];
      w.__status = [];
      new MutationObserver(() => {
        const pane = document.querySelector('[data-testid="agent-output"]')?.textContent || '';
        const counts = document.querySelector('[data-testid="fix-counts"]')?.textContent?.trim() || '';
        const last = w.__pane[w.__pane.length - 1];
        if (!last || last.pane !== pane || last.counts !== counts) w.__pane.push({ pane, counts });
        const st = document.querySelector('[data-testid="fix-status"]')?.textContent?.trim() || '';
        if (st && w.__status[w.__status.length - 1] !== st) w.__status.push(st);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.getByRole('button', { name: 'Fix the violations' }).click();
    const status = page.getByTestId('fix-status');
    const pane = page.getByTestId('agent-output');
    // AC 14: the gate is the status, with a counting time; its output streams into the pane.
    await expect(status).toHaveText(/^Checking fix \d+ with .+check\.mjs · \d+ s$/, { timeout: 120_000 });
    const gateSecs = async () => Number(/ · (\d+) s$/.exec((await status.textContent()) || '')?.[1] ?? -1);
    const first = await gateSecs();
    await expect.poll(gateSecs, { timeout: 5_000 }).toBeGreaterThan(first);
    // AC 17: the files the working tree shows changed, then the gate.
    await expect(pane).toContainText(/Changed: site\/index\.html\nChecking the fix with .+check\.mjs\nbuilding the site/);
    // AC 16: the pane's heading says what the status line says.
    const [h, s] = await page.evaluate(() => [document.querySelector('[data-testid="agent-heading"]')?.textContent?.trim(), document.querySelector('[data-testid="fix-status"]')?.textContent?.trim()]);
    expect(h).toBe(s);
    // AC 15: right after the first commit the counts move, while the loop goes on.
    await expect(pane).toContainText(/Build and tests passed in \d+ s\nCommitted as [0-9a-f]{7,}/, { timeout: 60_000 });
    await expect(page.getByTestId('fix-counts')).toHaveText(/^1 fixed, awaiting verification · \d+ remaining/, { timeout: 5_000 });
    await expect(page.getByTestId('loop-stop')).toBeEnabled();
    // AC 13: the next fix starts under its own heading line, and the first fix's lines are still there.
    await expect(pane).toContainText(/— Fix 2 of \d+: /, { timeout: 60_000 });
    const text = (await pane.textContent()) || '';
    expect(text.indexOf('— Fix 1 of ')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('— Fix 1 of ')).toBeLessThan(text.indexOf('— Fix 2 of '));
    expect(text.slice(text.indexOf('— Fix 1 of '), text.indexOf('— Fix 2 of '))).toContain('fake agent: looking at the finding');
    expect(text).toContain('— Review items: asking about ');
    await expect(page.getByTestId('loop-step')).toHaveText(/Loop finished/, { timeout: 200_000 });
    // AC 15: by the time the fix after the first commit began, the counts had already moved.
    const states: { pane: string; counts: string }[] = await page.evaluate(() => (window as any).__pane);
    const headings = (p: string) => (p.match(/— Fix \d+ of \d+: /g) || []).length;
    const firstCommit = states.findIndex((x) => /Committed as/.test(x.pane));
    const nextFix = states.findIndex((x, i) => i > firstCommit && headings(x.pane) > headings(states[firstCommit].pane));
    expect(firstCommit).toBeGreaterThanOrEqual(0);
    expect(nextFix).toBeGreaterThan(firstCommit);
    expect(states[nextFix].counts).toMatch(/^1 fixed, awaiting verification · \d+ remaining/);
    // The fix that broke the build: said, with the gate's own error.
    await expect(pane).toContainText(/Build or tests failed after \d+ s\nReverted — the check failed \(exit 1\):\n[^]*error: the build is broken/);
    // AC 17: Changes this run, in the main view: a row per attempt with its files and outcome.
    const changes = page.getByTestId('changes');
    expect(await changes.evaluate((el) => !!el.closest('details'))).toBe(false);
    await expect(changes.locator('tr[data-outcome="committed"]').first().getByTestId('change-files')).toHaveText('site/index.html');
    await expect(changes.locator('tr[data-outcome="committed"]').first().getByTestId('change-outcome')).toHaveText(/^\s*committed [0-9a-f]{7,}\s*$/);
    const reverted = changes.locator('tr[data-outcome="failed-gate"]');
    await expect(reverted).toHaveCount(1);
    await reverted.getByText(/^reverted: check failed \(exit 1\)$/).click();
    await expect(reverted.locator('pre')).toContainText('error: the build is broken');
    // AC 18: the gate after the first said how long the last one took.
    const said: string[] = await page.evaluate(() => (window as any).__status);
    expect(said.some((x) => /^Checking fix \d+ with .+check\.mjs · \d+ s \(the last check took \d+ s\)$/.test(x)), said.join(' | ')).toBe(true);
    await expect(pane).not.toContainText('(no output yet)');
    // History has the same list for the round.
    await page.getByRole('link', { name: 'See what changed' }).click();
    const round = page.getByTestId('round-changes').first();
    await round.locator('> summary').click();
    await expect(round.locator('tr[data-outcome="committed"]').first().getByTestId('change-files')).toHaveText('site/index.html');
  } finally {
    await dash.stop();
    removeTemp(cwd);
    site.close();
  }
});
