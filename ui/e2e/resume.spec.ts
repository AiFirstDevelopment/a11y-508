// The dashboard resumes where it was (docs/plans/resume.md): closing its window does not end it;
// Quit does; reopening lands on the step the person was on, on the live run, or on an interrupted
// fix loop with Continue and Start over; Start over asks first and is the only thing that resets.

import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, dashboard, dirsOf, fillRun, fixtureSite, gitRepo, open, removeTemp, run, startFromRun, stopTree, tempDir, BIN, MAIN, ROOT, TOKEN, type Dash, type Site } from './harness';

// "13 Oct 2026, 4:52 PM" is 20:52 UTC in New York.
test.use({ timezoneId: 'America/New_York' });

const FAKE = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'test', 'fake-agent.mjs'))} {promptFile} {resultFile}`;
const QUICK = ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
};

// A repository with the fixture's start page under site/, a committed config, a person's notes
// outside site/, and the crawl the person ran (a11y-508-report/report.json).
async function appWithReport(site: Site, prefix: string): Promise<{ cwd: string; g: (...a: string[]) => string; report: any }> {
  const cwd = tempDir(prefix);
  const g = gitRepo(cwd);
  mkdirSync(join(cwd, 'site'));
  cpSync(join(ROOT, 'test', 'fixtures', 'index.html'), join(cwd, 'site', 'index.html'));
  writeFileSync(join(cwd, 'NOTES.md'), 'notes\n');
  writeFileSync(join(cwd, '.gitignore'), 'a11y-508-work/\na11y-508-report/\na11y-508-history/\n');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({ url: site.base, args: QUICK, agent: FAKE, source: ['site'], push: false, deployed: 'none', triageBatch: 50 }, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'app');
  const crawl = await run(process.execPath, [BIN, site.base, ...QUICK, '--out', 'a11y-508-report', '--quiet', '--fail-on', 'none'], { cwd, env: { ...process.env, TOKEN } });
  expect(crawl.status, crawl.output).toBe(0);
  return { cwd, g, report: JSON.parse(readFileSync(join(cwd, 'a11y-508-report', 'report.json'), 'utf8')) };
}

// A finished process's pid: gone by the time the dashboard looks at it.
async function deadPid(): Promise<number> {
  const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => p.on('exit', r));
  return p.pid!;
}

// The fix loop as the dashboard's closing left it: round 1 recorded in the ledger, fix 8 of 20
// begun (an attempt with no outcome), its edits under site/ uncommitted, and its process gone with
// no `done` in its events.
async function interruptedLoop(cwd: string, site: Site, report: any): Promise<void> {
  const id = '11111111-2222-4333-8444-555555555555';
  const runs = join(cwd, 'a11y-508-work', 'runs');
  mkdirSync(runs, { recursive: true });
  const startedAt = '2026-10-13T19:40:00.000Z';
  const at = '2026-10-13T20:52:00.000Z';
  writeFileSync(join(runs, `${id}.run.json`), JSON.stringify({ id, kind: 'loop', pid: await deadPid(), startedAt: new Date(Date.now() - 3600000).toISOString(), cwd, url: site.base, args: [], meta: { url: site.base }, request: { kind: 'loop', url: site.base, auth: { mode: 'none' }, maxRounds: 1 } }));
  const evs = [
    { type: 'run', id, kind: 'loop', at: startedAt, url: site.base },
    { type: 'round', round: 1, at: startedAt },
    { type: 'step', round: 1, step: 'fix', count: 20, at: startedAt },
    { type: 'task', round: 1, n: 8, m: 20, test: '1.A', message: 'An image has no text alternative', state: 'start', at },
    { type: 'agent-output', round: 1, task: 8, kind: 'fix', stream: 'stdout', text: 'editing site/index.html\n', at },
  ];
  writeFileSync(join(runs, `${id}.events.ndjson`), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  // Round 1 as the loop records it, with fix 8's attempt begun on the first open finding.
  // @ts-ignore -- plain JS from the core
  const { applyReport } = await import('../../src/ledger.mjs');
  const ledger: any = { version: 1, rounds: [], findings: {} };
  applyReport(ledger, report, 1);
  const open: any = Object.values(ledger.findings).find((e: any) => e.status === 'open');
  open.attempts.push({ round: 1, startedAt: at });
  writeFileSync(join(cwd, 'a11y-508-work', 'ledger.json'), JSON.stringify(ledger, null, 2));
  // The unfinished fix's edits, under site/: a changed file and a new one.
  writeFileSync(join(cwd, 'site', 'index.html'), readFileSync(join(cwd, 'site', 'index.html'), 'utf8') + '\n<!-- half a fix -->\n');
  writeFileSync(join(cwd, 'site', 'added.html'), '<p>half a fix</p>\n');
  // The person's own edit, outside the folders the loop edits.
  writeFileSync(join(cwd, 'NOTES.md'), 'notes\nmy own edit\n');
}

test('resume AC1 / guard 1: closing the dashboard\'s own browser window leaves the dashboard serving', async () => {
  const home = join(tempDir('a11y-508-ownhome-'), '.a11y-508');
  const cwd = tempDir('a11y-508-owncwd-');
  const proc = spawn(process.execPath, [MAIN, '--port', '0'], { cwd, env: { ...process.env, TOKEN: '', A11Y_508_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  try {
    await expect.poll(() => out, { timeout: 30_000 }).toContain('opened in its own browser window');
    const url = /open: (http:\S+)/.exec(out)![1];
    const u = new URL(url);
    const secret = /secret=([0-9a-f]+)/.exec(u.hash)![1];
    const port = readFileSync(join(home, 'browser-profile', 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    // The person closes the window: the whole browser ends.
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.close').catch(() => {});
    await expect.poll(() => out, { timeout: 30_000 }).toContain("the dashboard's window was closed; the dashboard keeps running");
    await sleep(1000);
    const res = await fetch(`${u.origin}/api/env`, { headers: { 'X-A11y-508-Secret': secret } });
    expect(res.status).toBe(200);
    expect(proc.exitCode).toBeNull();
  } finally {
    await stopTree(proc, 'SIGINT');
    removeTemp(cwd);
  }
});

test('resume AC1: Quit asks first while a run is active, then ends the dashboard and the run', async ({ page }) => {
  // A page that never finishes loading keeps the crawl running.
  const { createServer } = await import('node:http');
  const hang = createServer(() => {});
  await new Promise<void>((ok) => hang.listen(0, '127.0.0.1', ok));
  const dash: Dash = await dashboard();
  let pid = 0;
  try {
    const r = await api(dash, '/api/runs', { method: 'POST', body: { kind: 'crawl', url: `http://127.0.0.1:${(hang.address() as any).port}/`, options: { timeout: '120000' }, auth: { mode: 'none' } } });
    expect(r.status).toBe(202);
    await open(page, dash, '/live');
    await page.getByRole('button', { name: 'Quit the dashboard' }).click();
    const dialog = page.getByRole('dialog', { name: 'Quit while the crawl runs?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Quitting ends the dashboard and stops the crawl.');
    const runs = join(dash.dirs().work, 'runs');
    const { readdirSync } = await import('node:fs');
    pid = JSON.parse(readFileSync(join(runs, readdirSync(runs).find((n) => n.endsWith('.run.json'))!), 'utf8')).pid;
    expect(alive(pid)).toBe(true);
    await dialog.getByRole('button', { name: 'Stop it and quit' }).click();
    await expect(page.getByTestId('quit-done')).toHaveText(/The dashboard has ended/);
    await expect.poll(() => dash.proc.exitCode, { timeout: 15_000 }).toBe(0);
    await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
  } finally {
    if (pid && alive(pid)) try { process.kill(-pid, 'SIGKILL'); } catch {}
    await dash.stop();
    hang.closeAllConnections?.();
    hang.close();
  }
});

