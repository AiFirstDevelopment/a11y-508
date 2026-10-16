// One screen (docs/plans/simple-screen.md): the loop runs from one button, says in one sentence what it
// is doing, shows one line of numbers, and one link holds the diagnostics. The fixture app is the
// fixture pages in a throwaway git repository with a bare "origin", served with a script bundle (its
// build) and the build marker the loop commits once the test "deploys" it.

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { api, asksNothing, buttonsSeen, dashboard, dirsOf, gitRepo, go, now, open, record, removeTemp, run, seen, tempDir, useToken, BIN, ROOT, TOKEN, type Dash } from './harness';

const FAKE = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'test', 'fake-agent.mjs'))} {promptFile} {resultFile}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const ARGS = ['--max-pages', '3', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage', '--concurrency', '1'];
// A check that takes long enough for the sentence to show it.
const SLOW_CHECK = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 1500)"`;

interface App {
  cwd: string;
  origin: string;
  g: (...a: string[]) => string;
  base: string;
  server: Server;
  deploy(): void;
  ledger(home?: string): any;
  close(): void;
}

async function app(prefix: string, config: Record<string, unknown> = {}): Promise<App> {
  const cwd = tempDir(prefix);
  const origin = tempDir(`${prefix}origin-`);
  expect(spawnSync('git', ['init', '-q', '--bare'], { cwd: origin }).status).toBe(0);
  const g = gitRepo(cwd);
  mkdirSync(join(cwd, 'site'), { recursive: true });
  for (const f of ['index.html', 'about.html', 'forms.html']) cpSync(join(ROOT, 'test', 'fixtures', f), join(cwd, 'site', f));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  let build = 1;
  let deployed = false;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401);
      return res.end();
    }
    let path = new URL(req.url!, 'http://x').pathname;
    if (path === '/') path = '/index.html';
    if (/^\/bundle\.\d+\.js$/.test(path)) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end('');
    }
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
    // The build marker the loop commits is served only once the fixture has "deployed".
    return res.end(readFileSync(file, 'utf8').replace(/<meta name="a11y-508-build"[^>]*>\s*/i, (m) => (deployed ? m : '')).replace('EXTERNAL_IMAGE', '/pixel.png').replace('FIXTURE_TOKEN', TOKEN).replace('</head>', `<script src="/bundle.${build}.js"></script></head>`));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/`;
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({ url: base, args: ARGS, agent: FAKE, source: ['site'], check: SLOW_CHECK, branch: 'a11y-508', push: true, maxAttempts: 5, triageBatch: 50, deployed: 'bundle-change', deployTimeout: 0, deployPoll: 1000, ...config }, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture site');
  g('remote', 'add', 'origin', origin);
  return {
    cwd, origin, g, base, server,
    deploy: () => {
      build++;
      deployed = true;
    },
    ledger: (home?: string) => JSON.parse(readFileSync(join(dirsOf(cwd, home).work, 'ledger.json'), 'utf8')),
    close: () => {
      server.closeAllConnections?.();
      server.close();
      removeTemp(origin);
    },
  };
}

// The sentence's shapes (docs/plans/simple-screen.md AC 3).
const CRAWLING = /^Crawling 127\.0\.0\.1:\d+: \d+ pages? so far, \d+ findings?$/;
const FIXING = /^Fixing .+ \(\d+ of \d+\) with the assistant, \d+ (s|min)$/;
const CHECKING = /^Checking the fix: .+setTimeout/;
const WAITING = /^Pushed \d+ fix(es)? to a11y-508; waiting for your deployment \(pushed \d{1,2}:\d\d [AP]M, checked \d{1,2}:\d\d [AP]M: still the old build\)$/;
const ARRIVED = /^Your deployment arrived: verifying \d+ fix(es)?$/;
const DONE = /^Done: \d+ fixed(, \d+ could not be fixed)?$/;

test('one screen AC1, guard d: the name and build, the folder and URL, one sentence, one button and Diagnostics, nothing else; the old routes land on it', async ({ page }) => {
  const dash = await dashboard();
  try {
    await open(page, dash, '/', { url: 'http://127.0.0.1:9/app' });
    await expect(page.locator('h1')).toHaveText(/^a11y-508/);
    await expect(page.getByTestId('build-revision')).toHaveText(/^build \S+$/);
    await expect(page.getByTestId('folder')).toHaveAttribute('title', dash.cwd);
    await expect(page.getByTestId('url')).toContainText('http://127.0.0.1:9/app');
    await expect(now(page)).toHaveText(/^Ready to crawl 127\.0\.0\.1:9; nothing will be fixed: fixing needs the app's git repository/, { timeout: 30_000 });
    await expect(go(page)).toHaveText('Start');
    await expect(page.getByTestId('diagnostics-link')).toHaveAttribute('href', '/diagnostics');
    await asksNothing(page);
    // Nothing else: none of the wizard's parts.
    for (const id of ['steps', 'where-you-are', 'tally', 'details', 'changes', 'copy-summary', 'check-now', 'picker', 'run-again', 'loop-start', 'assistant-line', 'ledger']) await expect(page.getByTestId(id), id).toHaveCount(0);
    await expect(page.locator('main a')).toHaveCount(1);
    // Guard d: every old route, and anything under it, is the one screen.
    for (const path of ['/run', '/run/advanced', '/live', '/report', '/report/latest', '/fix-loop', '/fix-loop/settings', '/history', '/troubleshoot', '/sign-in']) {
      await page.goto(`${dash.origin}${path}`);
      await expect(page, path).toHaveURL(`${dash.origin}/`);
      await expect(now(page), path).toBeVisible();
      await expect(page.locator('h1'), path).toHaveText(/^a11y-508/);
    }
  } finally {
    await dash.stop();
  }
});

test('one screen AC2, AC3, AC7, AC8, AC9, AC10, guards a b c: one Start crawls, fixes, pushes, waits for the build, verifies and finishes; the sentence follows every step; one button throughout; what could not be fixed is a link to why, where and the element', async ({ page }) => {
  test.setTimeout(600_000);
  const a = await app('a11y-508-one-');
  // Each assistant call takes a while, as a real one does, so its output can be opened while it works.
  const dash: Dash = await dashboard({ cwd: a.cwd, env: { FAKE_AGENT_DELAY_MS: '2500' } });
  try {
    // A crawl of the same URL already on record: Start still crawls first (AC 2), never fixes from it.
    expect((await api(dash, '/api/runs', { method: 'POST', body: { kind: 'crawl', url: a.base, options: { 'max-pages': '1', 'no-zoom': true }, auth: { mode: 'token', token: TOKEN } } })).status).toBe(202);
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.status, { timeout: 120_000 }).toBe('done');
    await open(page, dash);
    await useToken(page);
    await expect(now(page)).toHaveText(/^Done: crawled 1 page, \d+ findings?$/, { timeout: 60_000 });
    await expect(go(page)).toHaveText('Start');
    await record(page, ['now', 'counts']);
    await go(page).click();
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.kind, { timeout: 60_000 }).toBe('loop');
    // AC8: while it crawls, "N pages" and "M findings" are links to a panel of each page's route and findings.
    await expect(page.getByTestId('pages-link')).toBeVisible({ timeout: 120_000 });
    await page.getByTestId('findings-link').click();
    const pagesPanel = page.getByTestId('pages-panel');
    await expect(pagesPanel).toBeVisible();
    await expect(pagesPanel.getByRole('heading', { level: 2 })).toHaveText(/^\d+ pages?, \d+ findings?$/);
    await expect(pagesPanel.getByTestId('pages-route').first()).toHaveAttribute('href', new RegExp(`^${a.base.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}`));
    await expect(pagesPanel.getByTestId('pages-finding').first()).toHaveText(/^\d+\.[A-Z]+ (critical|serious|moderate|minor|to review): .+\S$/);
    await page.getByTestId('pages-close').click();
    await expect(pagesPanel).toBeHidden();
    expect((await api(dash, '/api/runs/current')).json.meta.command).not.toContain('--from-report');
    // Guard b: one click goes on past the crawl to the fixing, with no second click.
    await expect.poll(async () => (await seen(page)).some((t) => /^Fixing /.test(t)), { timeout: 240_000 }).toBe(true);
    // AC9: while the assistant works, its name in the sentence opens what it is printing.
    await page.getByTestId('output-link').click({ timeout: 60_000 });
    const out = page.getByTestId('output-panel');
    await expect(out).toBeVisible();
    await expect(out.getByTestId('output-text')).toContainText('fake agent:', { timeout: 30_000 });
    await page.getByTestId('output-close').click();
    await expect(out).toBeHidden();
    await expect(now(page)).toHaveText(WAITING, { timeout: 240_000 });
    expect(a.ledger().rounds.length).toBeGreaterThan(0);
    expect(spawnSync('git', ['rev-parse', '--verify', 'a11y-508'], { cwd: a.origin }).status, 'pushed to origin').toBe(0);
    await expect(page.getByTestId('counts')).toHaveText(/^\d+ found · \d+ awaiting your deployment( · \d+ could not be fixed)?$/);
    // The build is deployed: the loop sees it, verifies, and finishes.
    a.deploy();
    await expect(now(page)).toHaveText(DONE, { timeout: 300_000 });
    await expect(go(page)).toHaveText('Start');
    expect(Object.values<any>(a.ledger().findings).some((e) => e.status === 'verified')).toBe(true);
    // Guard c: each state was said in its own words, with its numbers.
    const texts = await seen(page);
    for (const shape of [CRAWLING, FIXING, CHECKING, WAITING, ARRIVED, DONE]) expect(texts.some((t) => shape.test(t)), `${shape}\n${texts.join('\n')}`).toBe(true);
    // Guard a: one button in every state: Stop while anything runs, Start once it is done.
    const states = await buttonsSeen(page);
    for (const st of states) expect(st.buttons, `${st.now}: ${st.buttons.join(' | ')}`).toHaveLength(1);
    for (const st of states.filter((x) => CRAWLING.test(x.now) || FIXING.test(x.now) || WAITING.test(x.now))) expect(st.buttons, st.now).toEqual(['Stop']);
    for (const st of states.filter((x) => DONE.test(x.now))) expect(st.buttons, st.now).toEqual(['Start']);
    await asksNothing(page);
    // AC7: the number that could not be fixed is a link; a panel from the right lists each one with
    // why it could not be fixed, the routes it was seen on, and the element.
    const m = /(\d+) could not be fixed/.exec((await page.getByTestId('counts').textContent()) || '');
    expect(m, 'the fake agent leaves findings it cannot fix').not.toBeNull();
    const n = Number(m![1]);
    const link = page.getByTestId('unfixed-link');
    await expect(link).toHaveText(`${n} could not be fixed`);
    await expect(page.getByTestId('unfixed-panel')).toBeHidden();
    await link.click();
    const panel = page.getByTestId('unfixed-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { level: 2 })).toHaveText(`${n} could not be fixed`);
    const items = panel.getByTestId('unfixed-item');
    await expect(items).toHaveCount(n);
    const site = new RegExp(`^${a.base.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}`);
    for (const item of await items.all()) {
      await expect(item.locator('.what')).toHaveText(/^\d+\.[A-Z]+ (critical|serious|moderate|minor|review): \S/);
      await expect(item.getByTestId('unfixed-why')).toHaveText(/^Why: \S/);
      const where = item.getByTestId('unfixed-where');
      if (await where.getByRole('link').count()) await expect(where.getByRole('link').first()).toHaveAttribute('href', site);
      else await expect(where).toHaveText(/the whole site/);
      await expect(item.getByTestId('unfixed-element')).toHaveText(/^Element: \S/);
    }
    // The fake agent says why it made no change; the panel says it in those words.
    await expect(items.filter({ hasText: 'Why: The assistant made no change' }).first()).toBeVisible();
    // Esc and Close both close it; the screen asks nothing again.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await link.click();
    await expect(panel).toBeVisible();
    await page.getByTestId('unfixed-close').click();
    await expect(panel).toBeHidden();
    await asksNothing(page);
    // AC10: Start over, at the bottom of the Log, forgets the rounds, fixes and log; the screen is a first run again.
    await expect(page.getByTestId('diagnostics-link')).toHaveText('Log');
    await page.getByTestId('diagnostics-link').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Log' })).toBeVisible();
    page.once('dialog', (d) => d.accept());
    await page.getByTestId('start-over').click();
    await expect(page).toHaveURL(`${dash.origin}/`);
    await expect(now(page)).toHaveText(/^Ready to crawl 127\.0\.0\.1:\d+ and fix what it finds\.$/, { timeout: 30_000 });
    await expect(page.getByTestId('counts')).toHaveCount(0);
    expect(existsSync(join(dirsOf(a.cwd).work, 'ledger.json'))).toBe(false);
    expect(existsSync(a.cwd), 'the app folder stays').toBe(true);
    expect(spawnSync('git', ['rev-parse', '--verify', 'a11y-508'], { cwd: a.cwd }).status, 'the commits stay').toBe(0);
  } finally {
    await api(dash, '/api/runs/current/stop', { method: 'POST' }).catch(() => {});
    await dash.stop();
    a.close();
  }
});

test('one screen AC2, guard f: Start on a folder with fixes awaiting a deployment goes on by itself: it waits for the build and verifies, with no second click', async ({ page }) => {
  test.setTimeout(600_000);
  // A loop already ran from the command line: round 1's fixes are pushed and wait for a deployment.
  const a = await app('a11y-508-one-ledger-', { deployTimeout: 1500, deployPoll: 500 });
  const home = tempDir('a11y-508-one-ledger-home-');
  try {
    const cli = await run(process.execPath, [BIN, 'loop', '--max-rounds', '1'], { cwd: a.cwd, env: { ...process.env, TOKEN, A11Y_508_HOME: home }, timeout: 280_000 });
    expect(cli.status, cli.output.slice(-3000)).toBe(4);
    const pending = Object.values<any>(a.ledger(home).findings).filter((e) => e.status === 'pending').length;
    expect(pending).toBeGreaterThan(0);
    expect(a.ledger(home).deploy?.marker).toBeTruthy();
    // From the dashboard the wait has no limit.
    const cfg = JSON.parse(readFileSync(join(a.cwd, 'a11y-508.config.json'), 'utf8'));
    writeFileSync(join(a.cwd, 'a11y-508.config.json'), JSON.stringify({ ...cfg, deployTimeout: 0 }, null, 2));
    a.g('commit', '-q', '-am', 'no limit on the wait');
    const dash: Dash = await dashboard({ cwd: a.cwd, env: { A11Y_508_HOME: home } });
    try {
      await open(page, dash);
      await useToken(page);
      await expect(now(page)).toHaveText(/^Ready to go on with 127\.0\.0\.1:\d+/, { timeout: 60_000 });
      await record(page);
      await go(page).click();
      await expect(go(page)).toHaveText('Stop', { timeout: 60_000 });
      // It waits for the build the fixes are in (fixing what is still open meanwhile), then verifies.
      await expect.poll(async () => (await seen(page)).some((t) => /^(Pushed|Committed) \d+ fix(es)? (to|on) a11y-508; waiting for your deployment/.test(t)), { timeout: 240_000 }).toBe(true);
      // A reload while it waits: the running loop is shown as such, with Stop.
      await page.reload();
      await expect(now(page)).toHaveText(/waiting for your deployment|^Fixing /, { timeout: 30_000 });
      await expect(go(page)).toHaveText('Stop');
      await record(page);
      a.deploy();
      await expect.poll(async () => (await seen(page)).some((t) => ARRIVED.test(t)), { timeout: 240_000 }).toBe(true);
      await expect(now(page)).toHaveText(DONE, { timeout: 300_000 });
      expect(Object.values<any>(a.ledger(home).findings).some((e) => e.status === 'verified')).toBe(true);
    } finally {
      await api(dash, '/api/runs/current/stop', { method: 'POST' }).catch(() => {});
      await dash.stop();
    }
  } finally {
    a.close();
  }
});

test('one screen AC6: the README\'s dashboard section describes the one screen and Diagnostics in under 200 words, and nothing that no longer exists', async () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const start = readme.indexOf('### The dashboard\n');
  const end = readme.indexOf('\n#### ', start);
  expect(start).toBeGreaterThan(0);
  const prose = readme.slice(start, end).replace(/```[\s\S]*?```/g, '');
  expect(prose.split(/\s+/).filter(Boolean).length).toBeLessThan(200);
  for (const words of ['**Start**', '**Stop**', '**Log**', '**Copy diagnostics**', '**Download diagnostics**', '**Change folder or URL**', '**Advanced**']) expect(prose, words).toContain(words);
  // Nothing of the wizard, anywhere in the README.
  for (const gone of ['wizard', 'Fix step', 'Results step', 'History', 'Where you are', 'Run again', 'Fix the violations', 'Check now', 'Copy summary', '/run/advanced', '/fix-loop/settings', 'Report screen', 'Test assistant', 'Crawl step', 'lastStep']) expect(readme, gone).not.toContain(gone);
});
