// The Playwright harness: the fixture site (test/fixture-site.mjs), the real
// dashboard server in a temporary working directory, and helpers that drive
// the app the way a person does.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
// @ts-ignore -- plain JS shared with the server's node:test suite
import { mergeEnv, processList, stopTree } from '../server/test/platform.mjs';
// @ts-ignore -- the one removal path: refuses anything these helpers did not create under the temp directory
import { assertRemovable, removeTemp, tmp } from '../server/test/helpers.mjs';
// @ts-ignore
export { assertRemovable, removeTemp, REPO_ROOT } from '../server/test/helpers.mjs';
// @ts-ignore -- the core's one mapping from a repository folder to the tool's own folders for it
import { repoHome } from '../../src/home.mjs';
// @ts-ignore
export { WIN, argPattern, exePath, gitBash, loginShell, msysPath, npmBin, processList, quote, recordOpen, shellLine, shPath, stopTree, stub, stubScript, systemPath } from '../server/test/platform.mjs';

export const UI = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = resolve(UI, '..');
export const MAIN = join(UI, 'server', 'main.mjs');
export const BIN = join(ROOT, 'bin', 'a11y-508.mjs');
export const TOKEN = 'fixture-token-123';
export const SECRET_HEADER = 'X-A11y-508-Secret';

export interface Site {
  base: string;
  origin: string;
  close(): void;
  unauthorized: string[];
}

export async function fixtureSite(opts: { autoLogin?: boolean; dropForms?: number } = {}): Promise<Site> {
  const m: any = await import('../../test/fixture-site.mjs');
  return m.startFixtureSite({ dropForms: 0, ...opts });
}

// A temporary directory these helpers created, the only kind removeTemp removes.
export const tempDir = (prefix: string): string => tmp(prefix);

// The tool's state base for anything a spec runs directly (the CLI's loop, status, a crawl inside a
// repository): a temporary one, never the person's ~/.a11y-508. A dashboard gets its own (below).
if (!process.env.A11Y_508_HOME) process.env.A11Y_508_HOME = tempDir('a11y-508-home-specs-');

// The state base each dashboard's working directory was started with, so a spec can find the
// tool's own folders for it (the report, the history, the loop's work folder).
const homes = new Map<string, string>();
export interface ToolDirs { dir: string; work: string; report: string; history: string }
export function dirsOf(cwd: string, home: string | undefined = homes.get(cwd)): ToolDirs {
  if (!home) throw new Error(`no dashboard was started in ${cwd}, so its state base is not known`);
  return repoHome(cwd, { A11Y_508_HOME: home });
}

export interface Dash {
  origin: string;
  url: string;
  secret: string;
  cwd: string;
  home: string;
  dirs(dir?: string): ToolDirs;
  proc: ChildProcess;
  output(): string;
  stop(): Promise<void>;
}

// The dashboard's own browser, played by a Node script (it never opens a real window).
export const FAKE_OWN_BROWSER = join(UI, 'server', 'test', 'fake-own-browser.mjs');

