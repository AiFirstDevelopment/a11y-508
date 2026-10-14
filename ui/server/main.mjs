#!/usr/bin/env node
// The a11y-508 dashboard: `node ui/server/main.mjs [--port 5508] [--no-open]
// [--dir <path>]`, run in (or pointed at) the repository to audit and fix.
// Zero dependencies; the built app is committed under ui/dist, so nothing
// has to be installed.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findChrome } from '../../src/chrome.mjs';
import { readGlobal, readSettings, rememberedStart, stateBase, writeGlobal, writeJson } from './state-dir.mjs';
import { resolve } from 'node:path';
import { SECRET_HEADER, createDashboard } from './app.mjs';
import { realDir } from './dirs.mjs';
import { writeDiary } from '../../src/diary.mjs';
import { lastKill, protectPid, recordKill, unprotectPid } from '../../src/kills.mjs';
import { browserCommand, ownExitMessage, spawnOwnBrowser } from './diagnostics.mjs';

const argv = process.argv.slice(2);
const opt = { port: 5508, open: true, dir: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--no-open') opt.open = false;
  else if (a === '--port') opt.port = parseInt(argv[++i], 10);
  else if (a.startsWith('--port=')) opt.port = parseInt(a.slice(7), 10);
  else if (a === '--dir') opt.dir = argv[++i] ?? '';
  else if (a.startsWith('--dir=')) opt.dir = a.slice(6);
  else if (a === '-h' || a === '--help') {
    process.stdout.write('Usage: node ui/server/main.mjs [--port <n>] [--no-open] [--dir <path>]\n\nStarts the a11y-508 dashboard on 127.0.0.1 for the current directory, or for --dir.\n');
    process.exit(0);
  } else {
    process.stderr.write(`error: unknown option ${a}\n`);
    process.exit(2);
  }
}
if (!Number.isInteger(opt.port) || opt.port < 0 || opt.port > 65535) {
  process.stderr.write('error: --port expects a port number\n');
  process.exit(2);
}

// --dir is resolved against the directory the server is launched from, and
// must be a readable directory before anything listens.
let cwd = process.cwd();
if (opt.dir !== null) {
  if (!opt.dir) {
    process.stderr.write('error: --dir expects a directory\n');
    process.exit(2);
  }
  try {
    cwd = realDir(resolve(process.cwd(), opt.dir));
  } catch (e) {
    process.stderr.write(`error: --dir ${opt.dir}: ${e.message}\n`);
    process.exit(2);
  }
}

// No --dir: the app repository folder chosen last time, if it still exists (and is not a folder
// above the launch directory). The browser's own memory is only a fallback.
let restored = false;
if (opt.dir === null && process.env.A11Y_508_NO_RESTORE !== '1') {
  const last = rememberedStart(readGlobal().lastCwd, cwd, realDir);
  if (last && last !== cwd) {
    cwd = last;
    restored = true;
  }
} else if (opt.dir !== null) {
  writeGlobal({ lastCwd: cwd });
}

// One dashboard per port. A launch while one is serving the port opens that one (its window, at its
// address) instead of failing or starting a second, and says so. ~/.a11y-508/server-<port>.json
// (owner-only, like the session) holds the running one's address; it answers /api/ping with its pid.
const serverFile = (port) => join(stateBase(), `server-${port}.json`);
async function runningOn(port) {
  if (!port) return null;
  const rec = readSettings(serverFile(port));
  if (!rec.secret || !rec.pid) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { headers: { [SECRET_HEADER]: rec.secret }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.pid === rec.pid ? { ...rec, cwd: j.cwd || rec.cwd } : null;
  } catch {
    return null;
  }
}
const existing = await runningOn(opt.port);
if (existing) {
  const url = `http://127.0.0.1:${opt.port}/#secret=${existing.secret}`;
  process.stdout.write(`a11y-508 dashboard is already running for ${existing.cwd} (process ${existing.pid}); using it instead of starting another\n`);
  if (opt.dir !== null && existing.cwd !== cwd) process.stdout.write(`it is working in ${existing.cwd}; choose ${cwd} on its Set up step\n`);
  process.stdout.write(`open: ${url}\n`);
  if (opt.open) {
    try {
      const res = await fetch(`http://127.0.0.1:${opt.port}/api/open`, { method: 'POST', headers: { [SECRET_HEADER]: existing.secret }, signal: AbortSignal.timeout(30000) });
      process.stdout.write(res.ok ? 'opened it in the browser\n' : 'could not open a browser; open the address above by hand\n');
    } catch {
      process.stdout.write('could not open a browser; open the address above by hand\n');
    }
  }
  process.exit(0);
}

