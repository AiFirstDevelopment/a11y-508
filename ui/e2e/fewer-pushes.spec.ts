// One push per deployment (docs/plans/fewer-pushes.md): fixes made while a deployment is awaited are
// committed and held, and go out with the next push after the awaited build has arrived; a fix task
// whose assistant gave no answer is asked once more in the same round. The app is the fixture pages in
// a throwaway git repository with a bare "origin" whose post-receive hook counts the pushes; the site
// serves what was last "deployed" from origin (never the working tree), so a held fix is not in the
// build until it is pushed and deployed.

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { api, asksNothing, dashboard, dirsOf, gitRepo, go, now, open, removeTemp, runEvents, tempDir, useToken, ROOT, TOKEN, type Dash } from './harness';

const FAKE = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'test', 'fake-agent.mjs'))} {promptFile} {resultFile}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const MARKER = /<meta name="a11y-508-build" content="([^"]+)">/;

const git = (args: string[], cwd?: string): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// The deployed site: each page as it is at the deployed commit (the app's main at first, then
// whatever origin's a11y-508 was when deploy() ran), with a script bundle per build.
async function deployedSite(cwd: string, originDir: string): Promise<{ base: string; server: Server; deploy: () => string }> {
  let from = { gitDir: join(cwd, '.git'), ref: 'main' };
  let build = 1;
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
    const shown = extname(path) === '.html' ? spawnSync('git', [`--git-dir=${from.gitDir}`, 'show', `${from.ref}:site${path}`], { encoding: 'utf8' }) : null;
    if (!shown || shown.status !== 0) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<!doctype html><html lang="en"><title>Not found</title><h1>404</h1></html>');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(shown.stdout.replace('EXTERNAL_IMAGE', '/pixel.png').replace('FIXTURE_TOKEN', TOKEN).replace('</head>', `<script src="/bundle.${build}.js"></script></head>`));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${(server.address() as any).port}/`,
    server,
    deploy: () => {
      const sha = git([`--git-dir=${originDir}`, 'rev-parse', 'a11y-508']).trim();
      from = { gitDir: originDir, ref: sha };
      build++;
      return sha;
    },
  };
}

