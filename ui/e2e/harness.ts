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
    env: mergeEnv(process.env, { TOKEN: '', ...opts.env }),
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

export async function open(page: Page, dash: Dash, path = '/run'): Promise<void> {
  await page.goto(`${dash.origin}${path}#secret=${dash.secret}`);
  await expect(page.locator('h1')).toBeVisible();
}

// Navigates inside the app through the nav's real links.
export async function nav(page: Page, label: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label, exact: true }).click();
}

export interface CrawlForm {
  url: string;
  token?: string;
  maxPages?: number;
  failOn?: string;
  advanced?: Record<string, string | boolean>;
}

export async function fillRun(page: Page, f: CrawlForm): Promise<void> {
  // The Run screen can still be re-rendering the previous run's settings when the field is
  // filled, which left both URLs in it once ("…about.html…tables.html"): fill until it holds this one.
  const url = page.getByLabel('Start URL');
  await expect(async () => {
    await url.fill(f.url);
    await expect(url).toHaveValue(f.url, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
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

export async function waitFinished(page: Page, timeout = 280_000): Promise<string> {
  await expect(status(page)).toHaveText(/^(Finished|Stopped|Failed)/, { timeout });
  return (await status(page).textContent()) || '';
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
