// The turnkey loop (docs/plans/turnkey-loop.md, simple-screen.md): the tool decides, the developer
// never does. Every state says in one sentence what is happening, with one button (Start or Stop); the
// loop goes on by itself through sign-ins, errors, interruptions and deployments.
//
// The fixture app is the fixture pages in a throwaway git repository, served with a script bundle
// (its build) and, in portal mode, behind a sign-in portal on another host: only a request carrying
// the current session cookie gets the app; the portal signs a visible Chrome in by itself once the
// test allows it (never a headless one).

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { api, asksNothing, dashboard, dirsOf, gitRepo, go, moreOptions, home, now, open, removeTemp, runEvents, tempDir, useToken, ROOT, TOKEN, type Dash } from './harness';

const FAKE = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'test', 'fake-agent.mjs'))} {promptFile} {resultFile}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const ARGS = ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage', '--concurrency', '1'];

interface App {
  cwd: string;
  g: (...a: string[]) => string;
  base: string;
  server: Server;
  // portal: the session cookie it accepts (change it to expire every session), and whether the portal
  // lets a visible Chrome sign in.
  site: { build: number; session: string; allow: boolean };
  ledger(): any;
  close(): void;
}

async function app(prefix: string, config: Record<string, unknown>, { portal = false } = {}): Promise<App> {
  const cwd = tempDir(prefix);
  const g = gitRepo(cwd);
  mkdirSync(join(cwd, 'site'), { recursive: true });
  for (const f of ['index.html', 'about.html', 'forms.html']) cpSync(join(ROOT, 'test', 'fixtures', f), join(cwd, 'site', f));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  const site = { build: 1, session: 'v1', allow: true, deployed: false };
  const server = createServer((req, res) => {
    const port = (server.address() as any).port;
    const ua = req.headers['user-agent'] || '';
    let path = new URL(req.url!, 'http://x').pathname;
    if (portal && path === '/signin') {
      const visible = /Chrome/.test(ua) && !/Headless/.test(ua);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html lang="en"><title>Sign in</title><h1>Sign in</h1>${visible ? `<script>setInterval(() => fetch('/allowed').then((r) => r.ok && location.replace('http://127.0.0.1:${port}/auth')).catch(() => {}), 500)</script>` : ''}</html>`);
    }
    if (portal && path === '/allowed') {
      res.writeHead(site.allow ? 200 : 404);
      return res.end();
    }
    if (portal && path === '/auth') {
      res.writeHead(302, { location: '/', 'set-cookie': `sid=${site.session}; Path=/` });
      return res.end();
    }
    const ok = portal ? new RegExp(`(?:^|;\\s*)sid=${site.session}(?:;|$)`).test(req.headers.cookie || '') : req.headers.authorization === `Bearer ${TOKEN}`;
    if (!ok) {
      if (portal) {
        res.writeHead(302, { location: `http://localhost:${port}/signin` });
        return res.end();
      }
      res.writeHead(401);
      return res.end();
    }
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
    return res.end(readFileSync(file, 'utf8').replace(/<meta name="a11y-508-build"[^>]*>\s*/i, (m) => (site.deployed ? m : '')).replace('EXTERNAL_IMAGE', '/pixel.png').replace('FIXTURE_TOKEN', TOKEN).replace('</head>', `<script src="/bundle.${site.build}.js"></script></head>`));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/`;
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({ url: base, args: ARGS, agent: FAKE, source: ['site'], check: `${JSON.stringify(process.execPath)} -e 0`, branch: 'a11y-508', push: false, maxAttempts: 5, triageBatch: 50, deployed: 'none', ...config }, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture site');
  return {
    cwd, g, base, server, site,
    ledger: () => JSON.parse(readFileSync(join(dirsOf(cwd).work, 'ledger.json'), 'utf8')),
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

const current = async (dash: Dash) => (await api(dash, '/api/runs/current')).json;
const DONE = /^Done: (nothing to fix|\d+ fixed(, \d+ could not be fixed)?)$/;

test('turnkey AC1 / guard a: idle, running, trying again, stopped and done each say one sentence, with one button', async ({ page }) => {
  test.setTimeout(600_000);
  // push to an origin that does not exist: round 1 commits, then the push fails.
  const a = await app('a11y-508-tk-states-', { push: true });
  a.g('remote', 'add', 'origin', join(a.cwd, 'no-such-origin'));
  const dash = await dashboard({ cwd: a.cwd, env: { A11Y_508_RETRY_DELAYS: '120' } });
  try {
    await open(page, dash);
    await useToken(page);
    // Idle: Start.
    await expect(go(page)).toHaveText('Start');
    await asksNothing(page);
    await go(page).click();
    // Running: Stop only.
    await expect(go(page)).toHaveText('Stop', { timeout: 60_000 });
    await asksNothing(page);
    // The push fails: what happened, in plain words, and when it tries again; Stop only.
    await expect(now(page)).toHaveText(/^Trying again in (\d+ min|\d+ s): push failed$/, { timeout: 240_000 });
    await expect(go(page)).toHaveText('Stop');
    await asksNothing(page);
    // Stop cancels the try again.
    await go(page).click();
    await expect(now(page)).toHaveText('Stopped', { timeout: 15_000 });
    await expect(go(page)).toHaveText('Start');
    await asksNothing(page);
    expect((await current(dash)).retry.cancelled).toBe(true);
    // The origin exists now: Start goes on from the ledger and runs to the end.
    const origin = tempDir('a11y-508-tk-origin-');
    expect(spawnSync('git', ['init', '-q', '--bare'], { cwd: origin }).status).toBe(0);
    a.g('remote', 'set-url', 'origin', origin);
    await go(page).click();
    await expect(go(page)).toHaveText('Stop', { timeout: 60_000 });
    await expect(now(page)).toHaveText(DONE, { timeout: 400_000 });
    await expect(go(page)).toHaveText('Start');
    await asksNothing(page);
    removeTemp(origin);
  } finally {
    await dash.stop();
    a.close();
  }
});

// docs/plans/turnkey-loop.md AC 5 / guard i: a loop that could not start says why and what clears it,
// and starts by itself once it can; nobody presses anything.
test('turnkey AC5 / guard i: a set-up error is the sentence, with its remedy, and the loop starts by itself once the remedy is done', async ({ page }) => {
  test.setTimeout(400_000);
  const a = await app('a11y-508-tk-cannot-start-', {});
  const dash = await dashboard({ cwd: a.cwd, env: { A11Y_508_PRECONDITION_POLL: '2' } });
  try {
    // An edit nobody committed: the loop must not start (its commits would carry it).
    writeFileSync(join(a.cwd, 'site', 'index.html'), readFileSync(join(a.cwd, 'site', 'index.html'), 'utf8') + '\n<!-- an edit in progress -->\n');
    await open(page, dash);
    await useToken(page);
    await go(page).click();
    await expect(now(page)).toHaveText(/^Could not start yet: uncommitted changes under site: site\/index\.html\. Commit or stash them \(git stash --include-untracked\), then try again, .*: site\/index\.html\. This starts by itself once that is done\.$/, { timeout: 60_000 });
    await expect(go(page)).toHaveText('Stop');
    await asksNothing(page);
    // The person follows the remedy: within seconds the loop starts by itself.
    const failed = await current(dash);
    a.g('stash');
    await expect.poll(async () => {
      const c = await current(dash);
      return c && c.status === 'running' ? c.id : failed.id;
    }, { timeout: 15_000, intervals: [250] }).not.toBe(failed.id);
    expect((await current(dash)).meta.attempt).toBeGreaterThan(1);
    await expect(now(page)).not.toHaveText(/^Could not start yet/, { timeout: 30_000 });
    await expect(now(page)).toHaveText(DONE, { timeout: 300_000 });
  } finally {
    await api(dash, '/api/runs/current/stop', { method: 'POST' }).catch(() => {});
    await dash.stop();
    a.close();
  }
});

test('turnkey AC3 / guard e: the sign-in waits as long as it takes, opens a closed tab again, and the loop goes on once signed in', async ({ page }) => {
  test.setTimeout(400_000);
  const a = await app('a11y-508-tk-signin-', {}, { portal: true });
  a.site.allow = false;
  const dash = await dashboard({ cwd: a.cwd });
  try {
    await open(page, dash);
    // No way in chosen: the loop signs in first, in a tab of its own.
    await go(page).click();
    await expect(now(page)).toHaveText('Sign in in the tab that opened; this continues by itself', { timeout: 90_000 });
    // simple-screen AC 1: Show the sign-in tab beside the button.
    await expect(page.getByTestId('show-sign-in-tab')).toHaveText('Show the sign-in tab');
    await expect(go(page)).toHaveText('Stop');
    const id = (await current(dash)).id;
    // Nobody signs in for a while: it still waits, and nothing has given up.
    await page.waitForTimeout(8000);
    await expect(now(page)).toHaveText('Sign in in the tab that opened; this continues by itself');
    const still = await current(dash);
    expect([still.id, still.status]).toEqual([id, 'running']);
    await expect(page.locator('body')).not.toContainText(/Nobody signed in|gave up after/);
    await asksNothing(page);
    // The person closes the sign-in tab: it is opened again, and that is said.
    const waiting = (await runEvents(dash)).filter((e) => e.type === 'login-waiting').pop();
    expect(waiting && waiting.port && waiting.targetId, JSON.stringify(waiting)).toBeTruthy();
    await fetch(`http://127.0.0.1:${waiting.port}/json/close/${waiting.targetId}`).catch(() => null);
    await expect(now(page)).toHaveText('Sign in in the tab that opened again (the first was closed); this continues by itself', { timeout: 30_000 });
    // Signed in: the crawl runs.
    a.site.allow = true;
    await expect.poll(async () => (await runEvents(dash)).some((e) => e.type === 'page' && e.round), { timeout: 120_000 }).toBe(true);
    await expect(now(page)).not.toHaveText(/Sign in in the tab/);
    await expect(page.getByTestId('show-sign-in-tab')).toHaveCount(0);
    expect((await current(dash)).id).toBe(id);
  } finally {
    await api(dash, '/api/runs/current/stop', { method: 'POST' }).catch(() => {});
    await dash.stop();
    a.close();
  }
});