let own = null;
let closing = false;
let closingReason = null;
const dash = createDashboard({ cwd, restored, onQuit: () => quit(), onOpen: () => reopen() });
await dash.listen(opt.port);
if (dash.build.fresh === false) process.stdout.write(`warn ${dash.build.reason}\n`);
process.stdout.write(`a11y-508 dashboard for ${cwd}${restored ? ' (the folder chosen last time)' : ''}\n`);
process.stdout.write(`open: ${dash.url}\n`);
process.stdout.write('This address carries a one-time secret for this launch; keep it to yourself. Press Ctrl+C to stop, or Quit in the dashboard.\n');
const myServerFile = serverFile(dash.port);
const serverRecord = { pid: process.pid, port: dash.port, secret: dash.secret, cwd, startedAt: new Date().toISOString(), ownBrowserPid: null };
// The record also names the dashboard's own browser, so no a11y-508 process ever kills it (src/kills.mjs).
const saveServerRecord = (patch = {}) => {
  Object.assign(serverRecord, patch);
  try {
    writeJson(myServerFile, serverRecord);
  } catch {}
};
saveServerRecord();
writeDiary({ type: 'server-start', cwd, port: dash.port }, { source: 'server' });

// A crash is written to the diagnostics diary before the process ends.
const crashed = (what) => (e) => {
  const error = String((e && e.stack) || e).slice(0, 4000);
  writeDiary({ type: 'server-stop', reason: 'crash', error: `${what}: ${error}` }, { source: 'server' });
  process.stderr.write(`a11y-508 dashboard crashed (${what}): ${error}\n`);
  forgetServerFile();
  process.exit(1);
};
process.on('uncaughtException', crashed('uncaught exception'));
process.on('unhandledRejection', crashed('unhandled rejection'));
const forgetServerFile = () => {
  try {
    if (readSettings(myServerFile).pid === process.pid) rmSync(myServerFile, { force: true });
  } catch {}
};
if (dash.runs.current && dash.runs.current.status === 'running') process.stdout.write(`a ${dash.runs.current.kind} run started earlier is still running; the dashboard shows it\n`);
else if (dash.runs.current && dash.runs.current.status === 'interrupted') process.stdout.write(`the fix loop started earlier was interrupted; the Fix step offers to continue it\n`);

function openBrowser(url) {
  // start's first quoted argument is a window title. Node writes an empty
  // argument as "", which is that empty title; a literal '""' would reach
  // cmd as "\"\"" and become the title and a stray argument.
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => process.stdout.write('could not open a browser; open the address above by hand\n'));
    child.unref();
  } catch {
    process.stdout.write('could not open a browser; open the address above by hand\n');
  }
}
// The dashboard in a browser of its own: Chrome with a persistent profile (so a sign-in to the
// app's portal is kept from one launch to the next) and a DevTools port, so every crawl's sign-in
// and pages open as tabs in this same window (the CLI's --connect). Without Chrome, or with
// A11Y_508_OWN_BROWSER=0, the system's browser opens the address as before, and sign-in opens a
// separate window.
async function launchOwnBrowser(url) {
  let exe = process.env.A11Y_508_OWN_BROWSER_PATH || null;
  if (!exe) {
    try {
      exe = findChrome();
    } catch {
      return null;
    }
  }
  const profile = join(stateBase(), 'browser-profile');
  mkdirSync(profile, { recursive: true });
  const portFile = join(profile, 'DevToolsActivePort');
  rmSync(portFile, { force: true });
  // Its stderr is kept (the last 50 lines), so an exit can be explained (diagnostics.mjs).
  const { proc, tail, drained } = spawnOwnBrowser(exe, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-name=a11y-508', '--new-window', url]);
  let exited = false;
  proc.on('exit', () => (exited = true));
  proc.on('error', () => (exited = true));
  for (let i = 0; i < 150; i++) {
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) return { proc, port: Number(port), shared: exited, exe, profile, tail, drained };
      } catch {}
    }
    if (exited && i > 20) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    proc.kill();
  } catch {}
  return null;
}
const ownAlive = () => !!(own && !own.shared && own.proc.exitCode === null && own.proc.signalCode === null);