test('resume AC4 / guard 4: after a crawl, reloading and relaunching the dashboard open on Results, not Set up', async ({ page, browser }) => {
  const site = await fixtureSite();
  const cwd = tempDir('a11y-508-land-');
  const home = tempDir('a11y-508-landhome-');
  let dash: Dash = await dashboard({ cwd, env: { A11Y_508_HOME: home } });
  try {
    await open(page, dash, '/run', { details: false });
    await fillRun(page, { url: site.base + 'about.html', token: TOKEN, maxPages: 1 });
    await startFromRun(page);
    await expect(page).toHaveURL(/\/report$/, { timeout: 180_000 });
    await expect.poll(async () => (await api(dash, '/api/settings')).json.lastStep).toBe('/report');
    // A reload at the address the dashboard printed.
    await page.goto(`${dash.origin}/#secret=${dash.secret}`);
    await expect(page).toHaveURL(/\/report$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Results|report/i);
    // The dashboard started again, its window a new one (nothing remembered in the browser).
    await dash.stop();
    dash = await dashboard({ cwd, env: { A11Y_508_HOME: home } });
    const fresh = await browser.newContext();
    const p2 = await fresh.newPage();
    await p2.goto(`${dash.origin}/#secret=${dash.secret}`);
    await expect(p2).toHaveURL(/\/report$/);
    await expect(p2.getByRole('dialog', { name: 'Set up' })).toBeHidden();
    await fresh.close();
  } finally {
    await dash.stop();
    site.close();
    removeTemp(cwd);
  }
});

