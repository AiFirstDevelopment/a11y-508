// One run at a time: a CLI child started with --events (or an assistant's
// install command), its events relayed to every listener and kept for replay,
// and its exit turned into a single `done` event the app can trust.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BadRequest } from './args.mjs';

// What an exit code means to a person. Exit 1 from a crawl is a finding
// (violations found), not a failure of the tool.
export function outcomeOf({ kind, code, signal, stopped }) {
  if (stopped || code === 130 || signal === 'SIGINT' || signal === 'SIGTERM') return 'stopped';
  if (code === 0) return 'ok';
  if (code === 1 && kind !== 'install') return 'findings';
  return 'error';
}

export function redactor(secrets) {
  const list = secrets.filter((s) => typeof s === 'string' && s.length >= 4);
  return (text) => {
    let t = text;
    for (const s of list) t = t.split(s).join('[redacted]');
    return t;
  };
}

// Every process id with its parent's, from CIM (wmic is gone from current Windows).
function windowsProcesses() {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return resolve([]);
    }
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve([]));
    child.on('close', () => resolve(out.split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter((x) => x.length === 2 && x[0] > 0)));
  });
}

const taskkill = (args) =>
  new Promise((resolve) => {
    const c = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
    c.on('error', resolve);
    c.on('close', resolve);
  });

// Ends pid and everything it started. taskkill /T walks the tree at that
// moment, so a process started while it runs (Chrome spawning its helpers,
// a shell forking) can escape and keep the working directory open; a second
// sweep finds those by the parent ids of the processes already ended.
export async function killTreeWindows(pid) {
  await taskkill(['/PID', String(pid), '/T', '/F']);
  const ended = new Set([pid]);
  for (let round = 0; round < 3; round++) {
    const procs = await windowsProcesses();
    const alive = new Set();
    let grew = true;
    while (grew) {
      grew = false;
      for (const [p, parent] of procs) {
        if ((ended.has(parent) || alive.has(parent)) && !ended.has(p) && !alive.has(p)) {
          alive.add(p);
          grew = true;
        }
      }
    }
    if (!alive.size) return;
    for (const p of alive) ended.add(p);
    await taskkill([...[...alive].flatMap((p) => ['/PID', String(p)]), '/T', '/F']);
  }
}

export class Runs {
  constructor({ onExit } = {}) {
    this.current = null;
    this.onExit = onExit;
  }

  get active() {
    return !!(this.current && this.current.status === 'running');
  }

  // spec: { kind, file, args, env, cwd, secrets, meta, finish }
  start(spec) {
    if (this.active) throw new BadRequest(`a ${this.current.kind} run is already active`, 409);
    const run = {
      id: randomUUID(), kind: spec.kind, status: 'running', startedAt: new Date().toISOString(), events: [], listeners: new Set(),
      stopRequests: 0, code: null, child: null, meta: spec.meta || {}, output: '', childDone: null,
    };
    const redact = redactor(spec.secrets || []);
    run.redact = redact;
    this.current = run;
    this.push(run, { type: 'run', id: run.id, kind: run.kind, ...run.meta });
    let child;
    try {
      child = spawn(spec.file, spec.args, {
        cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'],
        // Its own process group, so Stop reaches the CLI and the browser it
        // started, the way Ctrl+C in a terminal does.
        detached: process.platform !== 'win32', windowsHide: true,
      });
    } catch (e) {
      this.push(run, { type: 'error', message: `could not start: ${e.message}` });
      this.finish(run, { code: 2, signal: null });
      return run;
    }
    run.child = child;
    child.stdin.on('error', () => {});
    const lines = (stream) => {
      let partial = '';
      child[stream].on('data', (d) => {
        const parts = (partial + d).split('\n');
        partial = parts.pop();
        for (const l of parts) this.line(run, stream, redact(l.replace(/\r$/, '')), spec);
      });
      child[stream].on('end', () => {
        if (partial) this.line(run, stream, redact(partial), spec);
        partial = '';
      });
    };
    lines('stdout');
    lines('stderr');
    child.on('error', (e) => this.push(run, { type: 'error', message: `could not start: ${e.message}` }));
    child.on('close', (code, signal) => this.finish(run, { code, signal, spec }));
    return run;
  }

  // One line of the child's output: kept for the raw view, and when it is an
  // event on stdout, relayed as one.
  line(run, stream, text, spec) {
    run.output = (run.output + text + '\n').slice(-40000);
    this.push(run, { type: 'raw', stream, line: text });
    if (stream !== 'stdout' || !spec.events) return;
    let ev;
    try {
      ev = JSON.parse(text);
    } catch {
      return;
    }
    if (!ev || typeof ev.type !== 'string') return;
    if (ev.type === 'done') {
      run.childDone = ev;
      return;
    }
    this.push(run, ev);
  }

  push(run, ev) {
    const e = { ...ev, seq: run.events.length };
    run.events.push(e);
    for (const l of run.listeners) l(e);
  }

  async finish(run, { code, signal, spec }) {
    if (run.status !== 'running') return;
    const exit = run.childDone && typeof run.childDone.code === 'number' && code !== null && !signal ? run.childDone.code : code;
    const stopped = run.stopRequests > 0;
    const extra = spec && spec.finish ? await spec.finish({ code: exit, output: run.output }).catch((e) => ({ finishError: e.message })) : {};
    run.code = exit;
    run.status = 'done';
    run.finishedAt = new Date().toISOString();
    this.push(run, { type: 'done', code: exit, signal: signal || null, stopped, outcome: outcomeOf({ kind: run.kind, code: exit, signal, stopped }), ...extra });
    for (const l of run.listeners) l(null);
    run.listeners.clear();
    if (this.onExit) this.onExit(run);
  }

  signal(sig) {
    const run = this.current;
    if (!run || run.status !== 'running' || !run.child) return false;
    try {
      // Windows has no signals to send: child.kill ends only the CLI and
      // leaves its Chrome running. taskkill /T ends the whole tree, the way
      // the process group does elsewhere; it is never a clean shutdown.
      if (process.platform === 'win32') killTreeWindows(run.child.pid).catch(() => run.child.kill(sig));
      else process.kill(-run.child.pid, sig);
    } catch {
      try {
        run.child.kill(sig);
      } catch {}
    }
    return true;
  }

  // First Stop: SIGINT, the CLI's own clean shutdown. Second: SIGTERM.
  stop() {
    const run = this.current;
    if (!this.active) throw new BadRequest('no run is active', 409);
    run.stopRequests++;
    const sig = run.stopRequests === 1 ? 'SIGINT' : 'SIGTERM';
    this.push(run, { type: 'stopping', signal: sig });
    this.signal(sig);
    return sig;
  }

  continue() {
    if (!this.active) throw new BadRequest('no run is active', 409);
    this.current.child.stdin.write('\n');
  }

  // Replays from the first event, then streams. Returns an unsubscribe.
  subscribe(listener) {
    const run = this.current;
    if (!run) return null;
    for (const e of run.events) listener(e);
    if (run.status !== 'running') {
      listener(null);
      return () => {};
    }
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  // Drops a finished run, so GET /api/runs/current is null again.
  forget() {
    if (this.active) throw new BadRequest('a run is active', 409);
    this.current = null;
  }

  killAll() {
    if (this.active) this.signal('SIGKILL');
  }
}
