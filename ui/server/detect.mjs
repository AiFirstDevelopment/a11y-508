// Which AI coding assistants are installed, where, and at which version; and
// which shell the developer uses. CLIs installed with npm -g or under nvm are
// often missing from the PATH of a process started some other way, so each
// preset is looked for on PATH, then through the developer's login shell,
// then in npm prefix -g's bin directory.

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, join } from 'node:path';
import { killTreeWindows } from './runs.mjs';
import { recordKill, refuseKill } from '../../src/kills.mjs';
import { PRESETS, PRESET_INFO, installCommand, npmBinDir, presetCommandAt } from '../../src/agent.mjs';

// Git for Windows' bash, or null. SHELL naming a bash.exe wins (Git Bash
// sets it, and a test can pin it); then bash on PATH under a Git folder; then
// the bash beside git itself; then the standard install locations.
export function findGitBash(env = process.env) {
  const ok = (p) => {
    try {
      return !!p && statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (env.SHELL && /[\\/]bash\.exe$/i.test(env.SHELL) && ok(env.SHELL)) return env.SHELL;
  const sync = (file, args) => {
    try {
      const r = spawnSync(file, args, { env, encoding: 'utf8', timeout: 5000, windowsHide: true });
      return r.status === 0 ? r.stdout : '';
    } catch {
      return '';
    }
  };
  const onPath = sync('where.exe', ['bash']).split(/\r?\n/).map((l) => l.trim()).find((l) => /[\\/]Git[\\/](usr[\\/])?bin[\\/]bash\.exe$/i.test(l) && ok(l));
  if (onPath) return onPath;
  const exec = sync('git', ['--exec-path']).trim();
  if (exec) {
    // <Git>\mingw64\libexec\git-core
    const root = dirname(dirname(dirname(exec)));
    for (const p of [join(root, 'bin', 'bash.exe'), join(root, 'usr', 'bin', 'bash.exe')]) if (ok(p)) return p;
  }
  const std = [env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'].map((d) => join(d, 'Git', 'bin', 'bash.exe'));
  if (env.LOCALAPPDATA) std.push(join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  return std.find(ok) || null;
}

// The developer's shell: $SHELL on macOS and Linux. On Windows, Git Bash when
// Git for Windows is installed (the loop needs git anyway), so everything
// runs the POSIX way; otherwise PowerShell or cmd, from PSModulePath and ComSpec.
export function detectShell(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const bash = findGitBash(env);
    if (bash) return { name: 'Git Bash', path: bash, kind: 'bash' };
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

// Detection runs outside the project (the home directory), so a slow or
// stuck lookup never holds the project folder open, which on Windows stops
// it being moved or deleted. A lookup that times out gives up even when a
// grandchild still holds its output open (child.kill on Windows ends only
// the direct child, and 'close' waits for every holder of the pipe).
export function run(file, args, { env, timeout = 10000, cwd = homedir(), shell = false } = {}) {
  return new Promise((resolveRun) => {
    let settled = false;
    const resolve = (r) => {
      if (!settled) {
        settled = true;
        resolveRun(r);
      }
    };
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
    const timer = setTimeout(() => {
      if (process.platform === 'win32') killTreeWindows(child.pid, 'detection-timeout').catch(() => {});
      else if (!refuseKill(child.pid, 'detection-timeout')) {
        recordKill('detection-timeout', { target: child.pid });
        child.kill('SIGKILL');
      }
      setTimeout(() => resolve({ code: null, out, err: err + 'timed out' }), 2000).unref();
    }, timeout);
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

const pathLines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^([A-Za-z]:[\\/]|\/)/.test(l));
const lastPathLine = (text) => pathLines(text).pop() || null;

// On Windows a found script is run by cmd (version, the loop's agent), which
// cannot run npm's extensionless sh shim; use its .cmd (PATHEXT) sibling.
export function runnable(p, env = process.env, platform = process.platform) {
  if (!p || platform !== 'win32') return p;
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((x) => x.toLowerCase());
  if (exts.includes(extname(p).toLowerCase())) return p;
  return exts.map((x) => p + x).find((c) => isExecutable(c, platform)) || p;
}

async function viaShell(shell, bin, env, platform) {
  // where.exe, not where: in PowerShell "where" is Where-Object. It lists
  // every match in the order cmd would try them, so the first is the one.
  // Git Bash prints /c/... paths; cygpath -w turns them into Windows ones.
  const cmd = shell.kind === 'powershell' || shell.kind === 'cmd' ? `where.exe ${bin}` : platform === 'win32' ? `p=$(command -v ${bin}) && cygpath -w "$p"` : `command -v ${bin}`;
  const [file, args] = shellInvocation(shell, cmd);
  const r = await run(file, args, { env, timeout: 8000 });
  if (r.code !== 0) return null;
  const lines = pathLines(r.out);
  const p = runnable(platform === 'win32' && (shell.kind === 'powershell' || shell.kind === 'cmd') ? lines[0] : lines.pop(), env, platform);
  return p && existsSync(p) ? p : null;
}

export async function npmPrefix(shell, env, platform = process.platform) {
  // npm.cmd in PowerShell, so a blocked npm.ps1 does not hide the prefix.
  const [file, args] = shellInvocation(shell, shell.kind === 'powershell' ? 'npm.cmd prefix -g' : 'npm prefix -g');
  const r = await run(file, args, { env, timeout: 15000 });
  return r.code === 0 ? lastPathLine(r.out) : null;
}

async function version(path, env, platform) {
  // .cmd and .bat need cmd on Windows; quoted, as a path may hold spaces.
  const win = platform === 'win32';
  // Node CLIs can take a while to start the first time; stdout is captured with or without a shell.
  const r = await run(win ? `"${path}"` : path, ['--version'], { env, timeout: 30000, shell: win });
  const lines = `${r.out}\n${r.err}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // The version is the line that looks like one (a CLI may print a warning first); "unknown" only
  // when the call failed and printed no version at all.
  const v = lines.find((l) => /\d+\.\d+(\.\d+)?/.test(l) && l.length <= 120) || null;
  if (v) return v;
  return r.code === 0 && lines[0] ? lines[0].slice(0, 120) : null;
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