test('fewer-pushes AC1-7 / guards 1-6: one push per deployment; fixes made while a deployment is awaited are held and go out with the next push; a task with no answer is asked again in its round', async ({ page }) => {
  test.setTimeout(900_000);
  const cwd = tempDir('a11y-508-fp-');
  const originDir = tempDir('a11y-508-fp-origin-');
  const scratch = tempDir('a11y-508-fp-scratch-');
  const pushLog = join(scratch, 'pushes.log');
  git(['init', '-q', '--bare'], originDir);
  // The origin counts every push it receives.
  writeFileSync(join(originDir, 'hooks', 'post-receive'), `#!/bin/sh\necho push >> ${JSON.stringify(pushLog)}\n`);
  chmodSync(join(originDir, 'hooks', 'post-receive'), 0o755);
  const pushes = () => (existsSync(pushLog) ? readFileSync(pushLog, 'utf8').split('\n').filter(Boolean).length : 0);
  const originIndex = () => git([`--git-dir=${originDir}`, 'show', 'a11y-508:site/index.html']);
  const onOrigin = (sha: string) => spawnSync('git', [`--git-dir=${originDir}`, 'merge-base', '--is-ancestor', sha, 'a11y-508']).status === 0;

  const g = gitRepo(cwd);
  mkdirSync(join(cwd, 'site'), { recursive: true });
  for (const f of ['index.html', 'about.html', 'forms.html']) cpSync(join(ROOT, 'test', 'fixtures', f), join(cwd, 'site', f));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  const site = await deployedSite(cwd, originDir);
  // deployTimeout 0: no limit, as the dashboard writes it. maxAttempts 2: a finding the assistant
  // declines twice is given up, so the round after the deployment has nothing of its own to commit.
  const config = {
    url: site.base, args: ['--max-pages', '3', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage', '--concurrency', '1'],
    agent: FAKE, source: ['site'], check: `${JSON.stringify(process.execPath)} -e 0`, branch: 'a11y-508', push: true, maxAttempts: 2, triageBatch: 50,
    deployed: 'bundle-change', deployTimeout: 0, deployPoll: 1000, agentTimeout: 6000,
  };
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify(config, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture site');
  g('remote', 'add', 'origin', originDir);
  // The first image fix never answers (it runs out of time); the first contrast fix is an honest "no".
  const dash: Dash = await dashboard({ cwd, env: { FAKE_AGENT_HANG_ONCE: join(scratch, 'hung'), FAKE_AGENT_DECLINE_FIRST: join(scratch, 'declined') } });
  const work = dirsOf(cwd).work;
  const ledger = () => JSON.parse(readFileSync(join(work, 'ledger.json'), 'utf8'));
  const findings = () => Object.values<any>(ledger().findings);
  const count = (status: string) => findings().filter((e) => e.status === status).length;
  const contrast = () => findings().find((e) => e.test === '13.C');
  // Each fix task's assistant calls in a round, by the task's test: from the calls log's start lines.
  const callsIn = async (round: number) => {
    const log = readFileSync(join(work, 'agent-calls.log'), 'utf8');
    const starts = (await runEvents(dash)).filter((e) => e.type === 'task' && e.state === 'start' && e.round === round && !e.again);
    return starts.map((e) => ({ test: e.test as string, n: e.n as number, calls: log.split('\n').filter((l) => new RegExp(` start r${round}-fix-${e.n - 1}$`).test(l)).length }));
  };
  try {
    await open(page, dash);
    await useToken(page);
    await go(page).click();

    // Round 1 fixes and pushes once, with marker r1.
    await expect.poll(pushes, { timeout: 300_000 }).toBe(1);
    const awaited = ledger().deploy.marker as string;
    expect(awaited).toMatch(/^r1-/);
    expect(MARKER.exec(originIndex())![1]).toBe(awaited);

    // AC 5 / guard 5: the task that ran out of time was asked once more in round 1, and its second
    // answer committed; the honest "no" (and every other answer) was asked once.
    const r1 = await callsIn(1);
    const twice = r1.filter((t) => t.calls === 2);
    expect(r1.filter((t) => t.calls !== 1 && t.calls !== 2), JSON.stringify(r1)).toEqual([]);
    expect(twice.map((t) => t.test), JSON.stringify(r1)).toEqual(['7.A']);
    expect(r1.find((t) => t.test === '13.C')!.calls, JSON.stringify(r1)).toBe(1);
    const image = findings().find((e) => e.test === '7.A' && e.attempts.some((a: any) => a.round === 1 && a.commit));
    expect(image, 'the image fix was committed in round 1').toBeTruthy();
    expect(image.attempts.filter((a: any) => a.round === 1).length, 'the retry is an attempt of its own').toBe(2);
    expect(image.attempts.filter((a: any) => a.round === 1 && a.commit).length).toBe(1);
    expect(contrast().attempts.filter((a: any) => a.round === 1).map((a: any) => a.outcome)).toEqual(['no-change']);

    // AC 1 / guard 1: the meanwhile round fixes the contrast while r1's build is awaited, commits it,
    // and does not push. The loop then goes on waiting for r1's build.
    await expect.poll(() => contrast().status, { timeout: 180_000 }).toBe('held');
    const heldSha = contrast().attempts.at(-1).commitFull as string;
    expect(heldSha).toBeTruthy();
    const heldAt = Date.now();
    await expect.poll(async () => (await runEvents(dash)).some((e) => e.type === 'deploy-check' && Date.parse(e.at) > heldAt), { timeout: 60_000 }).toBe(true);
    expect(pushes(), 'a meanwhile round does not push').toBe(1);
    // Guard 4: the marker did not move: the ledger and origin still name r1's, and no marker was committed.
    expect(ledger().deploy.marker, 'ledger.deploy.marker stays the awaited push\'s').toBe(awaited);
    expect(MARKER.exec(originIndex())![1]).toBe(awaited);
    expect(git(['log', '--format=%s', 'main..a11y-508'], cwd).split('\n').filter((s) => /^a11y-508: build marker /.test(s)).length, 'one marker commit, r1\'s').toBe(1);
    expect(onOrigin(heldSha), 'the held commit is not on origin').toBe(false);
    // AC 2: the held fix is not counted as awaiting the deployment.
    const pendingNow = count('pending');
    const waitEv = (await runEvents(dash)).filter((e) => e.type === 'await-deploy').at(-1);
    expect([waitEv.pending, waitEv.held]).toEqual([pendingNow, 1]);

    // Guard 6 / AC 4: Stop leaves the held fix committed; the run that goes on watching for the build
    // (a run of its own) still holds it, from the saved ledger.
    const stoppedId = (await api(dash, '/api/runs/current')).json.id;
    await go(page).click();
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.id, { timeout: 60_000 }).not.toBe(stoppedId);
    await expect.poll(async () => (await runEvents(dash)).some((e) => e.type === 'await-deploy'), { timeout: 120_000 }).toBe(true);
    const again = (await runEvents(dash)).filter((e) => e.type === 'await-deploy').at(-1);
    expect(again.held, 'the restarted run still holds the fix').toBe(1);
    expect(contrast().status).toBe('held');
    expect(pushes()).toBe(1);

    // AC 6: the sentence says what is held; the counts line has a group of its own; the fixes panel lists it.
    await expect(now(page)).toHaveText(/^Pushed \d+ fix(es)? to a11y-508; waiting for your deployment \(pushed \d{1,2}:\d\d [AP]M, (not checked yet|checked \d{1,2}:\d\d [AP]M: still the old build)\); 1 more fix is ready and goes out with the next push$/, { timeout: 60_000 });
    await expect(page.getByTestId('counts')).toContainText('1 ready for the next push');
    await expect(page.getByTestId('counts')).toContainText(`${count('pending')} awaiting your deployment`);
    await page.getByTestId('held-link').click();
    await expect(page.getByTestId('fixes-item')).toHaveCount(1);
    await expect(page.getByTestId('fixes-item')).toContainText(contrast().message);
    await expect(page.getByTestId('fixes-state')).toHaveText('State: committed; goes out with the next push');
    await page.getByTestId('fixes-close').click();
    await page.getByTestId('pending-link').click();
    await expect(page.getByTestId('fixes-item').first()).toBeVisible();
    await expect(page.getByTestId('fixes-panel')).not.toContainText(contrast().message);
    await page.getByTestId('fixes-close').click();
    await asksNothing(page);

    // AC 7: the log says the round held its commit.
    await page.getByTestId('diagnostics-link').click();
    await expect(page.getByTestId('d-journal-list')).toContainText(/Round \d+: held 1 commit for the next push \(a deployment is awaited\)/, { timeout: 30_000 });
    await page.goBack();
    await expect(now(page)).toBeVisible();

    // The awaited build (r1's, without the held fix) arrives: the loop verifies it, then pushes once.
    const roundsBefore = ledger().rounds.length;
    const attemptsBefore = contrast().attempts.length;
    site.deploy();
    await expect.poll(() => ledger().rounds.some((r: any, i: number) => i >= roundsBefore && !r.source), { timeout: 180_000 }).toBe(true);
    // Guard 2 / AC 2: the crawl of a build without the held fix leaves it alone: not "did not hold",
    // not reopened, no attempt counted.
    const held = contrast();
    expect(['held', 'pending'], JSON.stringify(held)).toContain(held.status);
    expect(held.attempts.length).toBe(attemptsBefore);
    expect(held.attempts.some((a: any) => a.outcome === 'still-present'), JSON.stringify(held.attempts)).toBe(false);

    // Guard 3 / AC 3 / AC 4: the round after the build has nothing of its own, and the held commit
    // still goes out: one push, with a new marker.
    await expect.poll(pushes, { timeout: 120_000 }).toBe(2);
    expect(onOrigin(heldSha), 'the held commit is on origin').toBe(true);
    const next = MARKER.exec(originIndex())![1];
    expect(next).not.toBe(awaited);
    await expect.poll(() => ledger().deploy?.marker, { timeout: 30_000 }).toBe(next);
    await expect.poll(() => contrast().status, { timeout: 30_000 }).toBe('pending');
    expect(count('held')).toBe(0);
    // AC 7: the push line says how many held commits it carried.
    await page.getByTestId('diagnostics-link').click();
    await expect(page.getByTestId('d-journal-list')).toContainText(/Round \d+: pushed 1 commit, 1 of them held while the deployment was awaited/, { timeout: 30_000 });
    await page.goBack();

    // That push's build arrives: the held fix is verified, and the loop is done. Two deployments, two pushes.
    site.deploy();
    await expect(now(page)).toHaveText(/^Done: /, { timeout: 300_000 });
    expect(contrast().status).toBe('verified');
    expect(pushes(), 'one push per deployment').toBe(2);
  } finally {
    await api(dash, '/api/runs/current/stop', { method: 'POST' }).catch(() => {});
    await dash.stop();
    site.server.close();
    removeTemp(cwd);
    removeTemp(originDir);
    removeTemp(scratch);
  }
});