// Closing the dashboard's window does not end the dashboard, nor any run: the server keeps serving,
// sign-in opens a window of its own from then on, and launching the dashboard again opens it.
// Every exit is written to the diagnostics diary with its cause: exit code and signal, Chrome's last
// stderr lines, what the dashboard was doing, and an a11y-508 kill in the 5 seconds before. The
// dashboard shows the same sentence the terminal prints, with a way to reopen the window.
function watchOwn() {
  if (!own || own.shared) return;
  const mine = own;
  const pid = mine.proc.pid;
  protectPid(pid, "the dashboard's own browser");
  saveServerRecord({ ownBrowserPid: pid });
  dash.ownBrowser.opened(pid);
  writeDiary({ type: 'own-browser-start', browserPid: pid }, { source: 'server' });
  mine.proc.on('exit', async (code, signal) => {
    const at = new Date().toISOString();
    // What the dashboard was doing and the kill that came before, read at the moment it went away.
    const doing = dash.doing();
    const kill = closing ? { kill: closingReason || 'quit' } : lastKill({ withinMs: 5000 });
    await mine.drained();
    unprotectPid(pid);
    if (serverRecord.ownBrowserPid === pid) saveServerRecord({ ownBrowserPid: null });
    const entry = {
      type: 'own-browser-exit', at, browserPid: pid, code, signal, stderr: mine.tail(), expected: closing,
      doing: doing ? doing.words : null, run: doing ? { kind: doing.kind, round: doing.round, step: doing.step, n: doing.n, lastEvent: doing.lastEvent } : null,
      kill: kill ? kill.kill : null, killTarget: kill && kill.target ? kill.target : null,
    };
    entry.message = ownExitMessage(entry);
    const written = writeDiary(entry, { source: 'server' }) || entry;
    if (own !== mine || closing) return;
    own = null;
    dash.useBrowser(null, { separate: true });
    dash.ownBrowser.exited(written);
    process.stdout.write(`${entry.message} The dashboard keeps running${dash.runs.active ? ', and so does the run' : ''}; Reopen the window in the dashboard, or run the same command again. Ctrl+C here, or Quit in the dashboard, ends it.\n`);
  });
}

async function openOwnOrSystem() {
  if (process.env.A11Y_508_OWN_BROWSER !== '0') {
    own = await launchOwnBrowser(dash.url);
    if (own) {
      dash.useBrowser(own.port);
      process.stdout.write(`opened in its own browser window (profile ${join(stateBase(), 'browser-profile')}); sign-in opens as a tab there\n`);
      watchOwn();
      return;
    }
    dash.useBrowser(null, { separate: true });
    process.stdout.write('Chrome was not found for a window of its own; opening your browser, and sign-in will open a separate window\n');
  }
  openBrowser(dash.url);
}

// A second launch asked for the window: a new one in the dashboard's own browser when it still
// runs, else the dashboard's browser started again (or the system's).
async function reopen() {
  if (ownAlive()) {
    try {
      const [cmd, args] = browserCommand(own.exe, [`--user-data-dir=${own.profile}`, '--new-window', dash.url]);
      spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
      return;
    } catch {}
  }
  await openOwnOrSystem();
}

if (opt.open) await openOwnOrSystem();


// reason: why it ends, for the diagnostics diary ('ctrl-c', 'sigterm', 'quit', 'idle').
const shutdown = async (reason) => {
  if (closing) process.exit(130);
  closing = true;
  closingReason = reason;
  writeDiary({ type: 'server-stop', reason }, { source: 'server' });
  forgetServerFile();
  // Ctrl+C closes the dashboard's own browser too.
  if (ownAlive()) {
    recordKill(reason || 'quit', { target: own.proc.pid, what: "the dashboard's own browser" });
    const gone = new Promise((r) => own.proc.once('exit', () => setTimeout(r, 600)));
    try {
      own.proc.kill();
    } catch {}
    // Long enough for its exit to be written to the diary.
    await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
  }
  await dash.close();
  process.exit(0);
};
function quit() {
  process.stdout.write('Quit from the dashboard; ending it\n');
  void shutdown('quit');
}
process.on('SIGINT', () => shutdown('ctrl-c'));
process.on('SIGTERM', () => shutdown('sigterm'));

// Idle for a day (A11Y_508_IDLE_MS): no run, no page asking anything or holding a run's stream
// open (an open page asks every minute), and no window of its own: the dashboard ends.
const IDLE_MS = Number(process.env.A11Y_508_IDLE_MS) || 24 * 60 * 60 * 1000;
const idle = setInterval(() => {
  const a = dash.activity();
  if (a.running || a.streams > 0 || ownAlive()) return;
  if (Date.now() - a.lastSeen < IDLE_MS) return;
  const h = IDLE_MS / 3600000;
  process.stdout.write(`no run and no open dashboard for ${h >= 1 ? `${Math.round(h)} hours` : `${Math.round(IDLE_MS / 1000)} seconds`}; ending\n`);
  void shutdown('idle');
}, Math.min(60000, Math.max(250, Math.floor(IDLE_MS / 4))));
if (idle.unref) idle.unref();
