// Which AI coding assistants are installed, where, and at which version; and
// which shell the developer uses. CLIs installed with npm -g or under nvm are
// often missing from the PATH of a process started some other way, so each
// preset is looked for on PATH, then through the developer's login shell,
// then in npm prefix -g's bin directory.

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { PRESETS, PRESET_INFO, installCommand, npmBinDir, presetCommandAt } from '../../src/agent.mjs';

// The developer's shell: $SHELL on macOS and Linux; PowerShell or cmd on
// Windows, from PSModulePath and ComSpec.
export function detectShell(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    if (env.PSModulePath) {
      const pwsh = (env.PSModulePath.match(/PowerShell[\\/]7/i) && 'pwsh.exe') || 'powershell.exe';
      return { name: pwsh.startsWith('pwsh') ? 'PowerShell 7' : 'Windows PowerShell', path: pwsh, kind: 'powershell' };
    }
    return { name: 'cmd', path: env.ComSpec || 'cmd.exe', kind: 'cmd' };
  }
  const path = env.SHELL || '/bin/sh';
  const name = basename(path);
  return { name, path, kind: /fish/.test(name) ? 'fish' : /bash/.test(name) ? 'bash' : /zsh/.test(name) ? 'zsh' : 'sh' };
}

// Spawn args for running a command inside the shell, as a login shell where
// that exists, so the npm and PATH it finds are the developer's own.
export function shellInvocation(shell, command) {
  if (shell.kind === 'powershell') return [shell.path, ['-NoLogo', '-Command', command]];
  if (shell.kind === 'cmd') return [shell.path, ['/d', '/s', '/c', command]];
  return [shell.path, ['-lc', command]];
}

export function run(file, args, { env, timeout = 10000, cwd, shell = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { env, cwd, shell, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return resolve({ code: null, out: '', err: e.message });
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, out, err: err + e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

const isExecutable = (p, platform) => {
  try {
    if (!statSync(p).isFile()) return false;
    if (platform !== 'win32') accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const candidates = (dir, bin, env, platform) =>
  platform === 'win32' ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((x) => join(dir, bin + x.toLowerCase())).concat(join(dir, bin)) : [join(dir, bin)];

export function searchPath(bin, env = process.env, platform = process.platform) {
  for (const dir of String(env.PATH || env.Path || '').split(delimiter).filter(Boolean)) {
    for (const c of candidates(dir, bin, env, platform)) if (isExecutable(c, platform)) return c;
  }
  return null;
}

const lastPathLine = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^([A-Za-z]:\\|\/)/.test(l)).pop() || null;

async function viaShell(shell, bin, env, platform) {
  const cmd = platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
  const [file, args] = shellInvocation(shell, cmd);
  const r = await run(file, args, { env, timeout: 8000 });
  const p = r.code === 0 ? lastPathLine(r.out) : null;
  return p && existsSync(p) ? p : null;
}

export async function npmPrefix(shell, env, platform = process.platform) {
  const [file, args] = shellInvocation(shell, 'npm prefix -g');
  const r = await run(file, args, { env, timeout: 15000 });
  return r.code === 0 ? lastPathLine(r.out) : null;
}

async function version(path, env, platform) {
  const r = await run(path, ['--version'], { env, timeout: 15000, shell: platform === 'win32' });
  const line = `${r.out}\n${r.err}`.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return r.code === 0 && line ? line.slice(0, 120) : null;
}

// One entry per preset, always all of them, in PRESETS order.
export async function detectPresets({ env = process.env, platform = process.platform } = {}) {
  const shell = detectShell(env, platform);
  const prefix = await npmPrefix(shell, env, platform);
  const binDir = npmBinDir(prefix, platform);
  const presets = await Promise.all(
    Object.keys(PRESETS).map(async (name) => {
      const info = PRESET_INFO[name];
      let path = searchPath(info.bin, env, platform);
      let where = path ? 'PATH' : null;
      if (!path) {
        path = await viaShell(shell, info.bin, env, platform);
        if (path) where = 'login shell';
      }
      if (!path && binDir) {
        const hit = candidates(binDir, info.bin, env, platform).find((c) => isExecutable(c, platform));
        if (hit) {
          path = hit;
          where = 'npm prefix -g';
        }
      }
      return {
        name,
        label: info.label,
        bin: info.bin,
        found: !!path,
        path,
        where,
        version: path ? await version(path, env, platform) : null,
        // The command the loop runs: by absolute path when the CLI is not on PATH.
        command: path && where !== 'PATH' ? presetCommandAt(name, path) : PRESETS[name],
        install: installCommand(name, platform),
      };
    })
  );
  return { shell, npmPrefix: prefix, presets, detectedAt: new Date().toISOString() };
}
