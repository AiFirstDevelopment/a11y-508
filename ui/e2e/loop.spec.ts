// The fix loop from the dashboard: the config form, a dry run, and a real
// round with the fake agent in a throwaway git repository.

import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { moreOptions, loopOptions, dryRun, dashboard, dirsOf, fillRun, gitRepo, open, startFromRun, tempDir, waitFinished, BIN, ROOT, TOKEN, type Dash, nav, api, countsLine } from './harness';

const FAKE = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'test', 'fake-agent.mjs'))} {promptFile} {resultFile}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// The fixture pages, copied into a git repository and served from there, so a
// committed fix is live at once.
async function repoSite(cwd: string): Promise<{ base: string; server: Server }> {
  mkdirSync(join(cwd, 'site'), { recursive: true });
  for (const f of ['index.html', 'about.html', 'forms.html']) cpSync(join(ROOT, 'test', 'fixtures', f), join(cwd, 'site', f));
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401);
      return res.end();
    }
    let path = new URL(req.url!, 'http://x').pathname;
    if (path === '/') path = '/index.html';
    if (path.startsWith('/img/') || path === '/pixel.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    const file = join(cwd, 'site', path);
    if (extname(path) !== '.html' || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<!doctype html><html lang="en"><title>Not found</title><h1>404</h1></html>');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(file, 'utf8').replace('EXTERNAL_IMAGE', '/pixel.png').replace('FIXTURE_TOKEN', TOKEN));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as any).port}/`, server };
}

async function setToken(page: Page): Promise<void> {
  await nav(page, 'Run');
  await moreOptions(page);
  await page.getByLabel('A token').check();
  await page.getByLabel(/^Token \(sent as/).fill(TOKEN);
  await nav(page, 'Fix loop');
}

test('AC 11: the settings at /fix-loop/settings save a config a11y-508 loop accepts, and rejects what the core rejects with its message', async ({ page }) => {
  const dash = await dashboard();
  try {
    await open(page, dash, '/fix-loop');
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

test('AC 14: dry run fills the ledger; Start runs a round that commits, with live progress, fix n of m, and goes on to the next round by itself', async ({ page }) => {
  const cwd = tempDir('a11y-508-loop-');
  const g = gitRepo(cwd);
  const { base, server } = await repoSite(cwd);
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({
    url: base,
    args: ['--max-pages', '3', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage', '--concurrency', '1'],
    agent: FAKE, source: ['site'], check: `${JSON.stringify(process.execPath)} -e "setTimeout(Boolean,1500)"`, push: false, deployed: 'enter', triageBatch: 50,
  }, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture site');
  const head = g('rev-parse', 'HEAD');
  // The first assistant call takes a few seconds, so the live output pane's counter visibly runs.
  const slow = join(tempDir('a11y-508-slow-'), 'slow-once');
  const dash: Dash = await dashboard({ cwd, env: { FAKE_AGENT_SLOW_ONCE: slow, FAKE_AGENT_QUIET: '1' } });
  try {
    await open(page, dash, '/fix-loop');
    await setToken(page);
    await dryRun(page);
    await expect(page.getByTestId('loop-step')).toHaveText(/Dry run finished/, { timeout: 200_000 });
    await expect(page.getByTestId('ledger-counts').locator('[data-status="open"] dd')).not.toHaveText('0');
    await expect(page.locator('[data-list="open"] li').first()).toBeVisible();

    // Record every rendered state of both bars and the page list during the real run.
    await page.evaluate(() => {
      const w = window as any;
      w.__loop = [];
      const sample = () => {
        const bar = document.getElementById('crawl-progress') as HTMLProgressElement | null;
        const fix = document.getElementById('fix-progress-label')?.textContent?.trim() || null;
        const s = {
          value: bar && bar.hasAttribute('value') ? bar.value : null,
          label: document.getElementById('crawl-progress-label')?.textContent?.trim() || '',
          rows: document.querySelectorAll('[data-testid="page-list"] tbody tr[data-url]').length,
          fix,
          step: document.querySelector('[data-testid="loop-step"]')?.textContent?.trim() || '',
          status: document.querySelector('[data-testid="fix-status"]')?.textContent?.trim() || '',
          heading: document.querySelector('[data-testid="agent-heading"]')?.textContent?.trim() || '',
          output: document.querySelector('[data-testid="agent-output"]')?.textContent?.trim() || '',
        };
        const last = w.__loop[w.__loop.length - 1];
        if (!last || JSON.stringify(last) !== JSON.stringify(s)) w.__loop.push(s);
      };
      new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    // Before the first round, what a round does.
    await expect(page.getByTestId('loop-explainer')).toHaveText('Each round re-checks the site, fixes what is open one finding at a time, gates every fix with your build, commits, and waits for the new build before checking again.');
    await page.getByTestId('loop-start').click();
    await expect(page.getByTestId('loop-explainer')).toBeHidden({ timeout: 60_000 });
    // The assistant's output, live: its lines in the pane while it runs, and a counter that moves.
    const heading = page.getByTestId('agent-heading');
    await expect(heading).toHaveText(/ · \d+ s$/, { timeout: 200_000 });
    const secs = async () => Number(/ · (\d+) s$/.exec((await heading.textContent()) || '')?.[1] ?? -1);
    const first = await secs();
    await expect.poll(secs, { timeout: 10_000 }).toBeGreaterThan(first);
    await expect(page.getByTestId('agent-output')).toContainText('fake agent: reading the prompt');
    await expect(page.getByTestId('agent-output')).toHaveAttribute('role', 'log');
    // "deployed": "enter" asks for an Enter in a terminal; from the dashboard nobody is asked: the
    // loop goes on to round 3 by itself (docs/plans/turnkey-loop.md AC 1), and on to its end.
    await expect(page.getByTestId('loop-step')).toHaveText(/^Round 3/, { timeout: 200_000 });
    expect(g('log', '--format=%s', `${head}..HEAD`)).toMatch(/^a11y-508: /m);
    await expect(page.getByTestId('loop-step')).toHaveText(/Loop finished/, { timeout: 200_000 });
    await expect(page.getByRole('button', { name: 'Deployed — continue' })).toHaveCount(0);

    const samples: any[] = await page.evaluate(() => (window as any).__loop);
    // The round's crawl moved page by page, as a plain crawl does.
    const crawling = samples.filter((s) => s.value !== null && /pages found/.test(s.label) && !s.label.startsWith('Finished'));
    expect(crawling.length).toBeGreaterThan(1);
    for (const s of crawling) expect(s.value, JSON.stringify(s)).toBe(s.rows);
    expect(new Set(crawling.map((s) => s.value)).size).toBeGreaterThan(1);
    // During the fixes a bar read "fix n of m".
    const fixes = [...new Set(samples.map((s) => s.fix).filter(Boolean))];
    expect(fixes.some((f) => /^fix [1-9]\d* of [1-9]\d*$/.test(f))).toBe(true);
    // The status line explains itself at each stage. (The dry run was round 1; this run starts at 2.)
    const said = (re: RegExp) => expect(samples.some((s) => re.test(s.status)), `${re}: ${[...new Set(samples.map((s) => s.status))].join(' | ')}`).toBe(true);
    said(/^Round 2: re-checking the site first \(\d+ of \d+ pages\) so fixes can be verified against it$/);
    said(/^Round 2: asking the assistant about \d+ review items · \d+ s$/);
    said(/^Round 2: fixing \d+ of \d+ · \d+\.[A-Z] .+ · \d+ s$/);
    said(/^Checking fix \d+ with .+ -e "setTimeout\(Boolean,1500\)" · \d+ s( \(the last check took \d+ s\))?$/);
    said(/^Round 3: re-checking the site \(\d+ of \d+ pages\)$/);
    // The triage call prints nothing until it ends: the pane, its heading line and its timer are there from its start.
    expect(samples.some((s) => /^Round 2: asking the assistant about/.test(s.status) && s.heading === s.status && /— Review items: asking about \d+ review items? —$/.test(s.output)), 'the pane runs before the first output').toBe(true);

    // The board equals `a11y-508 status`, and the round chart equals the ledger's rounds.
    const st = spawnSync(process.execPath, [BIN, 'status'], { cwd, encoding: 'utf8', env: { ...process.env, A11Y_508_HOME: dash.home } }).stdout;
    const line = st.split('\n')[0].replace(/^a11y-508 loop status: \d+ round\(s\)\. /, '');
    await expect(page.getByTestId('ledger-line')).toHaveText(line);
    const ledger = JSON.parse(readFileSync(join(dirsOf(cwd).work, 'ledger.json'), 'utf8'));
    const counts: Record<string, number> = {};
    for (const e of Object.values<any>(ledger.findings)) counts[e.status] = (counts[e.status] || 0) + 1;
    for (const s of ['open', 'review', 'pending', 'verified', 'adequate', 'gone']) {
      await expect(page.getByTestId('ledger-counts').locator(`[data-status="${s}"] dd`)).toHaveText(String(counts[s] || 0));
    }
    for (const [title, status] of [['OPEN', 'open'], ['FIXED, AWAITING VERIFICATION', 'pending']]) {
      const m = new RegExp(`^${title} \\((\\d+)\\)`, 'm').exec(st);
      await expect(page.locator(`[data-list="${status}"] li`)).toHaveCount(m ? Number(m[1]) : 0);
    }
    // What the assistant could not fix is not shown at all (docs/plans/deploy-wait.md criterion 7).
    await expect(page.locator('[data-list="skipped"], [data-status="skipped"]')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/need a person|needs a person/i);
    const panel = page.locator('app-chart-panel#rounds');
    await panel.getByRole('button', { name: /Show data table/ }).click();
    await expect(panel.locator('table tbody tr')).toHaveCount(ledger.rounds.length);
    const rows = await panel.locator('table tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent!.trim())));
    let verified = 0;
    expect(rows.map((r) => r.slice(0, 3).map(Number))).toEqual(ledger.rounds.map((r: any) => [r.round, r.violations, (verified += r.diff.verified)]));
    // Each round's time, in the viewer's local time.
    const local = await page.evaluate((ats: string[]) => ats.map((a) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(a))), ledger.rounds.map((r: any) => r.at));
    expect(rows.map((r) => r[3])).toEqual(local);

    // The loop has ended with nothing it can still fix: Run again is the one button; See what changed is a link.
    await expect(page.getByRole('link', { name: 'See what changed' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run again' })).toBeEnabled();
    await expect(page.getByTestId('fix-status')).toHaveText(/^Done: /);

    // History: one timeline; the last round's row matches `a11y-508 status` (found and fixed from its
    // round line, remaining from the open count), and the summary line above it.
    await nav(page, 'History');
    const last = ledger.rounds[ledger.rounds.length - 1];
    const statusRound = new RegExp(`round ${last.round} [^\n]*: \\d+/\\d+ pages audited, (\\d+) violations, \\d+ review; \\+\\d+ new, (\\d+) verified`).exec(st)!;
    const lastRow = page.getByTestId('history').locator(`tr[data-id="round-${last.round}"]`);
    await expect(lastRow.locator('th').getByRole('link')).toHaveText(`Fix round ${last.round}`);
    await expect(lastRow.getByTestId('found')).toHaveText(statusRound[1]);
    // Fixed: the findings the round's commits covered (docs/plans/deploy-wait.md criterion 9).
    void statusRound[2];
    const committedInLast = Object.values<any>(ledger.findings).filter((e) => e.attempts.some((a: any) => a.round === last.round && a.commit)).length;
    await expect(lastRow.getByTestId('fixed')).toHaveText(String(committedInLast));
    await expect(lastRow.getByTestId('remaining').locator('span').first()).toHaveText(String(counts.open || 0));
    await expect(page.getByTestId('history').locator('tr[data-source="round"]')).toHaveCount(ledger.rounds.length);
    await expect(page.getByTestId('loop-summary')).toHaveText(`Fix loop: ${ledger.rounds.length} rounds · ${(counts.verified || 0) + (counts.open || 0) + (counts.pending || 0)} violations · ${countsLine(counts)}`);
    // The tally: the whole run in one line, on History as on the Fix step.
    await expect(page.getByTestId('tally')).toHaveText(new RegExp(`^${ledger.rounds.length} rounds in .+ · ${Object.keys(ledger.findings).length} found · ${counts.verified || 0} verified fixed`));
    // Nothing on History deletes the loop's rounds (docs/plans/turnkey-loop.md AC 7).
    await expect(page.getByRole('button', { name: 'Clear fix-loop history' })).toHaveCount(0);
    expect(existsSync(join(dirsOf(cwd).work, 'ledger.json'))).toBe(true);

    // Run again: a new crawl from the same set up; the wizard is back on Crawl, and Results, Fix
    // and History are not available until it finishes.
    await page.getByRole('button', { name: 'Run again' }).click();
    await expect(page).toHaveURL(/\/live$/);
    const steps = page.getByRole('navigation', { name: 'Steps' });
    await expect(steps.getByRole('link', { name: /^Crawl/ })).toHaveAttribute('aria-current', 'step');
    for (const s of ['Results', 'Fix', 'History']) await expect(steps.locator(`[aria-disabled="true"][data-step="${s}"]`)).toHaveCount(1);
    expect((await api(dash, '/api/runs/current')).json.kind).toBe('crawl');
    await api(dash, '/api/runs/current/stop', { method: 'POST' });
    await expect(page.getByTestId('crawl-status')).toHaveText('Stopped', { timeout: 30_000 });
  } finally {
    await dash.stop();
    server.close();
  }
});

test('from the report: after a wizard crawl, Fix the violations starts with triage and fixes, not a second crawl', async ({ page }) => {
  const cwd = tempDir('a11y-508-fromrep-');
  const g = gitRepo(cwd);
  const { base, server } = await repoSite(cwd);
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({
    url: base,
    args: ['--max-pages', '3', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage', '--concurrency', '1'],
    agent: FAKE, source: ['site'], check: `${JSON.stringify(process.execPath)} -e 0`, push: false, deployed: 'none', triageBatch: 50,
  }, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture site');
  const dash: Dash = await dashboard({ cwd });
  try {
    await open(page, dash, '/run');
    await fillRun(page, { url: base, token: TOKEN, maxPages: 3, advanced: { 'no-zoom': true } });
    await startFromRun(page);
    await waitFinished(page);
    await nav(page, 'Fix loop');
    await page.evaluate(() => {
      const w = window as any;
      w.__status = [];
      new MutationObserver(() => {
        const t = document.querySelector('[data-testid="fix-status"]')?.textContent?.trim() || '';
        if (t && w.__status[w.__status.length - 1] !== t) w.__status.push(t);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.getByRole('button', { name: 'Fix the violations' }).click();
    await expect(page.getByTestId('loop-step')).toHaveText(/Loop finished/, { timeout: 200_000 });
    const said: string[] = await page.evaluate(() => (window as any).__status);
    expect(said.filter((s) => /^Round 1: re-checking/.test(s)), said.join(' | ')).toEqual([]);
    expect(said.some((s) => /^Round 1: (asking the assistant about .+|fixing \d+ of \d+) from the report you just saw · /.test(s)), said.join(' | ')).toBe(true);
    expect((await api(dash, '/api/runs/current')).json.meta.command).toContain('--from-report');
    const ledger = JSON.parse(readFileSync(join(dirsOf(cwd).work, 'ledger.json'), 'utf8'));
    expect(ledger.rounds[0].source).toBe('report');
    expect(existsSync(join(dirsOf(cwd).work, 'round-1', 'crawl.log'))).toBe(false);
    // History has the round, as a row of its own.
    await page.getByRole('link', { name: 'See what changed' }).click();
    await expect(page.getByTestId('history').locator('tr[data-id="round-1"]')).toHaveCount(1);
  } finally {
    await dash.stop();
    server.close();
  }
});

test('tool-files AC5/guard 5: while a loop runs with grouped findings, the counts say how many fixes the round has; with none running, they do not', async ({ page }) => {
  const cwd = tempDir('a11y-508-grouped-');
  const g = gitRepo(cwd);
  const { base, server } = await repoSite(cwd);
  // Five images with the same problem (one fix task) and one page-level problem (no lang): 6 remaining, 2 fixes.
  writeFileSync(join(cwd, 'site', 'index.html'), '<!doctype html><html><head><title>Five images</title></head><body><main><h1>Five images</h1>' + ['a', 'b', 'c', 'd', 'e'].map((n) => `<img src="/img/${n}.png" width="20" height="20">`).join('') + '</main></body></html>\n');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({
    url: base, args: ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage'],
    agent: FAKE, source: ['site'], check: `${JSON.stringify(process.execPath)} -e "setTimeout(Boolean,1500)"`, push: false, deployed: 'none', triageBatch: 50,
  }, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'five images');
  const dash: Dash = await dashboard({ cwd, env: { FAKE_AGENT_DELAY_MS: '1500' } });
  try {
    await open(page, dash, '/fix-loop');
    await setToken(page);
    await page.getByTestId('loop-start').click();
    const status = page.getByTestId('fix-status');
    await expect(status).toHaveText(/^Round 1: fixing \d+ of \d+/, { timeout: 200_000 });
    const of = Number(/ of (\d+)/.exec((await status.textContent()) || '')![1]);
    const counts = page.getByTestId('fix-counts');
    await expect(counts).toHaveText(new RegExp(`^(0 fixed|\\d+ fixed, awaiting verification) · \\d+ remaining, in ${of} fix${of === 1 ? '' : 'es'} this round`));
    const remaining = Number(/(\d+) remaining/.exec((await counts.textContent()) || '')![1]);
    const ledger = JSON.parse(readFileSync(join(dirsOf(cwd).work, 'ledger.json'), 'utf8'));
    const openNow = Object.values<any>(ledger.findings).filter((e) => e.status === 'open').length;
    expect(of, 'the round has fewer fixes than findings (grouped)').toBeLessThan(openNow + Object.values<any>(ledger.findings).filter((e) => e.status === 'pending').length);
    expect(remaining).toBeGreaterThan(0);
    await expect(page.getByTestId('loop-step')).toHaveText(/Loop finished/, { timeout: 200_000 });
    await expect(counts).not.toContainText('this round');
  } finally {
    await dash.stop();
    server.close();
  }
});
