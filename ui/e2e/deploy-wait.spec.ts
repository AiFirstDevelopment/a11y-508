// Fixes waiting for a deployment someone else runs (docs/plans/deploy-wait.md, turnkey-loop.md,
// simple-screen.md): the sentence says what is going on, and the loop goes on by itself; it never
// re-crawls the old build. The fixture app is the
// fixture pages in a throwaway git repository with a bare "origin", served with a script bundle whose
// name the test changes to stand for a new build.

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { api, asksNothing, dashboard, dirsOf, gitRepo, go, now, open, record, removeTemp, runEvents, seen, tempDir, useToken, ROOT, TOKEN, type Dash } from './harness';

const FAKE = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'test', 'fake-agent.mjs'))} {promptFile} {resultFile}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// The app's pages from its working tree, each with the current build's script bundle.
// setBlocked(true): every request is sent to a sign-in page on another host, as a sign-in portal does.
async function bundleSite(cwd: string): Promise<{ base: string; host: string; server: Server; setBuild: (n: number) => void; setBlocked: (b: boolean) => void }> {
  mkdirSync(join(cwd, 'site'), { recursive: true });
  for (const f of ['index.html', 'about.html', 'forms.html']) cpSync(join(ROOT, 'test', 'fixtures', f), join(cwd, 'site', f));
  let build = 1;
  let blocked = false;
  // The build marker the loop commits is served only once the fixture has "deployed" (setBuild).
  let deployed = false;
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
    return res.end(readFileSync(file, 'utf8').replace(/<meta name="a11y-508-build"[^>]*>\s*/i, (m) => (deployed ? m : '')).replace('EXTERNAL_IMAGE', '/pixel.png').replace('FIXTURE_TOKEN', TOKEN).replace('</head>', `<script src="/bundle.${build}.js"></script></head>`));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  return { base: `http://127.0.0.1:${port}/`, host: `127.0.0.1:${port}`, server, setBuild: (n) => {
      build = n;
      deployed = true;
    }, setBlocked: (b) => (blocked = b) };
}

// docs/plans/turnkey-loop.md AC 2 / guards b, c, d, l: the wait has no limit and never ends in a
// question; the remaining findings are fixed meanwhile; a start against the old build waits too.
test('deploy-wait AC1/5/6/9, turnkey AC2 / guards b c d l: the wait says what it waits for, fixes the rest meanwhile, never ends in a question, and the old build is never re-crawled', async ({ page }) => {
  test.setTimeout(600_000);
  const cwd = tempDir('a11y-508-dw-');
  const originDir = tempDir('a11y-508-dw-origin-');
  expect(spawnSync('git', ['init', '-q', '--bare'], { cwd: originDir }).status).toBe(0);
  const g = gitRepo(cwd);
  const site = await bundleSite(cwd);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  const configFile = join(cwd, 'a11y-508.config.json');
  // deployTimeout 0: no limit, as the dashboard writes it.
  const config = {
    url: site.base, args: ['--max-pages', '3', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage', '--concurrency', '1'],
    agent: FAKE, source: ['site'], check: `${JSON.stringify(process.execPath)} -e 0`, branch: 'a11y-508', push: true, maxAttempts: 5, triageBatch: 50,
    deployed: 'bundle-change', deployTimeout: 0, deployPoll: 1000,
  };
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture site');
  g('remote', 'add', 'origin', originDir);
  const dash: Dash = await dashboard({ cwd });
  const ledger = () => JSON.parse(readFileSync(join(dirsOf(cwd).work, 'ledger.json'), 'utf8'));
  const count = (status: string) => Object.values<any>(ledger().findings).filter((e) => e.status === status).length;
  const WAITING = (n: string) => new RegExp(`^Pushed (${n}) fix(es)? to a11y-508; waiting for your deployment \\(pushed \\d{1,2}:\\d\\d [AP]M, (not checked yet|checked \\d{1,2}:\\d\\d [AP]M: still the old build)\\)$`);
  try {
    await open(page, dash);
    await useToken(page);
    await record(page, ['now']);
    await go(page).click();

    // AC 2: once fixes are committed, what it waits for, with the real branch, time and counts.
    await expect(now(page)).toHaveText(WAITING('\\d+'), { timeout: 240_000 });
    const pending = count('pending');
    expect(pending).toBeGreaterThan(0);
    expect(spawnSync('git', ['rev-parse', '--verify', 'a11y-508'], { cwd: originDir }).status, 'pushed to origin').toBe(0);
    // Guard c: the remaining findings were fixed meanwhile, from the ledger with no crawl.
    await expect.poll(() => ledger().rounds.some((r: any) => r.source === 'ledger'), { timeout: 120_000 }).toBe(true);
    await expect(now(page)).toHaveText(WAITING(String(count('pending'))), { timeout: 120_000 });
    // Guard b: the wait has no limit: seconds later it still waits, in the same run, and nothing has run out.
    const waiting = (await api(dash, '/api/runs/current')).json.id;
    await page.waitForTimeout(6000);
    await expect(now(page)).toHaveText(WAITING('\\d+'));
    const still = (await api(dash, '/api/runs/current')).json;
    expect([still.id, still.status]).toEqual([waiting, 'running']);
    const evs = await runEvents(dash);
    expect(evs.some((e) => e.type === 'deployment' || (e.type === 'done' && e.outcome === 'awaiting-deploy')), JSON.stringify(evs.filter((e) => e.type === 'deployment' || e.type === 'done'))).toBe(false);
    await expect(page.locator('body')).not.toContainText(/has not arrived|still serves the old build/);
    // Every check is on record: the sentence names the last one.
    await expect(now(page)).toHaveText(/checked \d{1,2}:\d\d [AP]M: still the old build\)$/, { timeout: 15_000 });
    expect((await runEvents(dash)).filter((e) => e.type === 'deploy-check').length).toBeGreaterThan(0);
    await expect(go(page)).toHaveText('Stop');
    await asksNothing(page);

    // Guard d: stopped while the old build is still live, the fixes go on being watched for in a run
    // of their own (no "still serves the old build", no crawl), with nothing asked of anyone.
    const rounds = ledger().rounds.length;
    const stoppedId = (await api(dash, '/api/runs/current')).json.id;
    await go(page).click();
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.id, { timeout: 30_000 }).not.toBe(stoppedId);
    await expect(now(page)).toHaveText(WAITING('\\d+'), { timeout: 120_000 });
    await asksNothing(page);
    const restarted = (await api(dash, '/api/runs/current')).json;
    expect(restarted.status).toBe('running');
    const again = await runEvents(dash);
    expect(again.some((e) => e.type === 'deployment' && e.state === 'still-old'), JSON.stringify(again.filter((e) => e.type === 'deployment'))).toBe(false);
    expect(again.some((e) => (e.type === 'step' && e.step === 'crawl') || e.type === 'page')).toBe(false);
    expect(ledger().rounds.length).toBeLessThanOrEqual(rounds + 1);
    expect(count('pending')).toBeGreaterThanOrEqual(pending);

    // A reload: the wait is shown as it is.
    await page.reload();
    await expect(now(page)).toHaveText(WAITING('\\d+'), { timeout: 30_000 });
    await expect(go(page)).toHaveText('Stop');
    await record(page, ['now']);

    // AC 5: once the new build is live, the loop sees it by itself and verifies.
    site.setBuild(2);
    await expect.poll(async () => (await seen(page)).some((t) => /^Your deployment arrived: verifying \d+ fix/.test(t)), { timeout: 60_000 }).toBe(true);
    // The loop finishes (nothing more the assistant changes).
    await expect(now(page)).toHaveText(/^Done: /, { timeout: 240_000 });
    expect(count('verified')).toBeGreaterThan(0);
  } finally {
    await dash.stop();
    site.server.close();
    removeTemp(cwd);
    removeTemp(originDir);
  }
});

