// Fixes waiting for a deployment someone else runs (docs/plans/deploy-wait.md): the Fix step says what
// is going on and offers the ways on; the loop never re-crawls the old build. The fixture app is the
// fixture pages in a throwaway git repository with a bare "origin", served with a script bundle whose
// name the test changes to stand for a new build.

import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { api, dashboard, dirsOf, gitRepo, moreOptions, nav, open, removeTemp, tempDir, ROOT, SECRET_HEADER, TOKEN, type Dash } from './harness';

const FAKE = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'test', 'fake-agent.mjs'))} {promptFile} {resultFile}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// The app's pages from its working tree, each with the current build's script bundle.
// setBlocked(true): every request is sent to a sign-in page on another host, as a sign-in portal does.
async function bundleSite(cwd: string): Promise<{ base: string; host: string; server: Server; setBuild: (n: number) => void; setBlocked: (b: boolean) => void }> {
  mkdirSync(join(cwd, 'site'), { recursive: true });
  for (const f of ['index.html', 'about.html', 'forms.html']) cpSync(join(ROOT, 'test', 'fixtures', f), join(cwd, 'site', f));
  let build = 1;
  let blocked = false;
  const server = createServer((req, res) => {
    if (new URL(req.url!, 'http://x').pathname === '/signin') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html lang="en"><title>Sign in</title><h1>Sign in</h1></html>');
    }
    if (blocked) {
      res.writeHead(302, { location: `http://localhost:${(server.address() as any).port}/signin` });
      return res.end();
    }
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
    return res.end(readFileSync(file, 'utf8').replace('EXTERNAL_IMAGE', '/pixel.png').replace('FIXTURE_TOKEN', TOKEN).replace('</head>', `<script src="/bundle.${build}.js"></script></head>`));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  return { base: `http://127.0.0.1:${port}/`, host: `127.0.0.1:${port}`, server, setBuild: (n) => (build = n), setBlocked: (b) => (blocked = b) };
}

async function setToken(page: Page): Promise<void> {
  await nav(page, 'Run');
  await moreOptions(page);
  await page.getByLabel('A token').check();
  await page.getByLabel(/^Token \(sent as/).fill(TOKEN);
  await nav(page, 'Fix loop');
}

// Every distinct text an element showed, recorded in the page from now on.
async function record(page: Page, testids: string[]): Promise<void> {
  await page.evaluate((ids) => {
    const w = window as any;
    w.__seen = Object.fromEntries(ids.map((id: string) => [id, [] as string[]]));
    const sample = () => {
      for (const id of ids) {
        for (const el of document.querySelectorAll(`[data-testid="${id}"]`)) {
          const t = el.textContent!.replace(/\s+/g, ' ').trim();
          const list = w.__seen[id];
          if (t && list[list.length - 1] !== t) list.push(t);
        }
      }
    };
    new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  }, testids);
}
const seen = (page: Page, id: string): Promise<string[]> => page.evaluate((i) => (window as any).__seen?.[i] || [], id);

test('deploy-wait AC1/2/5/6/8/9, guards a b c d g h: the wait says what is going on, its ways on work, and the old build is never re-crawled', async ({ page }) => {
  test.setTimeout(600_000);
  const cwd = tempDir('a11y-508-dw-');
  const originDir = tempDir('a11y-508-dw-origin-');
  expect(spawnSync('git', ['init', '-q', '--bare'], { cwd: originDir }).status).toBe(0);
  const g = gitRepo(cwd);
  const site = await bundleSite(cwd);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  const configFile = join(cwd, 'a11y-508.config.json');
  const config = {
    url: site.base, args: ['--max-pages', '3', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage', '--concurrency', '1'],
    agent: FAKE, source: ['site'], check: `${JSON.stringify(process.execPath)} -e 0`, branch: 'a11y-508', push: true, maxAttempts: 5, triageBatch: 50,
    deployed: 'bundle-change', deployTimeout: 120_000, deployPoll: 1000,
  };
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture site');
  g('remote', 'add', 'origin', originDir);
  const dash: Dash = await dashboard({ cwd });
  const ledger = () => JSON.parse(readFileSync(join(dirsOf(cwd).work, 'ledger.json'), 'utf8'));
  const count = (status: string) => Object.values<any>(ledger().findings).filter((e) => e.status === status).length;
  // The current run's events so far: the stream replays them, then stays open while the run goes on.
  const events = async (): Promise<string> => {
    const ctrl = new AbortController();
    const res = await fetch(dash.origin + '/api/runs/current/events', { headers: { [SECRET_HEADER]: dash.secret }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    let text = '';
    const stop = setTimeout(() => ctrl.abort(), 2000);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString('utf8');
      }
    } catch {}
    clearTimeout(stop);
    return text;
  };
  try {
    await open(page, dash, '/fix-loop');
    await setToken(page);
    await record(page, ['where-now-text', 'fix-status']);
    await page.getByTestId('loop-start').click();

    // AC 1: while waiting, what is going on, with the real branch, remote, host and counts.
    const wait = page.getByTestId('deploy-wait');
    await expect(wait).toBeVisible({ timeout: 240_000 });
    const pending = count('pending');
    expect(pending).toBeGreaterThan(0);
    expect(spawnSync('git', ['rev-parse', '--verify', 'a11y-508'], { cwd: originDir }).status, 'pushed to origin').toBe(0);
    await expect(page.getByTestId('deploy-wait-text')).toHaveText(new RegExp(`^Waiting for your deployment\\. ${pending} fix${pending === 1 ? ' is' : 'es are'} committed on branch a11y-508 and pushed to origin\\. The site at ${site.host.replace(/\./g, '\\.')} still serves the build from before them, so they cannot be verified yet\\. Deploy that branch — or merge it into the branch your pipeline builds — and this continues by itself; it checks every 1 s \\((\\d+ min \\d\\d s|\\d+ s|\\d+ min) left\\)\\.$`));
    await expect(wait.getByRole('button', { name: 'The site is updated — verify now' })).toBeVisible();
    const open1 = count('open');
    expect(open1).toBeGreaterThan(0);
    await expect(wait.getByRole('button', { name: `Fix the remaining ${open1} without waiting` })).toBeVisible();
    await expect(wait.getByRole('button', { name: 'Stop waiting' })).toBeVisible();
    // Guard d: the countdown ticks.
    const left1 = await page.getByTestId('deploy-left').textContent();
    await page.waitForTimeout(2500);
    expect(await page.getByTestId('deploy-left').textContent(), 'the time left changes').not.toBe(left1);
    // AC 9: what the assistant did, with only what it committed under it.
    await expect(page.getByTestId('round-headline')).toHaveText(/^Round 1: fixed \d+ findings? in 1 file, committed on branch a11y-508 and pushed to origin$/);
    await expect(page.getByTestId('changes').locator('tbody tr:not([data-outcome="committed"])')).toHaveCount(0);
    // AC 6/8, guard g: Where you are, while waiting; earlier, while the round crawled.
    await expect(page.getByTestId('where-now-text')).toHaveText(/^Now: waiting for your deployment of a11y-508 \(checks every 1 s, (\d+ min \d\d s|\d+ s|\d+ min) left\)$/);
    expect((await seen(page, 'where-now-text')).some((t) => /^Now: round 1: re-checking the site \(\d+ of \d+ pages\)$/.test(t)), (await seen(page, 'where-now-text')).join(' | ')).toBe(true);
    await expect(page.getByTestId('where-you-are')).not.toContainText(/person|handed to you/i);

    // AC 2: Stop waiting ends in the deployment's own state, not an error.
    await wait.getByRole('button', { name: 'Stop waiting' }).click();
    const notArrived = page.getByTestId('deploy-not-arrived');
    await expect(notArrived).toBeVisible({ timeout: 30_000 });
    await expect(notArrived.getByRole('heading')).toHaveText('Your deployment has not arrived yet');
    await expect(page.getByTestId('deploy-explain')).toContainText(`${pending} fix${pending === 1 ? ' is' : 'es are'} committed on branch a11y-508 and pushed to origin.`);
    for (const name of ['The site is updated — verify now', `Fix the remaining ${open1} without waiting`, 'Keep waiting', 'Start over']) await expect(notArrived.getByRole('button', { name })).toBeVisible();
    await expect(page.getByTestId('try-again')).toHaveCount(0);
    await expect(page.getByTestId('run-again')).toHaveCount(0);
    await expect(page.getByTestId('loop-problem')).toHaveCount(0);
    await expect(page.getByTestId('where-now-text')).toHaveText('Now: your deployment has not arrived yet');
    // History: the round is awaiting deployment, not a failure.
    await nav(page, 'History');
    await expect(page.getByTestId('history').locator('tr[data-id="round-1"]').getByTestId('round-state')).toHaveText('awaiting deployment');
    await nav(page, 'Fix loop');

    // Guard b: verify now with the old build still live says so at once, and crawls nothing.
    const rounds = ledger().rounds.length;
    await notArrived.getByRole('button', { name: 'The site is updated — verify now' }).click();
    await expect(page.getByTestId('still-old')).toHaveText('The site still serves the old build (checked just now); nothing was changed.', { timeout: 20_000 });
    await expect(page.getByTestId('verify-anyway')).toBeVisible();
    expect(ledger().rounds.length).toBe(rounds);
    expect(count('pending')).toBe(pending);
    const verifyEvents = await events();
    expect(verifyEvents).toContain('"state":"still-old"');
    expect(verifyEvents).not.toMatch(/"step":"crawl"|"type":"page"/);

    // Guard h: after a reload, with that later run (which committed nothing) the current one, the
    // round's line is still there: it comes from the ledger.
    await page.reload();
    await expect(page.getByTestId('where-done-text').filter({ hasText: 'Round 1:' })).toHaveText(/^Round 1: \d+ fix(es)? committed on branch a11y-508 and pushed to origin/);
    await expect(page.getByTestId('where-done-text').first()).toHaveText(/^Crawled \d+ pages on .+ — \d+ findings/);

    // The token chosen on Run is not kept across a reload (it never is): choose it again, so the
    // later rounds crawl with it rather than signing in.
    await setToken(page);
    await expect(page.getByTestId('deploy-not-arrived')).toBeVisible();
    await record(page, ['where-now-text', 'fix-status']);
    // Guard c: Fix the remaining runs from the ledger with no crawl; the waiting fixes stay pending.
    const before = (await api(dash, '/api/runs/current')).json.id;
    await page.getByTestId('deploy-not-arrived').getByRole('button', { name: /^Fix the remaining \d+ without waiting$/ }).click();
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.id, { timeout: 30_000 }).not.toBe(before);
    const cur = (await api(dash, '/api/runs/current')).json;
    expect(cur.meta.fromReport).toBe('ledger');
    // Until it waits for the deployment again, or has ended.
    await expect.poll(async () => (await events()).includes('"type":"await-deploy"') || (await api(dash, '/api/runs/current')).json?.status !== 'running', { timeout: 120_000 }).toBe(true);
    const remainingEvents = await events();
    expect(remainingEvents).toContain('"step":"ledger"');
    expect(remainingEvents).toContain('"step":"fix"');
    expect(remainingEvents).not.toMatch(/"step":"crawl"|"type":"page"/);
    expect(count('pending')).toBeGreaterThanOrEqual(pending);
    await expect(page.getByTestId('deploy-wait')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('deploy-wait').getByRole('button', { name: 'Stop waiting' }).click();
    await expect(page.getByTestId('deploy-not-arrived')).toBeVisible({ timeout: 30_000 });

    // Guard a: Keep waiting with a short time limit runs out into the same state, never an error.
    writeFileSync(configFile, JSON.stringify({ ...config, deployTimeout: 4000 }, null, 2));
    await page.getByTestId('deploy-not-arrived').getByRole('button', { name: 'Keep waiting' }).click();
    await expect(page.getByTestId('deploy-wait')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('deploy-not-arrived')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('deploy-not-arrived').getByRole('heading')).toHaveText('Your deployment has not arrived yet');
    for (const name of ['The site is updated — verify now', /^Fix the remaining \d+ without waiting$/, 'Keep waiting']) await expect(page.getByTestId('deploy-not-arrived').getByRole('button', { name })).toBeVisible();
    await expect(page.getByTestId('try-again')).toHaveCount(0);
    await expect(page.getByText('The fix loop stopped')).toHaveCount(0);

    // AC 5: once the new build is live, verify now goes straight to verifying, and says so.
    site.setBuild(2);
    const pendingNow = count('pending');
    await page.getByTestId('deploy-not-arrived').getByRole('button', { name: 'The site is updated — verify now' }).click();
    await expect(page.getByTestId('fix-status')).toHaveText(new RegExp(`^Your deployment arrived: verifying ${pendingNow} fix`), { timeout: 60_000 });
    // Guard g: the loop finishes (nothing more the assistant changes), and Now says so.
    await expect(page.getByTestId('where-now-text')).toHaveText('Now: finished', { timeout: 240_000 });
    expect(count('verified')).toBeGreaterThan(0);
    expect((await seen(page, 'where-now-text')).some((t) => /^Now: your deployment arrived — round \d+: verifying \d+ fix/.test(t)), (await seen(page, 'where-now-text')).join(' | ')).toBe(true);
  } finally {
    await dash.stop();
    site.server.close();
    removeTemp(cwd);
    removeTemp(originDir);
  }
});

// The start page cannot be checked (behind a sign-in the check could not get past): the notice says
// so plainly and offers Verify anyway, which starts a run.
test('deploy check: when the start page cannot be reached to check its build, the notice says so and Verify anyway starts a run', async ({ page }) => {
  test.setTimeout(600_000);
  const cwd = tempDir('a11y-508-dw-unreach-');
  const g = gitRepo(cwd);
  const site = await bundleSite(cwd);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  const configFile = join(cwd, 'a11y-508.config.json');
  const config = {
    url: site.base, args: ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage', '--concurrency', '1'],
    agent: FAKE, source: ['site'], check: `${JSON.stringify(process.execPath)} -e 0`, branch: 'a11y-508', push: false, maxAttempts: 5, triageBatch: 50,
    deployed: 'bundle-change', deployTimeout: 120_000, deployPoll: 1000,
  };
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture site');
  const dash: Dash = await dashboard({ cwd });
  try {
    await open(page, dash, '/fix-loop');
    await setToken(page);
    await page.getByTestId('loop-start').click();
    await expect(page.getByTestId('deploy-wait')).toBeVisible({ timeout: 240_000 });
    await page.getByTestId('deploy-wait').getByRole('button', { name: 'Stop waiting' }).click();
    const notArrived = page.getByTestId('deploy-not-arrived');
    await expect(notArrived).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('verify-anyway')).toHaveCount(0);

    // The site now sends every request to its sign-in page: the wait cannot read the build.
    site.setBlocked(true);
    writeFileSync(configFile, JSON.stringify({ ...config, deployTimeout: 5000 }, null, 2));
    await notArrived.getByRole('button', { name: 'Keep waiting' }).click();
    await expect(page.getByTestId('unreachable')).toHaveText('a11y-508 could not reach the start page to check its build (it may be behind your sign-in).', { timeout: 120_000 });
    // Whether the site still serves the old build is not known, so nothing says it does.
    await expect(notArrived.getByRole('heading')).toHaveText("Could not check the site's build");
    await expect(page.getByTestId('deploy-explain')).toHaveText(/^\d+ fix(es are| is) committed on branch a11y-508\.$/);
    await expect(notArrived).not.toContainText('still serves');
    await expect(notArrived).not.toContainText('has not arrived');
    await expect(page.getByTestId('where-now-text')).toHaveText("Now: could not check the site's build");
    for (const name of ['The site is updated — verify now', 'Keep waiting', 'Start over']) await expect(notArrived.getByRole('button', { name })).toBeVisible();
    await expect(page.getByTestId('still-old')).toHaveCount(0);
    await expect(page.getByTestId('try-again')).toHaveCount(0);

    site.setBlocked(false);
    const before = (await api(dash, '/api/runs/current')).json.id;
    await page.getByTestId('verify-anyway').click();
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.id, { timeout: 30_000 }).not.toBe(before);
    expect((await api(dash, '/api/runs/current')).json.meta.deploy).toBe('verify-anyway');
    // The run's events so far (the stream replays them, then stays open while the run goes on).
    const events = async (): Promise<string> => {
      const ctrl = new AbortController();
      const stop = setTimeout(() => ctrl.abort(), 2000);
      let text = '';
      try {
        const res = await fetch(dash.origin + '/api/runs/current/events', { headers: { [SECRET_HEADER]: dash.secret }, signal: ctrl.signal });
        const reader = res.body!.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += Buffer.from(value).toString('utf8');
        }
      } catch {}
      clearTimeout(stop);
      return text;
    };
    await expect.poll(events, { timeout: 60_000 }).toContain('"state":"verify-anyway"');
  } finally {
    await dash.stop();
    site.server.close();
    removeTemp(cwd);
  }
});

// Guard g, the finished state: a loop that ends with nothing more to fix says "Now: finished".
// Guard i: the Needs-a-person screen is gone, and no screen speaks of a person deciding.
test('deploy-wait AC7, guard i: /review is an unknown route, and the Fix step and History say nothing about a person', async ({ page }) => {
  const dash = await dashboard();
  try {
    await open(page, dash, '/review');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/not found/i);
    for (const step of ['Fix loop', 'History']) {
      await nav(page, step);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('body')).not.toContainText(/need a person|needs a person|review them/i);
    }
    expect((await api(dash, '/api/review')).status).toBe(404);
    expect((await api(dash, '/api/ledger/decision', { method: 'POST', body: { fingerprint: 'x', status: 'adequate' } })).status).toBe(404);
  } finally {
    await dash.stop();
  }
});
