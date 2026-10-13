// The fixing-assistant picker, Test assistant, and Install, with the harness
// controlling PATH, the shell, and npm through stub executables.

import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { dashboard, fixtureSite, gitRepo, open, stub, tempDir, api, ROOT, TOKEN, type Dash, WIN, exePath, loginShell, msysPath, npmBin, quote, shPath, stubScript, systemPath } from './harness';

const PRESETS = {
  claude: 'claude -p --permission-mode acceptEdits "Read the file {promptFile} and do exactly what it says."',
  gemini: 'gemini --approval-mode auto_edit -p "Do exactly what the instructions above say." < "{promptFile}"',
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
const config = (dash: Dash) => JSON.parse(readFileSync(join(dash.cwd, 'a11y-508.config.json'), 'utf8'));

test('AC 12: the picker lists every preset, live or greyed as installed, saves the choice, and tests the assistant', async ({ page }) => {
  const r = rig();
  const claude = cliStub(r, r.pathBin, 'claude');
  const gemini = cliStub(r, r.npmBin, 'gemini'); // only in npm prefix -g's bin directory
  const dash = await dashboard({ env: r.env });
  try {
    writeFileSync(join(dash.cwd, 'a11y-508.config.json'), JSON.stringify({ url: 'http://127.0.0.1:9/', check: 'true' }));
    await open(page, dash, '/fix-loop');
    await expect(page.getByTestId('picker').locator('.preset label')).toHaveCount(4);
    const names = await page.getByTestId('picker').locator('.preset label').allTextContents();
    expect(names).toEqual(['Claude Code', 'Gemini CLI', 'Codex', 'Custom command']);

    await expect(entry(page, 'claude')).toHaveAttribute('data-found', 'true');
    await expect(entry(page, 'claude').getByTestId('version')).toHaveText('9.9.9 (stub claude)');
    await expect(entry(page, 'claude').getByTestId('where')).toHaveText(claude);
    await expect(entry(page, 'claude').getByTestId('agent-command')).toHaveText(PRESETS.claude);
    await expect(entry(page, 'claude')).toContainText('found on PATH');

    await expect(entry(page, 'gemini')).toHaveAttribute('data-found', 'true');
    await expect(entry(page, 'gemini')).toContainText('found through npm prefix -g');
    await expect(entry(page, 'gemini').getByTestId('where')).toHaveText(gemini);
    await expect(entry(page, 'gemini').getByTestId('agent-command')).toHaveText(gemini + PRESETS.gemini.slice('gemini'.length));

    await expect(entry(page, 'codex')).toHaveAttribute('data-found', 'false');
    await expect(entry(page, 'codex')).toHaveClass(/missing/);
    await expect(entry(page, 'codex')).toContainText('not installed');

    const start = page.getByTestId('loop-start');
    await entry(page, 'gemini').getByRole('radio').check();
    await expect.poll(() => config(dash).agent).toBe('gemini');
    await expect(start).toBeEnabled();
    await entry(page, 'codex').getByRole('radio').check();
    await expect.poll(() => config(dash).agent).toBe('codex');
    await expect(start).toBeDisabled();
    await entry(page, 'claude').getByRole('radio').check();
    await expect.poll(() => config(dash).agent).toBe('claude');
    await expect(start).toBeEnabled();

    // Test assistant: the fake agent answers; an agent that writes nothing fails with its output.
    await entry(page, 'custom').getByRole('radio').check();
    const fake = `${quote(process.execPath)} ${quote(join(ROOT, 'test', 'fake-agent.mjs'))} {promptFile} {resultFile}`;
    await page.getByLabel(/^Command \(must contain/).fill(fake);
    await page.getByRole('button', { name: 'Test assistant' }).click();
    await expect(page.getByTestId('test-status')).toHaveText(/^ready/, { timeout: 60_000 });
    await page.getByLabel(/^Command \(must contain/).fill(`${quote(process.execPath)} -e "console.log('please sign in first')" {promptFile}`);
    await page.getByRole('button', { name: 'Test assistant' }).click();
    await expect(page.getByTestId('test-status')).toHaveText('not signed in or failed', { timeout: 60_000 });
    await expect(page.getByTestId('test-output')).toContainText('please sign in first');
  } finally {
    await dash.stop();
  }

  // Gemini on PATH is found there, and runs as plain "gemini".
  const r2 = rig();
  const gemini2 = cliStub(r2, r2.pathBin, 'gemini');
  const dash2 = await dashboard({ env: r2.env });
  try {
    await open(page, dash2, '/fix-loop');
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
  writeFileSync(join(cwd, '.gitignore'), 'a11y-508-work/\na11y-508-report/\n');
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'index.html'), '<!doctype html><title>x</title>');
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({ url: site.base + 'about.html', args: ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots'], agent: 'gemini', check: 'true', push: false, deployed: 'none' }));
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  const dash = await dashboard({ cwd, env: { ...r.env, PATH: `${r.env.PATH}${delimiter}${dirname(process.execPath)}` } });
  try {
    await open(page, dash, '/run');
    await page.getByLabel('A token').check();
    await page.getByLabel(/^Token \(sent as/).fill(TOKEN);
    await page.getByLabel('Start URL').fill(site.base + 'about.html');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Fix loop' }).click();
    await expect(entry(page, 'gemini')).toHaveAttribute('data-found', 'true');
    await page.getByLabel('Rounds to run').fill('1');
    await page.getByTestId('loop-start').click();
    await expect(page.getByTestId('loop-step')).toHaveText(/Loop finished/, { timeout: 240_000 });
    const calls = readFileSync(join(r.root, 'gemini-calls.txt'), 'utf8');
    expect(calls.split('\n')[0].startsWith(gemini + ' --approval-mode auto_edit -p')).toBe(true);
  } finally {
    await dash.stop();
    site.close();
  }
});

test('AC 13: Install shows the command and shell, runs only after confirmation, streams output, and explains failures', async ({ page }) => {
  const r = rig();
  const dash = await dashboard({ env: r.env });
  const calls = () => (existsSync(r.record) ? readFileSync(r.record, 'utf8').trim().split('\n').filter(Boolean) : []);
  try {
    await open(page, dash, '/fix-loop');
    await entry(page, 'codex').getByRole('radio').check();
    const panel = page.getByTestId('install-panel');
    await expect(panel.getByTestId('install-command')).toHaveText('npm install -g @openai/codex');
    await expect(panel.getByTestId('shell-name')).toHaveText(r.shellName);
    expect(calls()).toEqual([]);
    await panel.getByRole('button', { name: 'Install' }).click();
    const dialog = page.getByTestId('install-confirm');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('npm install -g @openai/codex');
    await expect(dialog).toContainText(r.shellName);
    expect(calls()).toEqual([]);
    await dialog.getByRole('button', { name: 'Run the install' }).click();
    await expect(page.getByTestId('install-output')).toContainText('npm install output for @openai/codex');
    await expect(page.getByTestId('install-result')).toContainText('Installed');
    await expect(entry(page, 'codex')).toHaveAttribute('data-found', 'true');
    await expect(entry(page, 'codex').getByTestId('where')).toHaveText(exePath(r.npmBin, 'codex'));
    expect(calls()).toEqual(['install -g @openai/codex']);

    // EACCES: stays greyed, shows the exit code and the permission remedy for this shell.
    writeFileSync(r.mode, 'eacces');
    await entry(page, 'gemini').getByRole('radio').check();
    await page.getByTestId('install-panel').getByRole('button', { name: 'Install' }).click();
    await page.getByTestId('install-confirm').getByRole('button', { name: 'Run the install' }).click();
    await expect(page.getByTestId('install-code')).toHaveText('1');
    await expect(entry(page, 'gemini')).toHaveAttribute('data-found', 'false');
    const remedy = page.locator('[data-remedy="permission"]');
    await expect(remedy).toBeVisible();
    // npm's global bin is the prefix itself on Windows, so no /bin there.
    await expect(remedy.getByTestId('remedy-command')).toHaveText(`npm config set prefix ~/.npm-global && echo 'export PATH="$HOME/.npm-global${WIN ? '' : '/bin'}:$PATH"' >> ~/.bashrc`);
    // Retry runs the same install again.
    writeFileSync(r.mode, 'silent');
    await page.getByTestId('install-panel').getByRole('button', { name: 'Retry' }).click();
    await page.getByTestId('install-confirm').getByRole('button', { name: 'Run the install' }).click();
    await expect(page.getByTestId('install-code')).toHaveText('0');
    expect(calls()).toEqual(['install -g @openai/codex', 'install -g @google/gemini-cli', 'install -g @google/gemini-cli']);
    // Exit 0 without the executable: not-on-path, with the real npm prefix -g path.
    const np = page.locator('[data-remedy="not-on-path"]');
    await expect(np.getByTestId('remedy-command')).toHaveText(`echo 'export PATH="${msysPath(r.npmBin)}:$PATH"' >> ~/.bashrc`);
    await expect(entry(page, 'gemini')).toHaveAttribute('data-found', 'false');

    // The install command never comes from the request.
    const marker = join(r.root, 'pwned');
    for (const body of [{ agent: 'gemini', command: `touch ${marker}` }, { agent: `touch ${marker}` }, { command: `touch ${marker}` }, { agent: 'gemini; touch ' + marker }]) {
      const res = await api(dash, '/api/agent/install', { method: 'POST', body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(existsSync(marker)).toBe(false);
    expect(calls().length).toBe(3);
  } finally {
    await dash.stop();
  }
});

// checks-rule-packs AC 11: with two remedies on screen, the tool's own checks (the in-page bundle the
// crawler injects) find no landmark-uniqueness item for the remedy command regions: each region is
// named after its remedy.
test('checks-rule-packs AC 11: remedy command regions have unique names, so the landmark check has nothing to report', async ({ page }) => {
  const r = rig();
  const dash = await dashboard({ env: r.env });
  try {
    await open(page, dash, '/fix-loop');
    await entry(page, 'codex').getByRole('radio').check();
    writeFileSync(r.mode, 'eacces-network');
    await page.getByTestId('install-panel').getByRole('button', { name: 'Install' }).click();
    await page.getByTestId('install-confirm').getByRole('button', { name: 'Run the install' }).click();
    await expect(page.locator('[data-remedy="permission"]').getByTestId('remedy-command')).toBeVisible();
    await expect(page.locator('[data-remedy="network"]').getByTestId('remedy-command')).toBeVisible();
    const dir = join(ROOT, 'src', 'checks', 'browser');
    const bundle = readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f) => readFileSync(join(dir, f), 'utf8')).join('\n;\n');
    await page.evaluate(bundle);
    const run = await page.evaluate(() => (window as any).__a11y508.run());
    expect(run.findings.length, 'the checks ran').toBeGreaterThan(0);
    const remedyLandmarks = run.findings.filter((f: any) => f.test === '9.A' && /remedy-command/.test(f.html));
    expect(remedyLandmarks.map((f: any) => `${f.level} ${f.message} [${f.selector}]`)).toEqual([]);
  } finally {
    await dash.stop();
  }
});
