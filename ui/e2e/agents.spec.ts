// The fixing-assistant picker under Advanced, and the assistant a loop runs, with the harness
// controlling PATH, the shell, and npm through stub executables.

import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { openPicker, dashboard, fixtureSite, gitRepo, go, goInApp, now, open, stub, tempDir, api, useToken, type Dash, loginShell, npmBin, shPath, stubScript, systemPath, removeTemp } from './harness';

const PRESETS = {
  claude: 'claude -p --permission-mode acceptEdits --add-dir "{tasksDir}" --output-format stream-json --verbose "Read the file {promptFile} and do exactly what it says."',
  gemini: 'gemini --approval-mode auto_edit --include-directories "{tasksDir}" -p "Do exactly what the instructions above say." --output-format stream-json < "{promptFile}"',
};

interface Rig {
  root: string;
  pathBin: string;
  prefix: string;
  npmBin: string;
  shellName: string;
  record: string;
  mode: string;
  env: NodeJS.ProcessEnv;
}

// A machine in miniature: a PATH directory, an npm prefix, a login shell (a
// stub named bash, or Git Bash on Windows), and a stub npm whose behaviour is
// set by a mode file. Stubs are sh scripts on every platform (see stub()).
function rig(): Rig {
  const root = tempDir('a11y-508-rig-');
  const pathBin = join(root, 'path-bin');
  const prefix = join(root, 'npm-prefix');
  const bin = npmBin(prefix);
  const record = join(root, 'npm-calls.txt');
  const mode = join(root, 'npm-mode');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });
  writeFileSync(mode, 'ok');
  const shell = loginShell(root);
  const installs = ['claude', 'gemini', 'codex']
    .map((b) => `  ${b}) ${'\n'}${stubScript(bin, b, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9 (stub ' + b + ')"; fi\nexit 0\n')}  ;;`)
    .join('\n');
  stub(
    pathBin,
    'npm',
    `#!/bin/sh
if [ "$1" = "prefix" ]; then echo ${JSON.stringify(prefix)}; exit 0; fi
echo "$*" >> ${JSON.stringify(shPath(record))}
mode=$(cat ${JSON.stringify(shPath(mode))})
case "$3" in
  @anthropic-ai/claude-code) bin=claude ;;
  @google/gemini-cli) bin=gemini ;;
  @openai/codex) bin=codex ;;
esac
echo "npm install output for $3"
if [ "$mode" = "eacces" ]; then echo "npm ERR! code EACCES" >&2; echo "npm ERR! syscall mkdir" >&2; exit 1; fi
if [ "$mode" = "eacces-network" ]; then echo "npm ERR! code EACCES" >&2; echo "npm ERR! network request to the registry failed, reason: ETIMEDOUT" >&2; exit 1; fi
if [ "$mode" = "ok" ]; then
case "$bin" in
${installs}
esac
fi
echo "added 1 package in 1s"
exit 0
`
  );
  return {
    root, pathBin, prefix, npmBin: bin, shellName: shell.name, record, mode,
    env: { PATH: systemPath(pathBin), SHELL: shell.SHELL as string, HOME: join(root, 'home') },
  };
}
const cliStub = (r: Rig, dir: string, name: string): string =>
  stub(dir, name, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9 (stub ${name})"; exit 0; fi\necho "\${STUB_SELF:-$0} $*" >> ${JSON.stringify(shPath(join(r.root, name + '-calls.txt')))}\nexit 0\n`);

const entry = (page: Page, name: string) => page.getByTestId('picker').locator(`[data-preset="${name}"]`);
// The dashboard's loop config (kept in its own directory, not the repository).
const config = async (dash: Dash) => (await api(dash, '/api/config')).json.config;

test('AC 12: the picker under Advanced lists every preset, live or greyed as installed, and saves the choice; the first installed one runs when nothing is chosen', async ({ page }) => {
  const r = rig();
  const claude = cliStub(r, r.pathBin, 'claude');
  const gemini = cliStub(r, r.npmBin, 'gemini'); // only in npm prefix -g's bin directory
  // The app's repository (git and a package.json) with a session covering the start URL, so the
  // Fix button's state depends on the assistant alone.
  const cwd = tempDir('a11y-508-picker-');
  gitRepo(cwd);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app', scripts: { build: 'true' } }));
  const dash = await dashboard({ env: r.env, cwd });
  try {
    // The session (covering the start URL) and the loop config, where the dashboard keeps them.
    const sessionFile = (await api(dash, '/api/env')).json.session.file;
    mkdirSync(dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, JSON.stringify({ version: 1, origins: ['http://127.0.0.1:9'], cookies: [], storage: {} }));
    expect((await api(dash, '/api/config', { method: 'PUT', body: { config: { url: 'http://127.0.0.1:9/', check: 'true' } } })).status).toBe(200);
    await open(page, dash);
    // Claude Code is installed, so it is the one the loop runs; nothing asks.
    await expect(now(page)).toHaveText(/^Ready to crawl 127\.0\.0\.1:9 and fix what it finds\.$/, { timeout: 60_000 });
    await goInApp(page, '/diagnostics');
    await expect(page.getByTestId('d-assistant')).toHaveText(/^Runs: Claude Code \(claude\) · fallback: Gemini CLI$/, { timeout: 60_000 });
    await openPicker(page);
    await expect(page.getByTestId('picker').locator('.preset label')).toHaveCount(4);
    const names = await page.getByTestId('picker').locator('.preset label').allTextContents();
    expect(names).toEqual(['Claude Code', 'Gemini CLI', 'Codex', 'Custom command']);
    await expect(entry(page, 'claude').getByRole('radio')).toBeChecked();

    await expect(entry(page, 'claude')).toHaveAttribute('data-found', 'true');
    await expect(entry(page, 'claude').getByTestId('version')).toHaveText('9.9.9 (stub claude)');
    await expect(entry(page, 'claude').getByTestId('where')).toHaveText(claude);
    await expect(entry(page, 'claude').getByTestId('agent-command')).toHaveText(PRESETS.claude);
    await expect(entry(page, 'claude')).toContainText('found on PATH');

    await expect(entry(page, 'gemini')).toHaveAttribute('data-found', 'true');
    await expect(entry(page, 'gemini')).toContainText('found through npm prefix -g');
    await expect(entry(page, 'gemini').getByTestId('where')).toHaveText(gemini);
    await expect(entry(page, 'gemini').getByTestId('agent-command')).toHaveText(gemini + PRESETS.gemini.slice('gemini'.length));
    // By hand: the exact command for this machine, no placeholder, the resolved executable, the real prompt path.
    const byHand = entry(page, 'gemini').getByTestId('run-command');
    await expect(byHand).not.toContainText('{');
    await expect(byHand).toContainText(gemini);
    // The prompt file is in the tool's own folder for the repository, never in it.
    await expect(byHand).toContainText(join(dash.dirs().work, 'tasks', 'prompt.md'));
    await expect(byHand).toContainText('GEMINI_CLI_TRUST_WORKSPACE');

    await expect(entry(page, 'codex')).toHaveAttribute('data-found', 'false');
    await expect(entry(page, 'codex')).toHaveClass(/missing/);
    await expect(entry(page, 'codex')).toContainText('not installed');

    // A choice is saved, and the one screen says what it means.
    await entry(page, 'gemini').getByRole('radio').check();
    await expect.poll(async () => (await config(dash)).agent).toBe('gemini');
    expect((await api(dash, '/api/settings')).json.agent).toBe('gemini');
    await entry(page, 'codex').getByRole('radio').check();
    await expect.poll(async () => (await config(dash)).agent).toBe('codex');
    await goInApp(page, '/');
    await expect(now(page)).toHaveText(/^Ready to crawl 127\.0\.0\.1:9; nothing will be fixed: Codex is not installed\.$/);
    await openPicker(page);
    await entry(page, 'claude').getByRole('radio').check();
    await expect.poll(async () => (await config(dash)).agent).toBe('claude');
    await goInApp(page, '/');
    await expect(now(page)).toHaveText(/^Ready to crawl 127\.0\.0\.1:9 and fix what it finds\.$/);
  } finally {
    await dash.stop();
    removeTemp(cwd);
  }

  // Gemini on PATH is found there, and runs as plain "gemini".
  const r2 = rig();
  const gemini2 = cliStub(r2, r2.pathBin, 'gemini');
  const dash2 = await dashboard({ env: r2.env });
  try {
    await open(page, dash2, '/', { url: 'http://127.0.0.1:9/' });
    await openPicker(page);
    await expect(entry(page, 'gemini')).toContainText('found on PATH');
    await expect(entry(page, 'gemini').getByTestId('where')).toHaveText(gemini2);
    await expect(entry(page, 'gemini').getByTestId('agent-command')).toHaveText(PRESETS.gemini);
  } finally {
    await dash2.stop();
  }
});

test('AC 12: a preset found only in npm prefix -g is run by that path when the loop starts', async ({ page }) => {
  const r = rig();
  const gemini = cliStub(r, r.npmBin, 'gemini');
  const site = await fixtureSite();
  const cwd = tempDir('a11y-508-loopcwd-');
  const g = gitRepo(cwd);
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'index.html'), '<!doctype html><title>x</title>');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({ url: site.base + 'about.html', args: ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots'], agent: 'gemini', check: 'true', push: false, deployed: 'none' }));
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  const dash = await dashboard({ cwd, env: { ...r.env, PATH: `${r.env.PATH}${delimiter}${dirname(process.execPath)}` } });
  try {
    await open(page, dash);
    await useToken(page);
    await openPicker(page);
    await expect(entry(page, 'gemini')).toHaveAttribute('data-found', 'true');
    await goInApp(page, '/');
    await go(page).click();
    await expect(now(page)).toHaveText(/^Done: /, { timeout: 240_000 });
    const calls = readFileSync(join(r.root, 'gemini-calls.txt'), 'utf8');
    expect(calls.split('\n')[0].startsWith(gemini + ' --approval-mode auto_edit --include-directories ')).toBe(true);
  } finally {
    await dash.stop();
    site.close();
  }
});
