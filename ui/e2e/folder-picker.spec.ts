// The folder picker: the app's repository folder in Set up (Browse…; Change folder or URL on
// Diagnostics), the dialog that browses the machine's folders, the folder named on the one screen,
// and the switch that every screen follows.

import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { goInApp, go, home, moreOptions, loopOptions, now, api, dashboard, fillRun, fixtureSite, open, startFromRun, waitFinished, MAIN, QUICK, TOKEN, WIN, tempDir, type Dash, removeTemp } from './harness';
// @ts-ignore -- plain JS shared with the server's node:test suite
import { mergeEnv, unreadableDir } from '../server/test/platform.mjs';

const NAME = "Choose the app's repository folder";
const URL0 = 'http://127.0.0.1:9/';
const dialog = (page: Page) => page.getByRole('dialog', { name: NAME });
const setup = (page: Page) => page.getByRole('dialog', { name: 'Set up' });
const change = (page: Page) => setup(page).getByTestId('browse');
// Set up, opened from Diagnostics (Change folder or URL).
async function openSetup(page: Page): Promise<void> {
  if (await setup(page).isVisible()) return;
  await goInApp(page, '/diagnostics');
  await page.getByTestId('change-setup').click();
  await expect(setup(page)).toBeVisible();
}
async function closeSetup(page: Page): Promise<void> {
  if (!(await setup(page).isVisible())) return;
  await page.keyboard.press('Escape');
  await expect(setup(page)).toBeHidden();
}
// The folder: the Set up field while Set up is open; the one screen's folder; Diagnostics' Folder.
async function expectCwd(page: Page, path: string): Promise<void> {
  if (await setup(page).isVisible()) return void (await expect(setup(page).getByTestId('setup-folder')).toHaveValue(path));
  if (new URL(page.url()).pathname === '/diagnostics') return void (await expect(page.getByTestId('d-folder')).toHaveText(path));
  if (new URL(page.url()).pathname === '/advanced') return void (await expect(page.getByTestId('command-cwd')).toHaveText(path));
  await expect(page.getByTestId('folder')).toHaveAttribute('title', path);
}
const options = (page: Page) => dialog(page).getByRole('option');
const listLabel = (page: Page) => dialog(page).locator('#picker-list-label');
const crumbs = (page: Page) => dialog(page).getByRole('navigation', { name: 'Folder path' }).getByRole('button');

// A report.json as the CLI writes it, small enough to write by hand.
function writeReport(dir: string, baseUrl: string): void {
  mkdirSync(join(dir, 'a11y-508-report'), { recursive: true });
  const finding = { test: '7.A', name: 'Meaningful image name', wcag: '1.1.1', level: 'violation', impact: 'serious', message: `image without alt on ${baseUrl}`, selector: 'img' };
  writeFileSync(
    join(dir, 'a11y-508-report', 'report.json'),
    JSON.stringify({
      baseUrl, startedAt: '2026-03-01T00:00:00.000Z', finishedAt: '2026-03-01T00:01:00.000Z', passed: false, options: { failOn: ['critical', 'serious'] },
      summary: { pages: 1, audited: 1, failed: 0, skipped: 0, violations: 1, reviews: 0, byImpact: { critical: 0, serious: 1, moderate: 0, minor: 0 }, byTest: { '7.A': { violations: 1, reviews: 0 } }, coverage: { complete: true, warnings: [], notes: [] } },
      site: { findings: [] }, manual: [], catalog: {}, pages: [{ url: baseUrl, finalUrl: baseUrl, title: 'Home', status: 200, findings: [finding] }],
    })
  );
}
function writeLedger(dir: string): void {
  mkdirSync(join(dir, 'a11y-508-work'), { recursive: true });
  const e = { status: 'open', test: '7.A', impact: 'serious', message: 'image without alt', pages: ['http://a.example/'], attempts: [], selector: 'img' };
  writeFileSync(join(dir, 'a11y-508-work', 'ledger.json'), JSON.stringify({ version: 1, rounds: [], findings: { a: e } }));
}