// ownBrowser: started as a person starts it (no --no-open), with the fake own browser.
export async function dashboard(opts: { cwd?: string; env?: NodeJS.ProcessEnv; args?: string[]; main?: string; keepCwd?: boolean; ownBrowser?: boolean } = {}): Promise<Dash> {
  const cwd = opts.cwd || tempDir('a11y-508-dash-');
  // A dashboard's working directory is always a disposable one of the tests', never the checkout.
  assertRemovable(cwd);
  // The dashboard's own files (config, session, settings, reports, the loop's work folder) go to a
  // home of the test's, never ~/.a11y-508.
  const home = (opts.env && opts.env.A11Y_508_HOME) || tempDir('a11y-508-home-');
  homes.set(cwd, home);
  const proc = spawn(process.execPath, [opts.main || MAIN, ...(opts.ownBrowser ? [] : ['--no-open']), '--port', '0', ...(opts.args || [])], {
    cwd,
    env: mergeEnv(process.env, { TOKEN: '', ...opts.env, ...(opts.ownBrowser ? { A11Y_508_OWN_BROWSER_PATH: FAKE_OWN_BROWSER } : {}), A11Y_508_HOME: home }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  const url = await new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`dashboard did not start:\n${out}`)), 30000);
    const check = () => {
      const m = /open: (http:\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        ok(m[1]);
      }
    };
    proc.stdout!.on('data', check);
    proc.on('exit', () => fail(new Error(`dashboard exited:\n${out}`)));
  });
  const u = new URL(url);
  const secret = /secret=([0-9a-f]+)/.exec(u.hash)![1];
  return {
    origin: u.origin, url, secret, cwd, proc, home,
    dirs: (dir = cwd) => dirsOf(dir, home),
    output: () => out,
    stop: async () => {
      await stopTree(proc);
      // Windows releases a killed process's hold on its working directory a little later.
      if (opts.keepCwd || opts.cwd) return;
      try {
        removeTemp(cwd, { maxRetries: 15, retryDelay: 200 });
      } catch (e: any) {
        // Name what still runs, so a process that outlived the server is visible.
        const procs = (processList() as string).split(/\r?\n/).filter((l) => l.trim() && !/--type=|svchost|\\Windows\\System32\\(svchost|conhost|RuntimeBroker|dllhost|sihost|taskhostw|ctfmon|WmiPrvSE)/i.test(l));
        throw new Error(`${e.message}\nprocesses still running:\n${procs.join('\n')}`);
      }
    },
  };
}

export async function api(dash: Dash, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(dash.origin + path, {
    method: init.method || 'GET',
    headers: { [SECRET_HEADER]: dash.secret, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

// Opens the dashboard as a returning viewer: the working directory is remembered (no setup
// dialog). { fresh: true } opens it as a first visit, with nothing remembered; { url } puts a start
// URL in this browser's memory first.
export async function open(page: Page, dash: Dash, path = '/', opts: { fresh?: boolean; url?: string } = {}): Promise<void> {
  if (!opts.fresh) {
    // The server's working directory (it may have been started with --dir).
    const cwd = (await api(dash, '/api/env')).json.cwd;
    await page.addInitScript(([cwd, url, origin]) => {
      // Only for this dashboard: a page can open several (each its own origin).
      if (location.origin !== origin) return;
      try {
        if (!localStorage.getItem('a11y508.cwd')) localStorage.setItem('a11y508.cwd', cwd);
        if (url) localStorage.setItem('a11y508.startUrl', url);
      } catch {}
    }, [cwd, opts.url || '', dash.origin] as [string, string, string]);
  }
  await page.goto(`${dash.origin}${path}#secret=${dash.secret}`);
  await expect(page.locator('h1')).toBeVisible();
}

// In-app navigation to a route (the app keeps its state, as a click on a link would).
export async function goInApp(page: Page, path: string): Promise<void> {
  if (new URL(page.url()).pathname === path) return;
  await page.evaluate((p) => {
    history.pushState(null, '', p);
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  }, path);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[/]/g, '\\/')}$`));
}

// The one screen, in-app.
export const home = (page: Page): Promise<void> => goInApp(page, '/');

// Advanced (the bottom of Diagnostics): the crawl's settings beyond the URL, the assistant, the loop's settings.
export async function moreOptions(page: Page): Promise<void> {
  await goInApp(page, '/advanced');
  await expect(page.getByTestId('more-options')).toBeVisible();
}
export async function loopOptions(page: Page): Promise<void> {
  await goInApp(page, '/advanced');
  await expect(page.getByTestId('loop-more')).toBeVisible();
}
// The assistant picker, under Advanced, once the assistants are detected.
export async function openPicker(page: Page): Promise<void> {
  await goInApp(page, '/advanced');
  await expect(page.getByTestId('picker')).toBeVisible({ timeout: 60_000 });
}

// The way in: a token, chosen under Advanced; then back to the one screen.
export async function useToken(page: Page, token = TOKEN): Promise<void> {
  await moreOptions(page);
  await page.getByLabel('A token').check();
  await page.getByLabel(/^Token \(sent as/).fill(token);
  await home(page);
}

// The folder and URL through Change folder or URL on Diagnostics (the setup dialog), without
// starting: the URL is typed and the dialog closed with Escape.
export async function setUrl(page: Page, url: string): Promise<void> {
  await goInApp(page, '/diagnostics');
  await page.getByTestId('change-setup').click();
  const dialog = page.getByRole('dialog', { name: 'Set up' });
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel('Start URL');
  await expect(async () => {
    await field.fill(url);
    await expect(field).toHaveValue(url, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await field.blur();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await home(page);
}

export interface CrawlForm {
  url: string;
  token?: string;
  maxPages?: number;
  failOn?: string;
  advanced?: Record<string, string | boolean>;
}

// The URL, and the crawl's settings under Advanced; back on the one screen after.
export async function fillRun(page: Page, f: CrawlForm): Promise<void> {
  await setUrl(page, f.url);
  if (f.token !== undefined || f.maxPages || f.failOn || (f.advanced && Object.keys(f.advanced).length)) {
    await moreOptions(page);
    if (f.token !== undefined) {
      await page.getByLabel('A token').check();
      await page.getByLabel(/^Token \(sent as/).fill(f.token);
    }
    if (f.maxPages) await page.getByLabel('Maximum pages').fill(String(f.maxPages));
    if (f.failOn) await page.getByLabel('Fail on impacts').fill(f.failOn);
    for (const [flag, v] of Object.entries(f.advanced || {})) {
      const el = page.locator(`#adv-${flag}`);
      if (typeof v === 'boolean') await el.setChecked(v);
      else await el.fill(v);
    }
    await home(page);
  }
}