test('resume AC5 / guards 5 and 6: an interrupted fix loop says where it stopped; Continue reverts only the unfinished fix and goes on with no crawl', async ({ page }) => {
  const site = await fixtureSite();
  const { cwd, report } = await appWithReport(site, 'a11y-508-intr-');
  await interruptedLoop(cwd, site, report);
  // The resumed loop's first assistant call waits before it does anything, so what Continue left
  // on disk is read before the loop's own work (which reverts stray changes after each fix).
  const marks = tempDir('a11y-508-intr-marks-');
  const dash: Dash = await dashboard({ cwd, env: { FAKE_AGENT_SLOW_ONCE: join(marks, 'slow'), FAKE_AGENT_SLOW_MS: '20000' } });
  try {
    // The Fix step: the interruption, where it was, Continue and Start over.
    await open(page, dash, '/fix-loop');
    const notice = page.getByTestId('interrupted');
    await expect(page.getByTestId('interrupted-text')).toHaveText('The fix loop was interrupted at fix 8 of 20 on 13 Oct 2026, 4:52 PM (the dashboard was closed).');
    await expect(notice.getByRole('button', { name: 'Continue' })).toBeVisible();
    // Opened at its address, it lands there.
    await page.goto(`${dash.origin}/#secret=${dash.secret}`);
    await expect(page).toHaveURL(/\/fix-loop$/);
    await expect(page.getByTestId('interrupted-text')).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Start over' })).toBeVisible();
    for (const words of ['Loop finished', 'The fix loop stopped']) await expect(page.locator('body')).not.toContainText(words);
    // What Continue discards: the unfinished fix's changes under site/, never the person's notes.
    await expect(page.getByTestId('interrupted-discard').getByRole('listitem')).toHaveText(['site/added.html', 'site/index.html']);

    await notice.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('agent-output')).toContainText('Discarded the unfinished change to site/index.html', { timeout: 30_000 });
    await expect(page.getByTestId('agent-output')).toContainText('Discarded the unfinished change to site/added.html');
    await expect(page.getByTestId('agent-output')).not.toContainText('NOTES.md');
    // The unfinished edit is gone (the resumed loop's own fix may already be in the file).
    expect(readFileSync(join(cwd, 'site', 'index.html'), 'utf8')).not.toContain('half a fix');
    expect(existsSync(join(cwd, 'site', 'added.html'))).toBe(false);
    expect(readFileSync(join(cwd, 'NOTES.md'), 'utf8')).toBe('notes\nmy own edit\n');
    // The interrupted loop's ledger and run journal moved out of the repository when the dashboard started; Continue used them.
    expect(existsSync(join(cwd, 'a11y-508-work'))).toBe(false);
    const ledger = JSON.parse(readFileSync(join(dirsOf(cwd).work, 'ledger.json'), 'utf8'));
    expect(Object.values<any>(ledger.findings).flatMap((e) => e.attempts).find((a) => a.startedAt === '2026-10-13T20:52:00.000Z').outcome).toBe('interrupted');
    // The loop goes on from the ledger: round 1 again, with no crawl.
    await expect.poll(async () => (await api(dash, '/api/runs/current/events')).text, { timeout: 60_000 }).toContain('"resumed":true');
    const evs = (await api(dash, '/api/runs/current/events')).text;
    const round1 = evs.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((e) => e.round === 1);
    expect(round1.some((e) => e.type === 'step' && e.step === 'crawl')).toBe(false);
    if ((await api(dash, '/api/runs/current')).json?.status === 'running') await api(dash, '/api/runs/current/stop', { method: 'POST' });
  } finally {
    await dash.stop();
    site.close();
    removeTemp(cwd);
    removeTemp(marks);
  }
});