async function openPicker(page: Page): Promise<void> {
  await openSetup(page);
  await change(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(listLabel(page)).toHaveText(/^Folders in /);
}

// Browses to a path by typing it, as a person pasting one would.
async function browseTo(page: Page, path: string): Promise<void> {
  const field = dialog(page).getByLabel('Path', { exact: true });
  await field.fill(path);
  await field.press('Enter');
  await expect(listLabel(page)).toHaveText(`Folders in ${path}`);
}

// Chooses a folder in Set up (Browse…), closes Set up, and is back on the screen it was called
// from, which follows the switch.
async function chooseDir(page: Page, path: string): Promise<void> {
  const from = new URL(page.url()).pathname;
  await openPicker(page);
  await browseTo(page, path);
  await dialog(page).getByRole('button', { name: 'Choose this folder' }).click();
  await expect(dialog(page)).toBeHidden();
  await expectCwd(page, path);
  await closeSetup(page);
  await goInApp(page, from);
  await expectCwd(page, path);
}

const cwdNow = async (dash: Dash) => (await api(dash, '/api/env')).json.cwd;

let dirs: string[] = [];
const dir = (prefix: string) => {
  const d = tempDir(prefix);
  dirs.push(d);
  return d;
};
let dashes: Dash[] = [];
const start = async (opts: Parameters<typeof dashboard>[0] = {}) => {
  const d = await dashboard({ cwd: opts.cwd || dir('a11y-508-pick-launch-'), ...opts });
  dashes.push(d);
  return d;
};
test.afterEach(async () => {
  for (const d of dashes) await d.stop();
  for (const d of dirs) removeTemp(d);
  dashes = [];
  dirs = [];
});

test('AC 1: the one screen names the folder; Set up (Change folder or URL) shows it with Browse…; Browse… opens a named modal dialog with focus inside; Escape closes it and returns focus', async ({ page }) => {
  const dash = await start();
  await open(page, dash, '/', { url: URL0 });
  await expect(page.getByTestId('folder')).toHaveAttribute('title', dash.cwd);
  await expect(page.getByTestId('folder')).toContainText(dash.cwd);
  await openSetup(page);
  await expect(setup(page).getByTestId('setup-folder')).toHaveValue(dash.cwd);
  await expect(change(page)).toBeEnabled();
  await change(page).click();
  await expect(dialog(page)).toBeVisible();
  // Modal: a native <dialog> in the top layer, with focus inside it.
  expect(await dialog(page).evaluate((d: HTMLDialogElement) => d.localName === 'dialog' && d.open && d.matches(':modal'))).toBe(true);
  await expect.poll(() => dialog(page).evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(change(page)).toBeFocused();
  // Cancel closes it the same way.
  await change(page).click();
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(change(page)).toBeFocused();
});

test('AC 2: the dialog lists subdirectories by name, no files, hidden ones only on request, each with its facts', async ({ page }) => {
  const launch = dir('a11y-508-pick-launch-');
  for (const d of ['gamma', 'beta', 'Alpha', '.secret']) mkdirSync(join(launch, d));
  writeFileSync(join(launch, 'notes.txt'), 'a file, never listed');
  mkdirSync(join(launch, 'Alpha', '.git'));
  writeReport(join(launch, 'beta'), 'http://beta.example/');
  const dash = await start({ cwd: launch });
  await open(page, dash, '/', { url: URL0 });
  await openPicker(page);
  await expect(listLabel(page)).toHaveText(`Folders in ${launch}`);
  const names = options(page).locator('.dir-name');
  await expect(names).toHaveText(['Alpha', 'beta', 'gamma']);
  await expect(dialog(page).getByText('notes.txt')).toHaveCount(0);
  await expect(options(page).filter({ hasText: 'Alpha' }).locator('.badge')).toHaveText(['git']);
  await expect(options(page).filter({ hasText: 'beta' }).locator('.badge')).toHaveText(['report']);
  await expect(options(page).filter({ hasText: 'gamma' }).locator('.badge')).toHaveCount(0);
  // Hidden folders: off by default, on with the checkbox, and remembered.
  const hidden = dialog(page).getByLabel('Show hidden folders');
  await expect(hidden).not.toBeChecked();
  await hidden.check();
  await expect(names).toHaveText(['.secret', 'Alpha', 'beta', 'gamma']);
  await page.keyboard.press('Escape');
  await page.reload();
  await openPicker(page);
  await expect(dialog(page).getByLabel('Show hidden folders')).toBeChecked();
  await expect(names).toHaveText(['.secret', 'Alpha', 'beta', 'gamma']);
  await dialog(page).getByLabel('Show hidden folders').uncheck();
  await expect(names).toHaveText(['Alpha', 'beta', 'gamma']);
});

test('AC 3: opening a row browses in and the breadcrumbs grow; a breadcrumb browses back; the top lists the roots', async ({ page }) => {
  const launch = dir('a11y-508-pick-launch-');
  mkdirSync(join(launch, 'one', 'two', 'three'), { recursive: true });
  mkdirSync(join(launch, 'other'));
  const dash = await start({ cwd: launch });
  await open(page, dash, '/', { url: URL0 });
  await openPicker(page);
  const n = await crumbs(page).count();
  // Double-click opens a row.
  await options(page).filter({ hasText: 'one' }).dblclick();
  await expect(listLabel(page)).toHaveText(`Folders in ${join(launch, 'one')}`);
  await expect(crumbs(page)).toHaveCount(n + 1);
  await expect(crumbs(page).last()).toHaveText('one');
  await expect(crumbs(page).last()).toHaveAttribute('aria-current', 'location');
  // The keyboard: arrows move, Enter opens.
  const list = dialog(page).getByRole('listbox');
  await list.focus();
  await expect(options(page).first()).toHaveAttribute('aria-selected', 'true');
  await list.press('Enter');
  await expect(listLabel(page)).toHaveText(`Folders in ${join(launch, 'one', 'two')}`);
  await expect(crumbs(page)).toHaveCount(n + 2);
  // The Open button opens the selected row.
  await dialog(page).getByRole('button', { name: 'Open the selected folder' }).click();
  await expect(listLabel(page)).toHaveText(`Folders in ${join(launch, 'one', 'two', 'three')}`);
  await expect(crumbs(page)).toHaveCount(n + 3);
  // A breadcrumb browses back to that ancestor.
  await crumbs(page).nth(n - 1).click();
  await expect(listLabel(page)).toHaveText(`Folders in ${launch}`);
  await expect(crumbs(page)).toHaveCount(n);
  await expect(options(page).locator('.dir-name')).toHaveText(['one', 'other']);
  // The arrows move the selection.
  await list.focus();
  await list.press('ArrowDown');
  await expect(options(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(list).toHaveAttribute('aria-activedescendant', (await options(page).nth(1).getAttribute('id'))!);
  // The first crumb lists the roots.
  await crumbs(page).first().click();
  await expect(listLabel(page)).toHaveText(/^Folders in (This computer|All drives)$/);
  const roots = await options(page).locator('.dir-name').allTextContents();
  if (WIN) {
    for (const r of roots) expect(r).toMatch(/^[A-Z]:\\$/);
    expect(roots).toContain(`${(process.env.SystemDrive || 'C:').toUpperCase()}\\`);
  } else {
    expect(roots).toEqual(['/']);
  }
  await expect(dialog(page).getByRole('button', { name: 'Choose this folder' })).toBeDisabled();
});

test('AC 4: a typed path browses there, ~ is home; a missing path or a file shows the server message and changes nothing; a folder gone before Choose is refused', async ({ page }) => {
  const launch = dir('a11y-508-pick-launch-');
  mkdirSync(join(launch, 'here'));
  const target = dir('a11y-508-pick-target-');
  mkdirSync(join(target, 'inside'));
  writeFileSync(join(target, 'file.txt'), 'x');
  const dash = await start({ cwd: launch });
  await open(page, dash, '/', { url: URL0 });
  await openPicker(page);
  await browseTo(page, target);
  await expect(dialog(page).getByLabel('Path', { exact: true })).toHaveValue(target);
  await expect(options(page).locator('.dir-name')).toHaveText(['inside']);
  // ~ with the Go button.
  await dialog(page).getByLabel('Path', { exact: true }).fill('~');
  await dialog(page).getByRole('button', { name: 'Go to this path' }).click();
  const home = realpathSync(homedir());
  await expect(listLabel(page)).toHaveText(`Folders in ${home}`);
  await browseTo(page, target);
  // Errors: inline, the listing as it was, the working directory as it was.
  for (const [bad, message] of [[join(target, 'missing'), /ENOENT/], [join(target, 'file.txt'), /ENOTDIR/]] as const) {
    await dialog(page).getByLabel('Path', { exact: true }).fill(bad);
    await dialog(page).getByLabel('Path', { exact: true }).press('Enter');
    await expect(dialog(page).getByTestId('picker-error')).toHaveText(message);
    await expect(dialog(page).getByLabel('Path', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(listLabel(page)).toHaveText(`Folders in ${target}`);
    await expect(options(page).locator('.dir-name')).toHaveText(['inside']);
    expect(await cwdNow(dash)).toBe(launch);
    await expectCwd(page, launch);
  }
  // The server checks the path it is asked to switch to, not what the page saw.
  await browseTo(page, join(target, 'inside'));
  removeTemp(join(target, 'inside'));
  await dialog(page).getByRole('button', { name: 'Choose this folder' }).click();
  await expect(dialog(page).getByTestId('picker-error')).toHaveText(/ENOENT/);
  await expect(dialog(page)).toBeVisible();
  expect(await cwdNow(dash)).toBe(launch);
  await expectCwd(page, launch);
});

test('AC 5: Choose switches the server, the one screen, Diagnostics (its report, config and ledger) and Advanced', async ({ page }) => {
  const launch = dir('a11y-508-pick-launch-');
  writeReport(launch, 'http://launch.example/');
  const a = dir('a11y-508-pick-a-');
  writeReport(a, 'http://a.example/');
  writeFileSync(join(a, 'a11y-508.config.json'), JSON.stringify({ url: 'http://a.example/start', check: 'npm test' }));
  writeLedger(a);
  const b = dir('a11y-508-pick-b-');
  const dash = await start({ cwd: launch });
  await open(page, dash, '/diagnostics', { url: URL0 });
  await expect(page.getByTestId('diagnostics-page')).toContainText('http://launch.example/');
  // Switching while Diagnostics is open reads it again in place.
  await chooseDir(page, a);
  expect(await cwdNow(dash)).toBe(a);
  await expect(page.getByTestId('d-finding')).toHaveText([/image without alt on http:\/\/a\.example\//]);
  await expect(page.getByTestId('d-config')).toContainText('"url": "http://a.example/start"');
  await expect(page.getByTestId('d-config')).toContainText('"check": "npm test"');
  await expect(page.getByTestId('d-counts-line')).toHaveText('1 found');
  await loopOptions(page);
  await expect(page.getByLabel('Start URL')).toHaveValue('http://a.example/start');
  await expect(page.getByLabel('Check command (build and test)')).toHaveValue('npm test');
  // An edit in progress is discarded by a switch, with no prompt.
  await page.getByLabel('Check command (build and test)').fill('edited, never saved');
  await chooseDir(page, b);
  await expect(page.getByLabel('Start URL')).toHaveValue('');
  await expect(page.getByLabel('Check command (build and test)')).toHaveValue('');
  await home(page);
  await expect(now(page)).toHaveText(/nothing will be fixed: fixing needs the app's git repository, and this folder is not one\.$/);
  // A subfolder of a repository is inside one, as the loop sees it.
  mkdirSync(join(b, '.git'));
  mkdirSync(join(b, 'packages', 'web'), { recursive: true });
  await chooseDir(page, join(b, 'packages', 'web'));
  await expect(now(page)).not.toHaveText(/this folder is not one/);
  await chooseDir(page, b);
  await goInApp(page, '/diagnostics');
  await expect(page.getByTestId('diagnostics-page')).toContainText('No report yet.');
  await expect(page.getByTestId('diagnostics-page')).toContainText('No rounds yet.');
});

test('AC 6: after a switch a crawl writes its report in the new directory only, and Advanced names it and reads its config', async ({ page }) => {
  test.setTimeout(420_000);
  const site = await fixtureSite();
  try {
    const launch = dir('a11y-508-pick-launch-');
    const b = dir('a11y-508-pick-b-');
    writeFileSync(join(b, 'a11y-508.config.json'), JSON.stringify({ url: site.base + 'about.html', args: ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots'] }));
    const dash = await start({ cwd: launch });
    await open(page, dash, '/', { url: URL0 });
    await chooseDir(page, b);
    await fillRun(page, { url: site.base, token: TOKEN, ...QUICK });
    await moreOptions(page);
    await expect(page.getByTestId('command-cwd')).toHaveText(b);
    await expect(page.getByTestId('command')).toContainText(site.base);
    await expect(page.getByLabel('Start URL')).toHaveValue(site.base + 'about.html');
    await startFromRun(page);
    await waitFinished(page);
    expect(existsSync(join(dash.dirs(b).report, 'report.json')), 'report.json in the new directory\'s own folder').toBe(true);
    expect(existsSync(dash.dirs(launch).report), 'nothing in the old one').toBe(false);
    for (const d of [b, launch]) expect(existsSync(join(d, 'a11y-508-report')), `nothing of the tool's in ${d}`).toBe(false);
  } finally {
    site.close();
  }
});

test('AC 7: while a run is active Browse… is disabled with a reason and PUT /api/cwd is 409; afterwards it is enabled', async ({ page }) => {
  const { createServer } = await import('node:http');
  const hang = createServer(() => {});
  await new Promise<void>((ok) => hang.listen(0, '127.0.0.1', ok));
  try {
    const launch = dir('a11y-508-pick-launch-');
    const other = dir('a11y-508-pick-b-');
    const dash = await start({ cwd: launch });
    await open(page, dash, '/', { url: `http://127.0.0.1:${(hang.address() as any).port}/` });
    await moreOptions(page);
    await page.getByLabel('No sign-in').check();
    await startFromRun(page);
    await openSetup(page);
    await expect(change(page)).toBeDisabled();
    await expect(change(page)).toHaveAttribute('title', /run is active/);
    await expect(change(page)).toHaveAccessibleDescription(/run is active/);
    const r = await api(dash, '/api/cwd', { method: 'PUT', body: { path: other } });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/run is active/);
    expect(await cwdNow(dash)).toBe(launch);
    await closeSetup(page);
    await home(page);
    await go(page).click();
    await expect(now(page)).toHaveText('Stopped', { timeout: 30_000 });
    await openSetup(page);
    await expect(change(page)).toBeEnabled();
    await chooseDir(page, other);
    expect(await cwdNow(dash)).toBe(other);
  } finally {
    hang.closeAllConnections?.();
    hang.close();
  }
});

test('AC 8: after a switch there is no current run, and the one screen is ready in the new folder instead of showing the old directory\'s run', async ({ page }) => {
  const launch = dir('a11y-508-pick-launch-');
  const other = dir('a11y-508-pick-b-');
  const dash = await start({ cwd: launch });
  await open(page, dash, '/', { url: URL0 });
  await moreOptions(page);
  await page.getByLabel('No sign-in').check();
  await page.getByLabel('Maximum pages').fill('1');
  await startFromRun(page);
  await waitFinished(page);
  expect((await api(dash, '/api/runs/current')).json).not.toBe(null);
  await chooseDir(page, other);
  expect((await api(dash, '/api/runs/current')).json).toBe(null);
  await expect(now(page)).toHaveText(/^Ready to crawl 127\.0\.0\.1:9/);
  await expect(go(page)).toHaveText('Start');
  // A fresh page asks the server, and the server has forgotten it too.
  await page.reload();
  await expect(now(page)).toHaveText(/^Ready to crawl 127\.0\.0\.1:9/);
});

test('AC 9: recent directories survive a reload, most recent first, each one activation away; a deleted one is marked missing', async ({ page }) => {
  const launch = dir('a11y-508-pick-launch-');
  const a = dir('a11y-508-pick-a-');
  const b = dir('a11y-508-pick-b-');
  const c = dir('a11y-508-pick-c-');
  mkdirSync(join(a, 'in-a'));
  const dash = await start({ cwd: launch });
  await open(page, dash, '/', { url: URL0 });
  await chooseDir(page, c);
  await chooseDir(page, a);
  await chooseDir(page, b);
  removeTemp(c);
  await page.reload();
  await openPicker(page);
  const recents = dialog(page).getByTestId('recents').locator('li');
  await expect(recents.getByRole('button')).toHaveText([b, a, c]);
  await expect(recents.filter({ hasText: c }).getByTestId('recent-missing')).toHaveText('missing');
  await expect(recents.filter({ hasText: a }).getByTestId('recent-missing')).toHaveCount(0);
  await recents.getByRole('button', { name: a, exact: true }).click();
  await expect(listLabel(page)).toHaveText(`Folders in ${a}`);
  await expect(options(page).locator('.dir-name')).toHaveText(['in-a']);
  await recents.getByRole('button', { name: c, exact: true }).click();
  await expect(dialog(page).getByTestId('picker-error')).toHaveText(/ENOENT/);
  await expect(listLabel(page)).toHaveText(`Folders in ${a}`);
});

// main.mjs started directly: how it ended, or that it started.
function launchMain(args: string[], cwd: string): Promise<{ started: boolean; code: number | null; out: string }> {
  return new Promise((ok) => {
    const proc = spawn(process.execPath, [MAIN, '--no-open', '--port', '0', ...args], { cwd, env: mergeEnv(process.env, { TOKEN: '' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout!.on('data', (d) => {
      out += d;
      if (/open: http/.test(out)) proc.kill('SIGKILL');
    });
    proc.stderr!.on('data', (d) => (out += d));
    proc.on('exit', (code) => ok({ started: /open: http/.test(out), code, out }));
  });
}

test('AC 10: --dir starts in that directory, relative to the launch directory; a file or a missing path refuses to start; Back to where I started returns', async ({ page }) => {
  const parent = dir('a11y-508-pick-parent-');
  mkdirSync(join(parent, 'repo'));
  writeFileSync(join(parent, 'file.txt'), 'x');
  writeReport(join(parent, 'repo'), 'http://repo.example/');
  for (const [arg, reason] of [['file.txt', /ENOTDIR/], ['missing', /ENOENT/]] as const) {
    const r = await launchMain(['--dir', arg], parent);
    expect(r.started, r.out).toBe(false);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`error: --dir ${arg}: `);
    expect(r.out).toMatch(reason);
  }
  const other = dir('a11y-508-pick-b-');
  const dash = await start({ cwd: parent, args: ['--dir', 'repo'] });
  const repo = join(parent, 'repo');
  expect(await cwdNow(dash)).toBe(repo);
  await open(page, dash, '/diagnostics', { url: URL0 });
  await expectCwd(page, repo);
  await expect(page.getByTestId('diagnostics-page')).toContainText('http://repo.example/');
  await openPicker(page);
  await expect(dialog(page).getByRole('button', { name: 'Back to where I started' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await closeSetup(page);
  await chooseDir(page, other);
  await expect(page.getByTestId('diagnostics-page')).toContainText('No report yet.');
  await openPicker(page);
  await dialog(page).getByRole('button', { name: 'Back to where I started' }).click();
  await expect(dialog(page)).toBeHidden();
  expect(await cwdNow(dash)).toBe(repo);
  await expectCwd(page, repo);
  await closeSetup(page);
  await expect(page.getByTestId('diagnostics-page')).toContainText('http://repo.example/');
});

test('AC 11: /api/dirs and /api/cwd need the secret and a local Host; an unreadable directory is refused with a message and the server keeps serving', async ({ page }) => {
  const launch = dir('a11y-508-pick-launch-');
  const dash = await start({ cwd: launch });
  for (const [method, path, body] of [['GET', '/api/dirs'], ['GET', `/api/dirs?path=${encodeURIComponent(launch)}`], ['PUT', '/api/cwd', { path: launch }]] as const) {
    const res = await fetch(dash.origin + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} });
    expect(res.status, `${method} ${path} without the secret`).toBe(401);
  }
  // fetch cannot forge Host; node:http can.
  const { request } = await import('node:http');
  const foreign = (method: string, path: string) =>
    new Promise<number>((ok, fail) => {
      const u = new URL(dash.origin);
      const req = request({ host: '127.0.0.1', port: Number(u.port), path, method, headers: { host: 'evil.example', 'x-a11y-508-secret': dash.secret } }, (res) => {
        res.resume();
        ok(res.statusCode!);
      });
      req.on('error', fail);
      req.end(method === 'PUT' ? JSON.stringify({ path: launch }) : undefined);
    });
  expect(await foreign('GET', '/api/dirs')).toBe(403);
  expect(await foreign('PUT', '/api/cwd')).toBe(403);
  expect(await cwdNow(dash)).toBe(launch);

  const locked: any = unreadableDir(launch);
  test.skip(!locked, 'running as root: every directory is readable');
  try {
    const r = await api(dash, `/api/dirs?path=${encodeURIComponent(locked.path)}`);
    expect(r.status, r.text).toBe(locked.status);
    expect(r.json.error).toMatch(WIN ? /ENOENT/ : /EACCES|EPERM/);
    expect((await api(dash, '/api/env')).status, 'the server keeps serving').toBe(200);
    // The same through the dialog: the message inline, the server still answering.
    await open(page, dash, '/', { url: URL0 });
    await openPicker(page);
    await dialog(page).getByLabel('Path', { exact: true }).fill(locked.path);
    await dialog(page).getByLabel('Path', { exact: true }).press('Enter');
    await expect(dialog(page).getByTestId('picker-error')).toHaveText(r.json.error);
    await browseTo(page, launch);
  } finally {
    locked.cleanup();
  }
});
