// Fixes waiting for a deployment someone else runs (docs/plans/deploy-wait.md, turnkey-loop.md): the
// Fix step says what is going on, and the loop goes on by itself; it never re-crawls the old build. The fixture app is the
// fixture pages in a throwaway git repository with a bare "origin", served with a script bundle whose
// name the test changes to stand for a new build.

import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { api, asksNothing, dashboard, dirsOf, gitRepo, moreOptions, nav, open, removeTemp, runEvents, tempDir, ROOT, TOKEN, type Dash } from './harness';

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
  const WAITING = (n: string) => new RegExp(`^Waiting for your deployment of branch a11y-508 \\(pushed to origin at \\d{1,2}:\\d\\d [AP]M\\)\\. The site is checked every 1 s, and the (fix is|${n} fixes are) verified as soon as the new build is live\\.$`);
  try {
    await open(page, dash, '/fix-loop');
    await setToken(page);
    await record(page, ['where-now-text', 'where-next-text', 'fix-status', 'deploy-wait-next']);
    await page.getByTestId('loop-start').click();

    // AC 2: once fixes are committed, what the step waits for, with the real branch, remote, time and counts.
    const status = page.getByTestId('fix-status');
    await expect(status).toHaveText(WAITING('\\d+'), { timeout: 240_000 });
    const pending = count('pending');
    expect(pending).toBeGreaterThan(0);
    expect(spawnSync('git', ['rev-parse', '--verify', 'a11y-508'], { cwd: originDir }).status, 'pushed to origin').toBe(0);
    await expect(status).toHaveText(WAITING(String(pending)));
    // Guard c: the remaining findings were fixed meanwhile, from the ledger with no crawl, and the step said so.
    await expect(page.getByTestId('deploy-wait-next')).toHaveText(/^(Nothing else is left to fix\.|The \d+ remaining findings? (is|are) tried again once the new build is checked\.)$/, { timeout: 120_000 });
    expect((await seen(page, 'deploy-wait-next')).some((t) => /^Fixing the \d+ remaining findings? meanwhile\.$/.test(t)), (await seen(page, 'deploy-wait-next')).join(' | ')).toBe(true);
    expect(ledger().rounds.some((r: any) => r.source === 'ledger'), JSON.stringify(ledger().rounds.map((r: any) => r.source))).toBe(true);
    // Guard b: the wait has no limit: seconds later it still waits, in the same run, and nothing has run out.
    const waiting = (await api(dash, '/api/runs/current')).json.id;
    await page.waitForTimeout(6000);
    await expect(status).toHaveText(WAITING(String(pending)));
    const still = (await api(dash, '/api/runs/current')).json;
    expect([still.id, still.status]).toEqual([waiting, 'running']);
    const evs = await runEvents(dash);
    expect(evs.some((e) => e.type === 'deployment' || (e.type === 'done' && e.outcome === 'awaiting-deploy')), JSON.stringify(evs.filter((e) => e.type === 'deployment' || e.type === 'done'))).toBe(false);
    await expect(page.locator('body')).not.toContainText(/has not arrived|still serves the old build/);
    // Stop, and Check now: every check is on record (when, and what the site served), and Check now
    // has the site checked at once.
    await expect(page.getByTestId('loop-stop')).toBeVisible();
    await asksNothing(page);
    const check = page.getByTestId('deploy-check');
    await expect(check).toHaveText(/^Checked at \d{1,2}:\d\d:\d\d [AP]M: still the build from before the fixes\.$/, { timeout: 15_000 });
    const checksBefore = (await runEvents(dash)).filter((e) => e.type === 'deploy-check').length;
    expect(checksBefore).toBeGreaterThan(0);
    await expect(page.getByTestId('sign-in-now')).toHaveText('Sign in');
    await page.getByTestId('check-now').click();
    await expect.poll(async () => (await runEvents(dash)).filter((e) => e.type === 'deploy-check' && e.forced === true).length, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(check).toHaveText(/^Checked at \d{1,2}:\d\d:\d\d [AP]M: still the build from before the fixes\.$/);
    await expect(page.getByTestId('check-error')).toHaveCount(0);
    // Sign in: the word reaches the loop, which opens the sign-in and says so; nothing is swallowed.
    await page.getByTestId('sign-in-now').click();
    await expect.poll(async () => (await runEvents(dash)).some((e) => e.type === 'info' && /sign-in asked for: opening a (window|tab)/.test(String(e.message || ''))), { timeout: 30_000 }).toBe(true);
    await expect(page.getByTestId('check-error')).toHaveCount(0);
    // AC 9: what the assistant did, with only what it committed under it.
    await expect(page.getByTestId('round-headline')).toHaveText(/^Round 1: fixed \d+ findings? in 1 file, committed on branch a11y-508 and pushed to origin$/);
    await expect(page.getByTestId('changes').locator('tbody tr:not([data-outcome="committed"])')).toHaveCount(0);
    // AC 6/8, guard l: Where you are says what the tool does, never what the person may choose.
    await expect(page.getByTestId('where-now-text')).toHaveText('Now: waiting for your deployment of a11y-508 (checks every 1 s)');
    expect((await seen(page, 'where-now-text')).some((t) => /^Now: round 1: re-checking the site \(\d+ of \d+ pages\)$/.test(t)), (await seen(page, 'where-now-text')).join(' | ')).toBe(true);
    expect((await seen(page, 'where-now-text')).some((t) => /^Now: fixing the \d+ remaining while your deployment of a11y-508 is awaited$/.test(t)), (await seen(page, 'where-now-text')).join(' | ')).toBe(true);
    await expect(page.getByTestId('where-next-text')).toHaveText(/^Next: (fix the \d+ remaining while your deployment is awaited, then verify the \d+ fix(es)? against the new build|verify the \d+ fix(es)? as soon as the new build is live)$/);
    for (const t of await seen(page, 'where-next-text')) expect(t).not.toMatch(/verify now|without waiting|Keep waiting|sign in, and/i);
    await expect(page.getByTestId('where-you-are')).not.toContainText(/person|handed to you/i);

    // History: the round is awaiting deployment, not a failure.
    await nav(page, 'History');
    await expect(page.getByTestId('history').locator('tr[data-id="round-1"]').getByTestId('round-state')).toHaveText('awaiting deployment');
    await nav(page, 'Fix loop');

    // Guard d: stopped and started again while the old build is still live, the loop waits again
    // (no "still serves the old build", no crawl).
    // Stop ends the fixing only: the fixes still wait for the build, and the watch for it goes on by
    // itself in a run of its own, with nothing asked of anyone.
    const rounds = ledger().rounds.length;
    const stoppedId = (await api(dash, '/api/runs/current')).json.id;
    await page.getByTestId('loop-stop').click();
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.id, { timeout: 30_000 }).not.toBe(stoppedId);
    await expect(status).toHaveText(WAITING(String(count('pending'))), { timeout: 120_000 });
    await asksNothing(page);
    const restarted = (await api(dash, '/api/runs/current')).json;
    expect(restarted.status).toBe('running');
    const again = await runEvents(dash);
    expect(again.some((e) => e.type === 'deployment' && e.state === 'still-old'), JSON.stringify(again.filter((e) => e.type === 'deployment'))).toBe(false);
    expect(again.some((e) => (e.type === 'step' && e.step === 'crawl') || e.type === 'page')).toBe(false);
    expect(ledger().rounds.length).toBeLessThanOrEqual(rounds + 1);
    expect(count('pending')).toBeGreaterThanOrEqual(pending);

    // A reload: the round's line comes from the ledger.
    await page.reload();
    await expect(page.getByTestId('where-done-text').filter({ hasText: 'Round 1:' })).toHaveText(/^Round 1: \d+ fix(es)? committed on branch a11y-508 and pushed to origin/);
    await expect(page.getByTestId('where-done-text').first()).toHaveText(/^Crawled \d+ pages on .+ — \d+ findings/);
    await expect(status).toHaveText(WAITING('\\d+'), { timeout: 30_000 });

    // AC 5: once the new build is live, the loop sees it by itself and verifies.
    site.setBuild(2);
    await expect(status).toHaveText(/^Your deployment arrived: verifying \d+ fix/, { timeout: 60_000 });
    // The loop finishes (nothing more the assistant changes), and Now says so.
    await expect(page.getByTestId('where-now-text')).toHaveText('Now: finished', { timeout: 240_000 });
    expect(count('verified')).toBeGreaterThan(0);
    await expect(status).toHaveText(/^Done: /);
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
test('deploy check, turnkey AC2/AC3: when the start page cannot be read for the check, the wait goes on and asks for a sign-in instead of ending', async ({ page }) => {
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
    await open(page, dash, '/fix-loop');
    await setToken(page);
    await page.getByTestId('loop-start').click();
    const status = page.getByTestId('fix-status');
    await expect(status).toHaveText(/^Waiting for your deployment of branch a11y-508\. The site is checked every 1 s/, { timeout: 240_000 });
    const id = (await api(dash, '/api/runs/current')).json.id;
    // The site now sends every request to its sign-in page: the check cannot read the build.
    site.setBlocked(true);
    await expect(status).toHaveText('Sign in in the tab that opened; the loop continues by itself once you have.', { timeout: 120_000 });
    await page.waitForTimeout(3000);
    const cur = (await api(dash, '/api/runs/current')).json;
    expect([cur.id, cur.status]).toEqual([id, 'running']);
    await expect(page.locator('body')).not.toContainText(/Could not check the site's build|could not reach the start page|has not arrived/);
    await expect(page.getByTestId('verify-anyway')).toHaveCount(0);
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