// The start page cannot be read for the check (it sends every request to a sign-in page): the wait
// does not end ("could not check the site's build" never happens from the dashboard); it asks for the
// sign-in it needs, and waits.
test('deploy check, turnkey AC2/AC3: when the start page cannot be read for the check, the wait goes on and opens a sign-in instead of ending', async ({ page }) => {
  test.setTimeout(600_000);
  const cwd = tempDir('a11y-508-dw-unreach-');
  const g = gitRepo(cwd);
  const site = await bundleSite(cwd);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  const configFile = join(cwd, 'a11y-508.config.json');
  const config = {
    url: site.base, args: ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage', '--concurrency', '1'],
    agent: FAKE, source: ['site'], check: `${JSON.stringify(process.execPath)} -e 0`, branch: 'a11y-508', push: false, maxAttempts: 5, triageBatch: 50,
    deployed: 'bundle-change', deployTimeout: 0, deployPoll: 1000,
  };
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture site');
  const dash: Dash = await dashboard({ cwd });
  try {
    await open(page, dash);
    await useToken(page);
    await go(page).click();
    await expect(now(page)).toHaveText(/^Committed \d+ fix(es)? on a11y-508; waiting for your deployment \(/, { timeout: 240_000 });
    const id = (await api(dash, '/api/runs/current')).json.id;
    // The site now sends every request to its sign-in page: the check cannot read the build, and the
    // loop opens the sign-in it needs by itself and waits.
    site.setBlocked(true);
    await expect.poll(async () => (await runEvents(dash)).some((e) => e.type === 'sign-in-opening'), { timeout: 60_000 }).toBe(true);
    await expect(now(page)).toHaveText('Sign in in the tab that opened; this continues by itself', { timeout: 60_000 });
    await expect(page.getByTestId('show-sign-in-tab')).toBeVisible();
    await page.waitForTimeout(3000);
    const cur = (await api(dash, '/api/runs/current')).json;
    expect([cur.id, cur.status]).toEqual([id, 'running']);
    await expect(page.locator('body')).not.toContainText(/Could not check the site's build|could not reach the start page|has not arrived/);
    await asksNothing(page);
  } finally {
    await api(dash, '/api/runs/current/stop', { method: 'POST' }).catch(() => {});
    await dash.stop();
    site.server.close();
    removeTemp(cwd);
  }
});

// Guard g, the finished state: a loop that ends with nothing more to fix says "Now: finished".
// Guard i: the Needs-a-person screen is gone, and no screen speaks of a person deciding.
test('deploy-wait AC7, guard i: /review is an unknown route, and the dashboard and Diagnostics say nothing about a person', async ({ page }) => {
  const dash = await dashboard();
  try {
    await open(page, dash, '/review', { url: 'http://127.0.0.1:9/' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/not found/i);
    for (const path of ['/', '/diagnostics']) {
      await page.goto(`${dash.origin}${path}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('body')).not.toContainText(/need a person|needs a person|review them/i);
    }
    expect((await api(dash, '/api/review')).status).toBe(404);
    expect((await api(dash, '/api/ledger/decision', { method: 'POST', body: { fingerprint: 'x', status: 'adequate' } })).status).toBe(404);
  } finally {
    await dash.stop();
  }
});
