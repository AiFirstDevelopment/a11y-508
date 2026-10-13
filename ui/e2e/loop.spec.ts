// The fix loop from the dashboard: the config form, a dry run, and a real
// round with the fake agent in a throwaway git repository.

import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { moreOptions, loopOptions, dryRun, dashboard, gitRepo, open, tempDir, BIN, ROOT, TOKEN, type Dash } from './harness';

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
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Run', exact: true }).click();
  await moreOptions(page);
  await page.getByLabel('A token').check();
  await page.getByLabel(/^Token \(sent as/).fill(TOKEN);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Fix loop' }).click();
}

test('AC 11: the settings under More options save a config a11y-508 loop accepts, and rejects what the core rejects with its message', async ({ page }) => {
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
    await expect.poll(() => JSON.parse(readFileSync(join(dash.cwd, 'a11y-508.config.json'), 'utf8')).push).toBe(false);
    const written = JSON.parse(readFileSync(join(dash.cwd, 'a11y-508.config.json'), 'utf8'));
    // What was set, with the inferred branch, and the deployment watched silently (it happens outside this tool).
    expect(written).toEqual({ url: 'http://127.0.0.1:9/', args: ['--max-pages', '1'], source: ['site'], check: 'npm test', branch: 'a11y-508', maxAttempts: 2, push: false, deployed: 'bundle-change', deployTimeout: 1800000 });
    // No deploy settings on the screen at all.
    await expect(page.getByLabel('How the loop knows the new build is live')).toHaveCount(0);
    await expect(page.getByLabel('Deploy command')).toHaveCount(0);

    // a11y-508 loop accepts it: with an agent it passes validation and gets as far as the git check.
    writeFileSync(join(dash.cwd, 'a11y-508.config.json'), JSON.stringify({ ...written, agent: 'claude' }));
    const r = spawnSync(process.execPath, [BIN, 'loop', '--max-rounds', '1'], { cwd: dash.cwd, encoding: 'utf8', env: { ...process.env, TOKEN: '' } });
    expect(r.stdout + r.stderr).toContain('is not a git repository');
    expect(r.stdout + r.stderr).not.toMatch(/no start URL|no agent|deploy" command|must be command/);
  } finally {
    await dash.stop();
  }
});

