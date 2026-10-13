// The Playwright harness: the fixture site (test/fixture-site.mjs), the real
// dashboard server in a temporary working directory, and helpers that drive
// the app the way a person does.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
// @ts-ignore -- plain JS shared with the server's node:test suite
import { mergeEnv, processList, stopTree } from '../server/test/platform.mjs';
// @ts-ignore
export { WIN, exePath, gitBash, loginShell, msysPath, npmBin, processList, quote, recordOpen, shellLine, shPath, stopTree, stub, stubScript, systemPath } from '../server/test/platform.mjs';

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

export const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

export interface Dash {
  origin: string;
  url: string;
  secret: string;
  cwd: string;
  proc: ChildProcess;
  output(): string;
  stop(): Promise<void>;
}

export async function dashboard(opts: { cwd?: string; env?: NodeJS.ProcessEnv; args?: string[]; main?: string; keepCwd?: boolean } = {}): Promise<Dash> {
  const cwd = opts.cwd || tempDir('a11y-508-dash-');
  const proc = spawn(process.execPath, [opts.main || MAIN, '--no-open', '--port', '0', ...(opts.args || [])], {
    cwd,
    // The dashboard's own files (config, session, settings) go to a home of the test's, never ~/.a11y-508.
    env: mergeEnv(process.env, { TOKEN: '', A11Y_508_HOME: tempDir('a11y-508-home-'), ...opts.env }),
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
    origin: u.origin, url, secret, cwd, proc,
    output: () => out,
    stop: async () => {
      await stopTree(proc);
      // Windows releases a killed process's hold on its working directory a little later.
      if (opts.keepCwd || opts.cwd) return;
      try {
        rmSync(cwd, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
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
// dialog) and every step's Details is open (the full views the specs check). { fresh: true } opens
// it as a first visit, with nothing remembered.
export async function open(page: Page, dash: Dash, path = '/run', opts: { fresh?: boolean; details?: boolean } = {}): Promise<void> {
  if (!opts.fresh) {
    const details = opts.details !== false;
    // The server's working directory (it may have been started with --dir).
    const cwd = (await api(dash, '/api/env')).json.cwd;
    await page.addInitScript(([cwd, details, origin]) => {
      // Only for this dashboard: a page can open several (each its own origin).
      if (location.origin !== origin) return;
      try {
        if (!localStorage.getItem('a11y508.cwd')) localStorage.setItem('a11y508.cwd', cwd);
        // A returning viewer who looks at the Crawl step after a crawl: it stays there when the
        // crawl finishes (the wizard's own move to Results is tested with details: false).
        if (details && localStorage.getItem('a11y508.stayOnCrawl') === null) localStorage.setItem('a11y508.stayOnCrawl', '1');
        for (const k of ['crawl', 'results', 'fix', 'output', 'history']) if (localStorage.getItem(`a11y508.details.${k}`) === null) localStorage.setItem(`a11y508.details.${k}`, details ? '1' : '0');
      } catch {}
    }, [cwd, details, dash.origin] as [string, boolean, string]);
  }
  await page.goto(`${dash.origin}${path}#secret=${dash.secret}`);
  await expect(page.locator('h1')).toBeVisible();
}

// The wizard's steps, by the names the specs used for the old nav tabs.
const STEP_OF: Record<string, [string, string]> = {
  Run: ['Set up', '/run'], 'Set up': ['Set up', '/run'],
  'Live run': ['Crawl', '/live'], Crawl: ['Crawl', '/live'],
  Report: ['Results', '/report'], Results: ['Results', '/report'],
  'Fix loop': ['Fix', '/fix-loop'], Fix: ['Fix', '/fix-loop'],
  History: ['History', '/history'],
  Troubleshoot: ['', '/troubleshoot'],
};

// Navigates inside the app through the stepper's real links; a step that is not available yet
// (or a screen that is not a step, Troubleshoot) is opened by its address, in-app.
export async function nav(page: Page, label: string): Promise<void> {
  const [step, path] = STEP_OF[label] || [label, ''];
  const link = step ? page.getByRole('navigation', { name: 'Steps' }).getByRole('link', { name: new RegExp(`^\\W*\\d?\\s*${step}\\b`) }) : null;
  if (link && (await link.count())) await link.first().click();
  else await goInApp(page, path);
}

export interface CrawlForm {
  url: string;
  token?: string;
  maxPages?: number;
  failOn?: string;
  advanced?: Record<string, string | boolean>;
}

// In-app navigation to a route nothing links to (the app keeps its state, as a click on a link would).
export async function goInApp(page: Page, path: string): Promise<void> {
  if (new URL(page.url()).pathname === path) return;
  await page.evaluate((p) => {
    history.pushState(null, '', p);
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  }, path);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[/]/g, '\\/')}$`));
}

// The Run screen's settings beyond the start URL (auth choices, Advanced, the command line), at
// /run/advanced, which nothing links to.
export async function moreOptions(page: Page): Promise<void> {
  await goInApp(page, '/run/advanced');
  await expect(page.getByTestId('more-options')).toBeVisible();
}

// The Fix loop's settings (every loop setting, and the dry run), at /fix-loop/settings.
export async function loopOptions(page: Page): Promise<void> {
  await goInApp(page, '/fix-loop/settings');
  await expect(page.getByTestId('loop-more')).toBeVisible();
}

// The Fix loop's assistant picker, behind "change" once an assistant is installed.
export async function openPicker(page: Page): Promise<void> {
  const picker = page.getByTestId('picker');
  // Once the assistants are detected the line says which one fixes, or that none is installed.
  await expect(page.getByTestId('assistant-line')).toHaveText(/Fixing with|No assistant/, { timeout: 60_000 });
  if (await picker.isVisible()) return;
  await page.getByRole('button', { name: 'change the assistant' }).click();
  await expect(picker).toBeVisible();
}

// A dry run, from the Fix loop's More options.
export async function dryRun(page: Page): Promise<void> {
  await loopOptions(page);
  await page.getByRole('button', { name: 'Record findings without fixing' }).click();
}

export async function fillRun(page: Page, f: CrawlForm): Promise<void> {
  // The Run screen can still be re-rendering the previous run's settings when the field is
  // filled, which left both URLs in it once ("…about.html…tables.html"): fill until it holds this one.
  const url = page.getByLabel('Start URL');
  await expect(async () => {
    await url.fill(f.url);
    await expect(url).toHaveValue(f.url, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  if (f.token !== undefined || f.maxPages || f.failOn || (f.advanced && Object.keys(f.advanced).length)) await moreOptions(page);
  if (f.token !== undefined) {
    await page.getByLabel('A token').check();
    await page.getByLabel(/^Token \(sent as/).fill(f.token);
  }
  if (f.maxPages) await page.getByLabel('Maximum pages').fill(String(f.maxPages));
  if (f.failOn) await page.getByLabel('Fail on impacts').fill(f.failOn);
  if (f.advanced && Object.keys(f.advanced).length) {
    const adv = page.locator('details.advanced');
    if (!(await adv.evaluate((d: HTMLDetailsElement) => d.open))) await adv.locator('summary').click();
    for (const [flag, v] of Object.entries(f.advanced)) {
      const el = page.locator(`#adv-${flag}`);
      if (typeof v === 'boolean') await el.setChecked(v);
      else await el.fill(v);
    }
  }
}

// The fixture crawl most tests use: small, but with screenshots.
export const QUICK = { maxPages: 5, advanced: { 'no-zoom': true, 'max-screenshots': '3' } };

export async function startFromRun(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page).toHaveURL(/\/live$/);
  // The Live screen can still show the previous run's "Finished" until the
  // store sees the new run, and waitFinished would accept that at once. A run
  // cannot finish before this is observed: the browser alone takes seconds.
  await expect(status(page)).toHaveText(/^(Running|Stopping)/, { timeout: 60_000 });
}

export const status = (page: Page) => page.getByTestId('run-status');

// A finished crawl moves the wizard on to Results; the specs look at the Crawl step afterwards,
// so this comes back to it (in-app, as the stepper's Crawl link does).
export async function waitFinished(page: Page, timeout = 280_000): Promise<string> {
  await expect
    .poll(async () => {
      if (new URL(page.url()).pathname.startsWith('/report')) return 'moved';
      const t = (await status(page).textContent({ timeout: 500 }).catch(() => '')) || '';
      return /^(Finished|Stopped|Failed)/.test(t) ? 'done' : 'running';
    }, { timeout, intervals: [250] })
    .not.toBe('running');
  if (new URL(page.url()).pathname.startsWith('/report')) await goInApp(page, '/live');
  await expect(status(page)).toHaveText(/^(Finished|Stopped|Failed)/, { timeout: 15_000 });
  return (await status(page).textContent()) || '';
}

// Opens the current step's Details disclosure (the full view), if it is closed.
export async function details(page: Page): Promise<void> {
  const d = page.getByTestId('details').first();
  if (!(await d.evaluate((x: HTMLDetailsElement) => x.open))) await d.locator('> summary').click();
  await expect(d).toHaveJSProperty('open', true);
}

export const readReport = (cwd: string, dir = 'a11y-508-report') => JSON.parse(readFileSync(join(cwd, dir, 'report.json'), 'utf8'));

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