// The fixture crawl most tests use: small.
export const QUICK = { maxPages: 5, advanced: { 'no-zoom': true } };

// The one sentence, the one line of numbers, the one button.
export const now = (page: Page) => page.getByTestId('now');
export const go = (page: Page) => page.getByTestId('go');
export const status = now;

// Start, on the one screen: the button becomes Stop once the run is the page's.
export async function startFromRun(page: Page): Promise<void> {
  await home(page);
  await expect(go(page)).toHaveText('Start');
  await go(page).click();
  await expect(go(page)).toHaveText('Stop', { timeout: 60_000 });
  // The server has the run: the sentence is the run's, not the click's.
  await expect(now(page)).not.toHaveText('Starting…', { timeout: 60_000 });
}
export const start = startFromRun;

// How a run ends, in the sentence.
export const ENDED = /^(Done\b|Stopped|The crawl failed|Could not get into)/;

// Until the run has ended (the button is Start again and the sentence says how); the sentence.
export async function waitFinished(page: Page, timeout = 280_000): Promise<string> {
  await home(page);
  await expect(now(page)).toHaveText(ENDED, { timeout });
  await expect(go(page)).toHaveText('Start', { timeout: 30_000 });
  return (await now(page).textContent()) || '';
}

// Every distinct text the sentence (and other test ids) showed, recorded in the page from now on,
// with the main buttons on screen at the time.
export async function record(page: Page, testids: string[] = ['now']): Promise<void> {
  await page.evaluate((ids) => {
    const w = window as any;
    w.__seen = Object.fromEntries(ids.map((id: string) => [id, [] as string[]]));
    w.__buttons = [] as { now: string; buttons: string[] }[];
    const sample = () => {
      for (const id of ids) {
        for (const el of document.querySelectorAll(`[data-testid="${id}"]`)) {
          const t = el.textContent!.replace(/\s+/g, ' ').trim();
          const list = w.__seen[id];
          if (t && list[list.length - 1] !== t) list.push(t);
        }
      }
      const n = document.querySelector('[data-testid="now"]');
      if (n) {
        const visible = (b: Element) => !!((b as HTMLElement).offsetWidth || (b as HTMLElement).offsetHeight || (b as HTMLElement).getClientRects().length);
        const buttons = [...document.querySelectorAll('main button')].filter(visible).filter((b) => (b as HTMLElement).dataset['testid'] !== 'show-sign-in-tab').map((b) => b.textContent!.trim());
        const last = w.__buttons[w.__buttons.length - 1];
        const t = n.textContent!.trim();
        if (!last || last.now !== t || last.buttons.join('|') !== buttons.join('|')) w.__buttons.push({ now: t, buttons });
      }
    };
    sample();
    new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  }, testids);
}
export const seen = (page: Page, id = 'now'): Promise<string[]> => page.evaluate((i) => (window as any).__seen?.[i] || [], id);
export const buttonsSeen = (page: Page): Promise<{ now: string; buttons: string[] }[]> => page.evaluate(() => (window as any).__buttons || []);