test('turnkey AC3 / guard f: a round whose crawl is sent to the sign-in signs in again and crawls again, and the loop goes on', async ({ page }) => {
  test.setTimeout(500_000);
  const a = await app('a11y-508-tk-expired-', {}, { portal: true });
  // Each assistant call takes a while, as a real one does: round 1's fix step then lasts long enough
  // for the poll below to see it and expire the sessions before round 2's crawl begins.
  const dash = await dashboard({ cwd: a.cwd, env: { FAKE_AGENT_DELAY_MS: '500' } });
  try {
    await open(page, dash);
    await go(page).click();
    // Round 1 signs in (the portal lets it), crawls and starts fixing; then every session expires.
    await expect.poll(async () => (await runEvents(dash)).some((e) => e.type === 'step' && e.step === 'fix' && e.round === 1), { timeout: 200_000 }).toBe(true);
    a.site.session = 'v2';
    a.site.allow = false;
    await expect(now(page)).toHaveText(/^Your sign-in expired: sign in in the tab that opened( again \(the first was closed\))?; this continues by itself$/, { timeout: 200_000 });
    await asksNothing(page);
    a.site.allow = true;
    // The crawl runs again in the new session and audits the page; the loop goes on.
    await expect.poll(() => {
      try {
        return a.ledger().rounds.find((r: any) => r.round === 2)?.audited || 0;
      } catch {
        return 0;
      }
    }, { timeout: 200_000 }).toBeGreaterThan(0);
    // Still running, or ended as a loop ends when nothing is left (exit 0, 1 or 4): never stopped or in error.
    const cur = await current(dash);
    expect(cur.status === 'running' || (cur.status === 'done' && [0, 1, 4].includes(cur.code)), JSON.stringify(cur)).toBe(true);
    expect((await runEvents(dash)).some((e) => e.type === 'error')).toBe(false);
  } finally {
    await api(dash, '/api/runs/current/stop', { method: 'POST' }).catch(() => {});
    await dash.stop();
    a.close();
  }
});