test('AC 14: dry run fills the ledger; Start runs a round that commits, with live progress, fix n of m, and Deployed — continue', async ({ page }) => {
  const cwd = tempDir('a11y-508-loop-');
  const g = gitRepo(cwd);
  const { base, server } = await repoSite(cwd);
  writeFileSync(join(cwd, '.gitignore'), 'a11y-508-work/\na11y-508-report/\na11y-508-history/\n');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({
    url: base,
    args: ['--max-pages', '3', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage', '--concurrency', '1'],
    agent: FAKE, source: ['site'], check: `${JSON.stringify(process.execPath)} -e 0`, push: false, deployed: 'enter', triageBatch: 50,
  }, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture site');
  const head = g('rev-parse', 'HEAD');
  // The first assistant call takes a few seconds, so the live output pane's counter visibly runs.
  const slow = join(tempDir('a11y-508-slow-'), 'slow-once');
  const dash: Dash = await dashboard({ cwd, env: { FAKE_AGENT_SLOW_ONCE: slow } });
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
        };
        const last = w.__loop[w.__loop.length - 1];
        if (!last || JSON.stringify(last) !== JSON.stringify(s)) w.__loop.push(s);
      };
      new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    await page.getByTestId('loop-start').click();
    // The assistant's output, live: its lines in the pane while it runs, and a counter that moves.
    const heading = page.getByTestId('agent-heading');
    await expect(heading).toHaveText(/running \d+ s$/, { timeout: 200_000 });
    await expect(page.getByTestId('agent-output')).toContainText('fake agent: reading the prompt');
    const secs = async () => Number(/running (\d+) s$/.exec((await heading.textContent()) || '')?.[1] ?? -1);
    const first = await secs();
    await expect.poll(secs, { timeout: 10_000 }).toBeGreaterThan(first);
    await expect(page.getByTestId('agent-output')).toHaveAttribute('role', 'log');
    const cont = page.getByRole('button', { name: 'Deployed — continue' });
    await expect(cont).toBeVisible({ timeout: 200_000 });
    expect(g('log', '--format=%s', `${head}..HEAD`)).toMatch(/^a11y-508: /m);
    await cont.click();
    await expect(page.getByTestId('loop-step')).toHaveText(/^Round 3/, { timeout: 60_000 });
    // Round 3 may commit too and wait again; continue until the loop ends.
    const step = page.getByTestId('loop-step');
    await expect(async () => {
      if (await cont.isVisible()) await cont.click();
      await expect(step).toHaveText(/Loop finished/, { timeout: 2_000 });
    }).toPass({ timeout: 200_000 });

    const samples: any[] = await page.evaluate(() => (window as any).__loop);
    // The round's crawl moved page by page, as a plain crawl does.
    const crawling = samples.filter((s) => s.value !== null && /pages found/.test(s.label) && !s.label.startsWith('Finished'));
    expect(crawling.length).toBeGreaterThan(1);
    for (const s of crawling) expect(s.value, JSON.stringify(s)).toBe(s.rows);
    expect(new Set(crawling.map((s) => s.value)).size).toBeGreaterThan(1);
    // During the fixes a bar read "fix n of m".
    const fixes = [...new Set(samples.map((s) => s.fix).filter(Boolean))];
    expect(fixes.some((f) => /^fix [1-9]\d* of [1-9]\d*$/.test(f))).toBe(true);
    expect(samples.some((s) => /^Round 2: waiting for deploy$/.test(s.step))).toBe(true);

    // The board equals `a11y-508 status`, and the round chart equals the ledger's rounds.
    const st = spawnSync(process.execPath, [BIN, 'status'], { cwd, encoding: 'utf8' }).stdout;
    const line = st.split('\n')[0].replace(/^a11y-508 loop status: \d+ round\(s\)\. /, '');
    await expect(page.getByTestId('ledger-line')).toHaveText(line);
    const ledger = JSON.parse(readFileSync(join(cwd, 'a11y-508-work', 'ledger.json'), 'utf8'));
    const counts: Record<string, number> = {};
    for (const e of Object.values<any>(ledger.findings)) counts[e.status] = (counts[e.status] || 0) + 1;
    for (const s of ['open', 'review', 'pending', 'verified', 'needs-human', 'adequate', 'gone']) {
      await expect(page.getByTestId('ledger-counts').locator(`[data-status="${s}"] dd`)).toHaveText(String(counts[s] || 0));
    }
    for (const [title, status] of [['OPEN', 'open'], ['PENDING VERIFICATION', 'pending'], ['NEEDS A PERSON', 'needs-human']]) {
      const m = new RegExp(`^${title} \\((\\d+)\\)`, 'm').exec(st);
      await expect(page.locator(`[data-list="${status}"] li`)).toHaveCount(m ? Number(m[1]) : 0);
    }
    const panel = page.locator('app-chart-panel#rounds');
    await panel.getByRole('button', { name: /Show data table/ }).click();
    await expect(panel.locator('table tbody tr')).toHaveCount(ledger.rounds.length);
    const rows = await panel.locator('table tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent!.trim())));
    let verified = 0;
    expect(rows.map((r) => r.slice(0, 3).map(Number))).toEqual(ledger.rounds.map((r: any) => [r.round, r.violations, (verified += r.diff.verified)]));
    // Each round's time, in the viewer's local time.
    const local = await page.evaluate((ats: string[]) => ats.map((a) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(a))), ledger.rounds.map((r: any) => r.at));
    expect(rows.map((r) => r[3])).toEqual(local);
  } finally {
    await dash.stop();
    server.close();
  }
});