// The latest report for a dashboard's working directory, from the tool's own folder for it.
export const readReport = (cwd: string, home?: string) => JSON.parse(readFileSync(join(dirsOf(cwd, home).report, 'report.json'), 'utf8'));

// Chrome processes started by the CLI: their profile is a11y-508-* in the temp directory.
export function cliChromePids(): number[] {
  return (processList() as string)
    .split(/\r?\n/)
    .filter((l) => /--user-data-dir=\S*a11y-508-[A-Za-z0-9]+/.test(l) && /--remote-debugging-pipe/.test(l))
    .map((l) => parseInt(l.trim(), 10));
}

export function gitRepo(dir: string): (...args: string[]) => string {
  const g = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'dash-test@example.test');
  g('config', 'user.name', 'dash test');
  g('config', 'commit.gpgsign', 'false');
  return g;
}

export const exists = existsSync;

// A child process run without blocking this process, which also serves the fixture site.
export function run(file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<{ status: number | null; output: string; stdout: string }> {
  return new Promise((ok) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stdout = '';
    child.stdout!.on('data', (d) => {
      output += d;
      stdout += d;
    });
    child.stderr!.on('data', (d) => (output += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeout || 280_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      ok({ status, output, stdout });
    });
  });
}

// Every name of a button the dashboard no longer has (docs/plans/turnkey-loop.md AC 1 / guard a).
export const REMOVED_BUTTONS = /Try again|Continue|Start over|verify now|Keep waiting|Verify anyway|Stop waiting|without waiting|Sign in and continue|Start anyway|Crawl again|Deployed|Clear history|Clear fix-loop history|Troubleshoot with these settings|Run again|Fix the violations|Check now|Copy summary/;

// The one screen asks nothing (docs/plans/simple-screen.md guard a): one button (Start or Stop),
// apart from Show the sign-in tab; no steps; none of the removed buttons.
export async function asksNothing(page: Page): Promise<void> {
  await expect(page.getByRole('navigation', { name: 'Steps' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: REMOVED_BUTTONS })).toHaveCount(0);
  // The screen has rendered its button before the buttons are counted.
  await expect(go(page)).toBeVisible();
  const buttons = page.locator('main button:visible:not([data-testid="show-sign-in-tab"])');
  expect(await buttons.count(), (await buttons.allTextContents()).join(' | ')).toBe(1);
  await expect(go(page)).toHaveText(/^(Start|Stop)$/);
}

// The current run's events so far, from its stream (it replays them, then stays open while the run goes on).
export async function runEvents(dash: Dash, ms = 2000): Promise<any[]> {
  const ctrl = new AbortController();
  const stop = setTimeout(() => ctrl.abort(), ms);
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
  return text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
}
