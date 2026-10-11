// The install-failure remedies table, row by row: each row must still match
// the output it was written for, and fill its command in for the shell and
// platform. Runs under the root `npm test` with nothing installed.

import assert from 'node:assert/strict';
import { installRemedies, installCommand, INSTALL, PRESETS, PRESET_INFO, REMEDY_ROWS, presetCommandAt } from '../src/agent.mjs';

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
};
const ids = (args) => installRemedies(args).map((r) => r.id);
const first = (args) => installRemedies(args)[0];
const zsh = { shell: '/bin/zsh', platform: 'darwin' };

console.log('remedies:');
const rows = {
  'npm-missing': [
    'zsh:1: command not found: npm',
    'bash: npm: command not found',
    "'npm' is not recognized as an internal or external command,",
    'Error: spawn npm ENOENT',
  ],
  permission: [
    'npm ERR! code EACCES\nnpm ERR! syscall mkdir\nnpm ERR! path /usr/local/lib/node_modules/@google',
    'npm ERR! code EPERM',
    'npm ERR! Error: EACCES: permission denied, mkdir',
  ],
  network: ['npm ERR! code ENOTFOUND', 'npm ERR! code EAI_AGAIN', 'npm ERR! network ETIMEDOUT', 'npm ERR! errno ECONNREFUSED', 'npm ERR! code ECONNRESET', 'npm ERR! 407 Proxy Authentication Required'],
  tls: ['npm ERR! code SELF_SIGNED_CERT_IN_CHAIN', 'npm ERR! code UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'npm ERR! code CERT_HAS_EXPIRED'],
  'not-on-registry': ['npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.internal/@openai%2fcodex', 'npm ERR! code ETARGET'],
  'node-too-old': ['npm WARN EBADENGINE Unsupported engine {', 'error: this package requires Node >= 20'],
  disk: ['npm ERR! code ENOSPC'],
  'execution-policy': ['npm : File C:\\Program Files\\nodejs\\npm.ps1 cannot be loaded because running scripts is disabled on this system.'],
};
for (const [id, outputs] of Object.entries(rows)) {
  for (const output of outputs) check(`${id}: ${output.split('\n')[0].slice(0, 60)}`, () => assert.ok(ids({ code: 1, output, ...zsh }).includes(id), JSON.stringify(ids({ code: 1, output, ...zsh }))));
}
check('every row in the table has a test above, plus not-on-path and unknown', () => {
  for (const r of REMEDY_ROWS) assert.ok(rows[r.id] || r.id === 'not-on-path', `untested row ${r.id}`);
});
check('not-on-path: exit 0 but the preset is still not found, with npm prefix -g expanded', () => {
  const r = installRemedies({ code: 0, output: 'added 1 package', ...zsh, found: false, npmPrefix: '/Users/dev/.npm-global' });
  assert.deepEqual(r.map((x) => x.id), ['not-on-path']);
  assert.equal(r[0].command, `echo 'export PATH="/Users/dev/.npm-global/bin:$PATH"' >> ~/.zshrc`);
});
check('not-on-path per shell: bash, fish, PowerShell, cmd', () => {
  const at = (shell, platform) => first({ code: 0, output: '', shell, platform, found: false, npmPrefix: platform === 'win32' ? 'C:\\npm' : '/opt/npm' }).command;
  assert.equal(at('/bin/bash', 'linux'), `echo 'export PATH="/opt/npm/bin:$PATH"' >> ~/.bashrc`);
  assert.equal(at('/usr/bin/fish', 'linux'), 'fish_add_path /opt/npm/bin');
  assert.equal(at('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32'), `Add-Content $PROFILE '$env:Path = "C:\\npm;" + $env:Path'`);
  assert.equal(at('C:\\Windows\\system32\\cmd.exe', 'win32'), 'setx PATH "C:\\npm;%PATH%"');
});
check('Git Bash on Windows: POSIX PATH line with an MSYS path; permission remedy without bin/', () => {
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  assert.equal(first({ code: 0, output: '', shell: gitBash, platform: 'win32', found: false, npmPrefix: 'C:\\Users\\dev\\AppData\\Roaming\\npm' }).command, `echo 'export PATH="/c/Users/dev/AppData/Roaming/npm:$PATH"' >> ~/.bashrc`);
  assert.equal(first({ code: 1, output: 'npm ERR! code EPERM', shell: gitBash, platform: 'win32' }).command, `npm config set prefix ~/.npm-global && echo 'export PATH="$HOME/.npm-global:$PATH"' >> ~/.bashrc`);
  assert.equal(first({ code: 1, output: 'npm ERR! code EPERM', shell: 'powershell.exe', platform: 'win32' }).command, 'npm config set prefix "$env:APPDATA\\npm"');
});
check('permission: user prefix and the PATH line for the detected shell, never sudo', () => {
  const bash = first({ code: 243, output: 'npm ERR! code EACCES', shell: '/bin/bash', platform: 'linux' });
  assert.equal(bash.id, 'permission');
  assert.equal(bash.command, `npm config set prefix ~/.npm-global && echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc`);
  assert.ok(!/sudo/.test(bash.command) && /Do not use sudo/.test(bash.text));
});
check('tls: NODE_EXTRA_CA_CERTS, never strict-ssl false', () => {
  const r = first({ code: 1, output: 'SELF_SIGNED_CERT_IN_CHAIN', ...zsh });
  assert.ok(/NODE_EXTRA_CA_CERTS/.test(r.command) && !/strict-ssl false/.test(r.command));
});
check('unknown: nothing else matched', () => assert.deepEqual(ids({ code: 1, output: 'something odd happened', ...zsh }), ['unknown']));
check('success returns no remedies', () => assert.deepEqual(installRemedies({ code: 0, output: 'added 1 package', ...zsh, found: true }), []));
check('several matches are all returned, most specific first', () => assert.deepEqual(ids({ code: 1, output: 'npm ERR! code SELF_SIGNED_CERT_IN_CHAIN\nnpm ERR! errno ECONNRESET', ...zsh }), ['tls', 'network']));
check('remedies are deterministic', () => assert.deepEqual(installRemedies({ code: 1, output: 'EACCES', ...zsh }), installRemedies({ code: 1, output: 'EACCES', ...zsh })));
check('install commands: one per preset, npm install -g of its package', () => {
  assert.deepEqual(Object.keys(INSTALL), Object.keys(PRESETS));
  assert.equal(installCommand('claude'), 'npm install -g @anthropic-ai/claude-code');
  assert.equal(installCommand('gemini'), 'npm install -g @google/gemini-cli');
  assert.equal(installCommand('codex'), 'npm install -g @openai/codex');
  assert.equal(installCommand('rm -rf /'), null);
});
check('a preset found off PATH runs by its absolute path', () => {
  assert.equal(presetCommandAt('gemini', '/home/dev/.npm-global/bin/gemini'), '/home/dev/.npm-global/bin/gemini ' + PRESETS.gemini.slice(PRESET_INFO.gemini.bin.length + 1));
});

console.log(failures ? `\n${failures} assertion(s) failed` : '\nall assertions passed');
process.exitCode = failures ? 1 : 0;