test('resume AC6 / guard 7: Start over names what it discards and asks first; a reload and a relaunch keep the ledger', async ({ page, browser }) => {
  const site = await fixtureSite();
  const { cwd, report } = await appWithReport(site, 'a11y-508-over-');
  await interruptedLoop(cwd, site, report);
  // An earlier crawl of the same URL in History.
  mkdirSync(join(cwd, 'a11y-508-history', '2026-10-12T10-00-00'), { recursive: true });
  writeFileSync(join(cwd, 'a11y-508-history', '2026-10-12T10-00-00', 'report.json'), JSON.stringify({ ...report, finishedAt: '2026-10-12T10:00:00.000Z' }));
  // Seven earlier attempts on record, and the one in progress: 8.
  const lf = join(cwd, 'a11y-508-work', 'ledger.json');
  const l = JSON.parse(readFileSync(lf, 'utf8'));
  const f: any = Object.values(l.findings).find((e: any) => e.attempts.length);
  f.attempts = [...Array.from({ length: 7 }, () => ({ round: 1, files: [], note: 'x', outcome: 'no-change' })), ...f.attempts];
  writeFileSync(lf, JSON.stringify(l));
  const home = tempDir('a11y-508-overhome-');
  // Where the ledger is once the dashboard has moved the old-style folders out of the repository.
  const seeded = lf;
  const lfNow = join(dirsOf(cwd, home).work, 'ledger.json');
  let dash: Dash = await dashboard({ cwd, env: { A11Y_508_HOME: home } });
  expect(existsSync(seeded)).toBe(false);
  try {
    await page.goto(`${dash.origin}/#secret=${dash.secret}`);
    await expect(page).toHaveURL(/\/fix-loop$/);
    // Nothing else resets: a reload, and a relaunch, keep the ledger and the interruption.
    await page.reload();
    await expect(page.getByTestId('interrupted-text')).toBeVisible();
    await dash.stop();
    dash = await dashboard({ cwd, env: { A11Y_508_HOME: home } });
    const fresh = await browser.newContext({ timezoneId: 'America/New_York' });
    const p2 = await fresh.newPage();
    await p2.goto(`${dash.origin}/#secret=${dash.secret}`);
    await expect(p2.getByTestId('interrupted-text')).toBeVisible();
    await fresh.close();
    expect(existsSync(lfNow)).toBe(true);
    expect(Object.values<any>(JSON.parse(readFileSync(lfNow, 'utf8')).findings).flatMap((e) => e.attempts).length).toBe(8);

    // Start over, on Set up: the confirmation names what it discards.
    await open(page, dash, '/run');
    await page.getByTestId('start-over-line').getByRole('button', { name: 'Start over' }).click();
    const dialog = page.getByRole('dialog', { name: 'Start over?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('start-over-text')).toHaveText('This discards the report, the ledger with 8 attempts, and the history for this URL. The dashboard starts again at Set up.');
    // Cancel discards nothing.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(existsSync(lfNow)).toBe(true);
    await page.getByTestId('start-over-line').getByRole('button', { name: 'Start over' }).click();
    await dialog.getByTestId('start-over-yes').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => existsSync(lfNow)).toBe(false);
    expect(existsSync(join(dirsOf(cwd, home).report, 'report.json'))).toBe(false);
    expect(existsSync(join(dirsOf(cwd, home).history, '2026-10-12T10-00-00'))).toBe(false);
    expect((await api(dash, '/api/settings')).json.lastStep ?? '/run').toBe('/run');
    // Opened again at its address: Set up.
    await page.goto(`${dash.origin}/#secret=${dash.secret}`);
    await expect(page).toHaveURL(/\/run$/);
  } finally {
    await dash.stop();
    site.close();
    removeTemp(cwd);
  }
});
