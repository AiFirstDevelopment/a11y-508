// The platform mechanics the server tests and the Playwright suite share, so
// each test makes the same assertions on macOS, Linux and Windows. On Windows
// the dashboard runs commands through Git Bash, so stubs stay #!/bin/sh
// scripts; what differs is how a non-shell caller (cmd, for --version and the
// loop's agent) runs them, which is a .cmd wrapper beside each one.

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { killTreeWindows } from '../runs.mjs';

export const WIN = process.platform === 'win32';

// Git for Windows' bash.exe, the shell the dashboard picks on Windows.
export function gitBash() {
  if (!WIN) return null;
  const pf = [process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'];
  const std = pf.map((d) => join(d, 'Git', 'bin', 'bash.exe')).find((p) => existsSync(p));
  if (std) return std;
  const r = spawnSync('where.exe', ['bash'], { encoding: 'utf8' });
  const hit = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).find((l) => /[\\/]Git[\\/](usr[\\/])?bin[\\/]bash\.exe$/i.test(l));
  if (!hit) throw new Error('Git for Windows (bash.exe) is required for these tests on Windows');
  return hit;
}
const gitRoot = () => dirname(dirname(gitBash()));

// A path as an sh script inside Git Bash may write it.
export const shPath = (p) => (WIN ? p.replace(/\\/g, '/') : p);
// A path as Git Bash prints it: C:\Users\x -> /c/Users/x.
export const msysPath = (p) => (WIN && /^[A-Za-z]:[\\/]/.test(p) ? `/${p[0].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}` : p);
// A path quoted for the shell the core runs commands in (sh, or cmd on Windows).
export const quote = (p) => (WIN ? `"${p}"` : JSON.stringify(p));

// The file the dashboard finds for a stub named name in dir.
export const exePath = (dir, name) => join(dir, WIN ? `${name}.cmd` : name);

// npm's global bin directory for a prefix: prefix/bin, or the prefix itself on Windows.
export const npmBin = (prefix) => (WIN ? prefix : join(prefix, 'bin'));

// The .cmd that runs an sh stub through Git Bash, telling it its own path.
function cmdWrapper(name) {
  return `@echo off\r\nset "STUB_SELF=%~f0"\r\nset "PATH=${join(gitRoot(), 'usr', 'bin')};%PATH%"\r\n"${gitBash()}" "%~dp0${name}" %*\r\n`;
}

// An executable sh script in dir (plus its .cmd on Windows); returns the path
// the dashboard will find for it. A stub that records its own path should use
// "${STUB_SELF:-$0}".
export function stub(dir, name, body) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
  chmodSync(join(dir, name), 0o755);
  if (WIN) writeFileSync(join(dir, `${name}.cmd`), cmdWrapper(name));
  return exePath(dir, name);
}

// The same stub, written by an sh script (a stub npm installing a CLI).
export function stubScript(dir, name, body) {
  const file = (n, content, exec) => `cat > ${JSON.stringify(shPath(join(dir, n)))} <<'A11Y_508_STUB'\n${content.replace(/\n$/, '')}\nA11Y_508_STUB\n${exec ? `chmod +x ${JSON.stringify(shPath(join(dir, n)))}\n` : ''}`;
  return file(name, body, true) + (WIN ? file(`${name}.cmd`, cmdWrapper(name), false) : '');
}

// The login shell a test controls: a stub bash on POSIX, Git Bash on Windows.
// name is what GET /api/env reports for it.
export function loginShell(root) {
  if (WIN) return { SHELL: gitBash(), name: 'Git Bash' };
  return { SHELL: stub(join(root, 'shell'), 'bash', '#!/bin/sh\n[ "$1" = "-lc" ] && shift\nexec /bin/sh -c "$1"\n'), name: 'bash' };
}

// PATH for a miniature machine: the given directories, then the system's
// (and on Windows git's, which the loop needs, as /usr/bin carries it elsewhere).
export function systemPath(...dirs) {
  if (!WIN) return [...dirs, '/usr/bin', '/bin'].join(delimiter);
  const sys = process.env.SystemRoot || 'C:\\Windows';
  return [...dirs, join(sys, 'System32'), sys, join(sys, 'System32', 'Wbem'), join(sys, 'System32', 'WindowsPowerShell', 'v1.0'), join(gitRoot(), 'cmd')].join(delimiter);
}

// process.env plus overrides. Windows names are case-insensitive (Path vs
// PATH), so an override replaces every spelling of its name.
export function mergeEnv(base, extra = {}) {
  const out = { ...base };
  if (WIN) for (const k of Object.keys(extra)) for (const b of Object.keys(out)) if (b !== k && b.toLowerCase() === k.toLowerCase()) delete out[b];
  return Object.assign(out, extra);
}

// Ends a process and everything it started: SIGINT elsewhere (the server's
// own shutdown); on Windows, where there is no SIGINT to send, the server's
// own tree kill, including what escaped a first taskkill /T.
// group: proc was spawned detached, and the signal goes to its whole process
// group, as Ctrl+C in a terminal does. A wrapper such as `npm run` (npm, then
// sh, then node) needs it: on Linux, SIGINT to npm alone reaches sh, which
// waits for node, which never hears it. Whatever has not exited after 10
// seconds is killed, so a stuck process cannot take the test's time with it.
export function stopTree(proc, signal = 'SIGINT', { group = false } = {}) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  const exited = new Promise((ok) => proc.once('exit', ok));
  if (!WIN) {
    const send = (sig) => {
      try {
        if (group) process.kill(-proc.pid, sig);
        else proc.kill(sig);
      } catch {}
    };
    send(signal);
    const timer = setTimeout(() => send('SIGKILL'), 10000);
    return exited.then(() => clearTimeout(timer));
  }
  return Promise.all([exited, killTreeWindows(proc.pid)]);
}

// What the server runs to open the browser, recorded to file instead:
// open / xdg-open stubs elsewhere; on Windows, where the server runs
// "cmd /c start "" <url>", a copy of node named cmd.exe ahead of System32 on
// PATH whose preload records its arguments and exits. Returns env to add.
export function recordOpen(bin, file) {
  mkdirSync(bin, { recursive: true });
  if (!WIN) {
    for (const name of ['open', 'xdg-open']) stub(bin, name, `#!/bin/sh\necho "$@" >> ${JSON.stringify(file)}\n`);
    return {};
  }
  copyFileSync(process.execPath, join(bin, 'cmd.exe'));
  const preload = join(bin, 'record-open.cjs');
  writeFileSync(preload, `if (require('path').basename(process.execPath).toLowerCase() === 'cmd.exe') {\n  require('fs').appendFileSync(${JSON.stringify(file)}, process.argv.slice(2).join(' ') + '\\n');\n  process.exit(0);\n}\n`);
  return { NODE_OPTIONS: `--require ${preload}` };
}

// Runs a command line the way a person would paste it into the dashboard's
// shell: sh -c elsewhere; Git Bash on Windows, staying in cwd.
export function shellLine(command, shell) {
  if (!WIN) return ['/bin/sh', ['-c', command], {}];
  if (!shell || shell.kind !== 'bash') throw new Error(`expected Git Bash on Windows, got ${JSON.stringify(shell)}`);
  return [shell.path, ['-lc', command], { CHERE_INVOKING: '1' }];
}

// Process ids and command lines of every running process.
export function processList() {
  if (!WIN) return spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout;
  const ps = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }';
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout;
}

