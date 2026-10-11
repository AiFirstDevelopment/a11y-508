import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, stub, tmp } from './helpers.mjs';
import { loginShell, npmBin, shPath, stubScript, systemPath } from './platform.mjs';

// A machine in miniature: a PATH directory, an npm prefix, the login shell
// (a stub bash, or Git Bash on Windows), and a stub npm.
function machine() {
  const root = tmp('a11y-508-mach-');
  const bin = join(root, 'bin');
  const prefix = join(root, 'prefix');
  mkdirSync(npmBin(prefix), { recursive: true });
  mkdirSync(join(root, 'home'));
  const shell = loginShell(root);
  stub(bin, 'npm', `#!/bin/sh
if [ "$1" = "prefix" ]; then echo ${JSON.stringify(prefix)}; exit 0; fi
echo "$*" >> ${JSON.stringify(shPath(join(root, 'npm-calls')))}
env > ${JSON.stringify(shPath(join(root, 'npm-env')))}
if [ -f ${JSON.stringify(shPath(join(root, 'fail')))} ]; then echo "npm ERR! code EACCES"; exit 1; fi
${stubScript(npmBin(prefix), 'codex', '#!/bin/sh\necho 1.0.0\n')}exit 0
`);
  return { root, bin, prefix, shellName: shell.name, env: { PATH: systemPath(bin), SHELL: shell.SHELL, HOME: join(root, 'home') } };
}

test('presets are detected on PATH and in npm prefix -g, with versions and the command the loop runs', async () => {
  const m = machine();
  const claudeExe = stub(m.bin, 'claude', '#!/bin/sh\necho "2.0.0 (Claude Code)"\n');
  const geminiExe = stub(npmBin(m.prefix), 'gemini', '#!/bin/sh\necho "0.9.0"\n');
  const s = await startServer({ env: m.env });
  try {
    const env = (await s.call('GET', '/api/env')).json;
    assert.deepEqual(env.presets.map((p) => p.name), ['claude', 'gemini', 'codex']);
    const [claude, gemini, codex] = env.presets;
    assert.deepEqual([claude.found, claude.where, claude.path, claude.version], [true, 'PATH', claudeExe, '2.0.0 (Claude Code)']);
    assert.match(claude.command, /^claude -p /);
    assert.deepEqual([gemini.found, gemini.where, gemini.path], [true, 'npm prefix -g', geminiExe]);
    assert.ok(gemini.command.startsWith(geminiExe + ' --approval-mode'));
    assert.equal(codex.found, false);
    assert.equal(codex.install, 'npm install -g @openai/codex');
    assert.equal(env.shell.name, m.shellName);
    assert.equal(env.npmPrefix, m.prefix);
  } finally {
    await s.stop();
  }
});

test('install runs the fixed command in the login shell, re-detects, and explains a failure', async () => {
  const m = machine();
  const s = await startServer({ env: { ...m.env, TOKEN: 'server-token-for-install-test' } });
  try {
    for (const body of [{ agent: 'codex', command: 'touch x' }, { agent: 'npm' }, {}, { command: 'x' }]) assert.equal((await s.call('POST', '/api/agent/install', { body })).status, 400, JSON.stringify(body));
    assert.ok(!existsSync(join(m.root, 'npm-calls')));
    writeFileSync(join(m.root, 'fail'), '');
    assert.equal((await s.call('POST', '/api/agent/install', { body: { agent: 'codex' } })).status, 202);
    await s.waitDone();
    let ev = (await s.call('GET', '/api/runs/current/events')).text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    let done = ev.find((e) => e.type === 'done');
    assert.equal(done.code, 1);
    assert.equal(done.found, false);
    assert.equal(done.remedies[0].id, 'permission');
    assert.match(done.remedies[0].command, />> ~\/\.bashrc$/);
    assert.ok(ev.some((e) => e.type === 'raw' && /EACCES/.test(e.line)));
    // Success: the entry turns live.
    const { rmSync } = await import('node:fs');
    rmSync(join(m.root, 'fail'));
    await s.call('POST', '/api/agent/install', { body: { agent: 'codex' } });
    await s.waitDone();
    ev = (await s.call('GET', '/api/runs/current/events')).text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    done = ev.find((e) => e.type === 'done');
    assert.deepEqual([done.code, done.found, done.remedies], [0, true, []]);
    assert.equal(readFileSync(join(m.root, 'npm-calls'), 'utf8'), 'install -g @openai/codex\ninstall -g @openai/codex\n');
    assert.ok(!readFileSync(join(m.root, 'npm-env'), 'utf8').includes('server-token-for-install-test'), 'the install never sees TOKEN');
    const env = (await s.call('GET', '/api/env')).json;
    assert.equal(env.presets.find((p) => p.name === 'codex').found, true);
  } finally {
    await s.stop();
  }
});