test('turnkey AC3: a crawl (a folder the loop cannot fix in) sent to the sign-in signs in and crawls again, with no notice or buttons', async ({ page }) => {
  test.setTimeout(300_000);
  const a = await app('a11y-508-tk-crawl-', {}, { portal: true });
  // No package.json: Start crawls only.
  unlinkSync(join(a.cwd, 'package.json'));
  a.site.allow = false;
  const dash = await dashboard({ cwd: a.cwd });
  try {
    await open(page, dash);
    await moreOptions(page);
    // No session: the crawl is sent to the portal.
    await page.getByLabel('No sign-in').check();
    await page.getByLabel('Maximum pages').fill('1');
    await home(page);
    await expect(now(page)).toHaveText(/^Ready to crawl 127\.0\.0\.1:\d+; nothing will be fixed: fixing needs the app's repository, and this folder has no package\.json\.$/, { timeout: 60_000 });
    await go(page).click();
    await expect(now(page)).toHaveText(/^Your sign-in expired: sign in in the tab that opened( again \(the first was closed\))?; this continues by itself$/, { timeout: 120_000 });
    await asksNothing(page);
    const cur = await current(dash);
    expect(cur.meta.signInAgain).toBe(true);
    a.site.allow = true;
    await expect(now(page)).toHaveText(/^Done: crawled 1 page, \d+ findings?; nothing was fixed: fixing needs the app's repository, and this folder has no package\.json$/, { timeout: 120_000 });
  } finally {
    await api(dash, '/api/runs/current/stop', { method: 'POST' }).catch(() => {});
    await dash.stop();
    a.close();
  }
});

test('turnkey AC6 / guard j: from the dashboard the loop has no round cap; it ends when nothing is left, and says what was done', async ({ page }) => {
  test.setTimeout(500_000);
  const a = await app('a11y-508-tk-rounds-', {});
  const dash = await dashboard({ cwd: a.cwd });
  try {
    await open(page, dash);
    await useToken(page);
    await go(page).click();
    await expect(go(page)).toHaveText('Stop', { timeout: 60_000 });
    await expect(now(page)).toHaveText(DONE, { timeout: 400_000 });
    // Round 1 committed; round 2 crawled to verify, and found the rest the assistant could not fix.
    const ledger = a.ledger();
    expect(ledger.rounds.length, JSON.stringify(ledger.rounds.map((r: any) => r.round))).toBeGreaterThanOrEqual(2);
    expect(Object.values<any>(ledger.findings).some((e) => e.status === 'verified')).toBe(true);
    await expect(page.locator('body')).not.toContainText(/reached --max-rounds/);
    await asksNothing(page);
    expect((await current(dash)).meta.command).toMatch(/ --max-rounds 0\b/);
  } finally {
    await dash.stop();
    a.close();
  }
});

test('turnkey AC7 / guard k: nothing on the dashboard deletes anything; the server endpoints stay', async ({ page }) => {
  test.setTimeout(300_000);
  const a = await app('a11y-508-tk-setup-', {});
  const dash = await dashboard({ cwd: a.cwd });
  try {
    // Two crawls of the URL: an earlier crawl and the latest.
    for (let i = 0; i < 2; i++) {
      expect((await api(dash, '/api/runs', { method: 'POST', body: { kind: 'crawl', url: a.base, options: { 'max-pages': '1', 'no-zoom': true }, auth: { mode: 'token', token: TOKEN } } })).status).toBe(202);
      await expect.poll(async () => (await current(dash))?.status, { timeout: 120_000 }).toBe('done');
    }
    await open(page, dash);
    await asksNothing(page);
    for (const name of ['Clear history', 'Clear fix-loop history', 'Start over']) await expect(page.getByRole('button', { name })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Delete\b/ })).toHaveCount(0);
    await page.getByTestId('diagnostics-link').click();
    await expect(page.getByRole('button', { name: /^(Delete|Clear)\b/ })).toHaveCount(0);
    // The server's endpoints are as they were (nothing in the UI calls them).
    expect((await api(dash, '/api/start-over')).status).toBe(200);
    expect((await api(dash, '/api/reports/history', { method: 'DELETE' })).json.removed).toBe(1);
  } finally {
    await dash.stop();
    a.close();
  }
});

test('turnkey AC8: the README documents no removed button', async () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  // Start over is documented: it came back as a link beside Log (f0fb752), never as a button (AC7 above).
  for (const words of ['verify now', 'Keep waiting', 'Stop waiting', 'Verify anyway', 'Start anyway', 'Deployed — continue', 'Fix the remaining', 'Try again', 'Sign in and continue', 'Clear fix-loop history', 'Clear history', 'Crawl again', 'Troubleshoot with these settings', 'Run again', 'Fix the violations', 'Check now', 'Copy summary']) {
    expect(readme, words).not.toContain(words);
  }
  // The PDF run is documented, on the dashboard and on the command line (manual-findings-clarity AC 5).
  expect(readme).toContain('Fix from a test report (PDF)');
  expect(readme).toContain('a11y-508 manual');
});
