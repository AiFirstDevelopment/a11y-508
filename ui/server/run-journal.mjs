// Runs that outlive the dashboard. A crawl, a sign-in or a fix loop is started detached from the
// server (its own process group; on Windows `detached` with `windowsHide`) through run-child.mjs,
// which writes the run's events to <work folder>/runs/<id>.events.ndjson as they happen. The
// server only reads that file: it tails it while the run is live, and after a restart it finds the
// newest <id>.run.json for the folder and either reattaches (the process is alive) or reports the
// run as interrupted (the process is gone and the file has no `done`).
//
// A run object here has the fields Runs (runs.mjs) and the routes read: id, kind, status
// ('running' | 'done' | 'interrupted'), startedAt, finishedAt, code, meta, events, listeners.

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORK_DIR } from '../../src/loop.mjs';
import { loadLedger, saveLedger } from '../../src/ledger.mjs';
import { BadRequest } from './args.mjs';
import { killTreeWindows } from './runs.mjs';

export const RUN_CHILD = join(dirname(fileURLToPath(import.meta.url)), 'run-child.mjs');
export const RUNS_DIR = 'runs';
// Kinds whose run is journaled; an assistant's install stays a child of the server.
export const JOURNALED = new Set(['crawl', 'troubleshoot', 'login', 'loop', 'dry-run']);
const LOOP_KINDS = new Set(['loop', 'dry-run']);

export const runsDir = (cwd) => join(cwd, WORK_DIR, RUNS_DIR);
const filesOf = (cwd, id) => ({
  run: join(runsDir(cwd), `${id}.run.json`),
  events: join(runsDir(cwd), `${id}.events.ndjson`),
  control: join(runsDir(cwd), `${id}.control`),
});

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const writeJsonFile = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
};
const line = (ev) => JSON.stringify(ev) + '\n';

// Whether the run's process is still the one that started it: alive, and started since the
// machine last booted (after a restart the same pid can belong to anything).
export function pidAlive(pid, startedAt) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const started = Date.parse(startedAt || '');
  if (started && started < Date.now() - uptime() * 1000 - 60000) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Ends the run's process and everything under it: its process group (it leads one), or on Windows
// the process tree. Never a bare child.kill, which leaves the CLI's browser running.
function signalTree(pid, sig) {
  if (process.platform === 'win32') return killTreeWindows(pid).catch(() => {});
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {}
  }
  return Promise.resolve();
}

export class JournalRun {
  constructor(record, cwd) {
    this.journal = true;
    this.cwd = cwd;
    this.record = record;
    this.files = filesOf(cwd, record.id);
    this.id = record.id;
    this.kind = record.kind;
    this.meta = record.meta || {};
    this.startedAt = record.startedAt;
    this.finishedAt = null;
    this.code = null;
    this.status = 'running';
    this.events = [];
    this.listeners = new Set();
    this.stopRequests = 0;
    this.offset = 0;
    this.rest = Buffer.alloc(0);
    this.timer = null;
    this.onEnd = null;
    this.child = null;
    this.lastAt = null;
  }

  get pid() {
    return this.record.pid;
  }

  // Reads what the file has gained since the last read; whole lines only.
  read() {
    if (!existsSync(this.files.events)) return;
    let fd;
    try {
      fd = openSync(this.files.events, 'r');
      const size = statSync(this.files.events).size;
      if (size <= this.offset) return;
      const buf = Buffer.alloc(size - this.offset);
      const n = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += n;
      let data = Buffer.concat([this.rest, buf.subarray(0, n)]);
      let i;
      while ((i = data.indexOf(10)) >= 0) {
        const text = data.subarray(0, i).toString('utf8');
        data = data.subarray(i + 1);
        if (!text.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(text);
        } catch {
          continue;
        }
        if (ev && typeof ev.type === 'string') this.take(ev);
      }
      this.rest = data;
    } catch {
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  take(ev) {
    if (this.status !== 'running') return;
    if (ev.at) this.lastAt = ev.at;
    if (ev.type === 'done') return this.end('done', ev);
    this.push(ev);
  }

  push(ev) {
    const e = { ...ev, seq: this.events.length };
    this.events.push(e);
    for (const l of this.listeners) l(e);
  }

  end(status, ev) {
    if (this.status !== 'running') return;
    this.stopTail();
    this.push(ev);
    this.status = status;
    this.code = typeof ev.code === 'number' ? ev.code : null;
    this.finishedAt = ev.at || new Date().toISOString();
    for (const l of this.listeners) l(null);
    this.listeners.clear();
    if (this.onEnd) this.onEnd(this);
  }

  // The process is gone: one last read for a `done` it wrote; without one, a Stop that ended it
  // forcibly is recorded as stopped, and anything else is an interruption.
  gone() {
    this.read();
    if (this.status !== 'running') return;
    if (this.stopRequests > 0) {
      const ev = { type: 'done', at: new Date().toISOString(), code: null, signal: null, stopped: true, outcome: 'stopped' };
      try {
        appendFileSync(this.files.events, line(ev));
      } catch {}
      this.read();
      if (this.status === 'running') this.end('done', ev);
      return;
    }
    this.end('interrupted', { type: 'done', at: new Date().toISOString(), code: null, signal: null, stopped: false, outcome: 'interrupted', interrupted: interruptionOf(this) });
  }

  tail(ms = 200) {
    this.read();
    if (this.status !== 'running') return;
    let n = 0;
    this.timer = setInterval(() => {
      this.read();
      // Liveness about once a second (the child's own exit event says so sooner).
      if (this.status === 'running' && ++n % 5 === 0 && !pidAlive(this.pid, this.startedAt)) this.gone();
    }, ms);
    if (this.timer.unref) this.timer.unref();
  }

  stopTail() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // First Stop: SIGINT, the CLI's own clean shutdown; the second SIGTERM. Windows has no signals:
  // the tree is ended. Whatever still runs 3 seconds after the first Stop is ended forcibly.
  stop() {
    if (this.status !== 'running') throw new BadRequest('no run is active', 409);
    this.stopRequests++;
    const sig = this.stopRequests === 1 ? 'SIGINT' : 'SIGTERM';
    try {
      appendFileSync(this.files.events, line({ type: 'stopping', signal: sig, at: new Date().toISOString() }));
    } catch {}
    this.read();
    signalTree(this.pid, sig);
    if (this.stopRequests === 1) {
      const t = setTimeout(() => {
        if (this.status !== 'running') return;
        signalTree(this.pid, 'SIGKILL').then(() => setTimeout(() => this.status === 'running' && !pidAlive(this.pid, this.startedAt) && this.gone(), 200));
      }, 3000);
      if (t.unref) t.unref();
    }
    return sig;
  }

  // "Deployed — continue" and the sign-in's Enter: a line in the control file, which the run's
  // process reads and passes to the CLI as Enter.
  continue() {
    if (this.status !== 'running') throw new BadRequest('no run is active', 409);
    appendFileSync(this.files.control, 'continue\n');
  }

  // The dashboard ends (Ctrl+C, Quit): the run ends with it, recorded as stopped.
  async kill() {
    if (this.status !== 'running') return;
    this.stopRequests++;
    await signalTree(this.pid, 'SIGKILL');
    this.gone();
  }
}

// Where the loop was when it stopped answering: the last fix it started, the round, and the time
// of its last event.
function interruptionOf(run) {
  let round = null;
  let task = null;
  for (const e of run.events) {
    if (e.type === 'round') round = e.round;
    if (e.type === 'task' && e.state === 'start') task = { n: e.n, m: e.m, round: e.round };
    if (e.type === 'task' && e.state === 'done' && task && task.n === e.n) task = null;
  }
  let at = run.lastAt;
  if (!at) {
    try {
      at = statSync(run.files.events).mtime.toISOString();
    } catch {
      at = run.startedAt;
    }
  }
  return { at, round, n: task ? task.n : null, m: task ? task.m : null };
}

// Starts a run detached. spec: { kind, file, args, env, cwd, secrets, meta, request, preface }.
export function startJournaled(spec) {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  mkdirSync(runsDir(spec.cwd), { recursive: true });
  const files = filesOf(spec.cwd, id);
  const redact = (t) => (spec.secrets || []).filter((s) => typeof s === 'string' && s.length >= 4).reduce((x, s) => x.split(s).join('[redacted]'), t);
  // The run event and anything the server has to say first, before the run's process writes.
  writeFileSync(files.events, [{ type: 'run', id, kind: spec.kind, at: startedAt, ...(spec.meta || {}) }, ...(spec.preface || [])].map(line).join(''));
  writeFileSync(files.control, '');
  const record = {
    id, kind: spec.kind, pid: null, startedAt, cwd: spec.cwd, url: (spec.meta && spec.meta.url) || null,
    args: spec.args.map((a) => redact(String(a))), meta: spec.meta || {}, request: spec.request || null,
  };
  const run = new JournalRun(record, spec.cwd);
  let child;
  try {
    child = spawn(process.execPath, [RUN_CHILD], {
      cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'ignore', 'ignore'],
      // Its own process group (a session of its own on POSIX), so it outlives the server and its
      // terminal, and Stop reaches the CLI and the browser it started, as Ctrl+C in a terminal does.
      detached: true, windowsHide: true,
    });
  } catch (e) {
    appendFileSync(files.events, line({ type: 'error', message: `could not start: ${e.message}`, at: new Date().toISOString() }) + line({ type: 'done', code: 2, signal: null, stopped: false, outcome: 'error', at: new Date().toISOString() }));
    writeJsonFile(files.run, record);
    run.read();
    return run;
  }
  record.pid = child.pid;
  writeJsonFile(files.run, record);
  run.child = child;
  child.on('error', (e) => {
    try {
      appendFileSync(files.events, line({ type: 'error', message: `could not start: ${e.message}`, at: new Date().toISOString() }) + line({ type: 'done', code: 2, signal: null, stopped: false, outcome: 'error', at: new Date().toISOString() }));
    } catch {}
    run.read();
  });
  child.on('exit', () => setTimeout(() => run.status === 'running' && run.gone(), 100));
  child.stdin.on('error', () => {});
  // The secrets travel on stdin, never through a file.
  child.stdin.end(JSON.stringify({ kind: spec.kind, file: spec.file, args: spec.args, cwd: spec.cwd, events: spec.events !== false, secrets: spec.secrets || [], eventsFile: files.events, controlFile: files.control }));
  child.unref();
  run.tail();
  return run;
}

// The newest run recorded for the folder, as a run object: reattached and tailed when its process
// is alive; finished; or interrupted. Null when there is none, or it was already dealt with.
export function latestRun(cwd) {
  const dir = runsDir(cwd);
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.run.json'));
  } catch {
    return null;
  }
  const records = names.map((n) => readJson(join(dir, n))).filter((r) => r && typeof r.id === 'string' && /^[0-9a-f-]{36}$/.test(r.id) && r.startedAt);
  if (!records.length) return null;
  records.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const record = records[0];
  if (record.resolved) return null;
  const run = new JournalRun(record, cwd);
  run.read();
  if (run.status !== 'running') return run;
  if (pidAlive(record.pid, record.startedAt)) {
    run.tail();
    return run;
  }
  run.gone();
  return run;
}

// Marks a run's record as dealt with (Continue, Start over), so a restart does not offer it again.
export function resolveRun(run, how) {
  try {
    const r = readJson(run.files.run);
    if (r) writeJsonFile(run.files.run, { ...r, resolved: how });
  } catch {}
}

// ---- Continue after an interruption

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

// The attempt the loop had begun when it was interrupted: a ledger attempt with no outcome.
export function attemptsInProgress(cwd) {
  const file = join(cwd, WORK_DIR, 'ledger.json');
  if (!existsSync(file)) return [];
  const ledger = loadLedger(file);
  const out = [];
  for (const e of Object.values(ledger.findings || {})) for (const a of e.attempts || []) if (!a.outcome) out.push({ entry: e, attempt: a });
  return out;
}

// The uncommitted changes under the folders the loop edits, as paths relative to the repository's
// top, with whether git tracks each. Paths outside the source folders are never listed.
export function changesUnder(cwd, sourceDirs) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return { top: null, files: [] };
  const root = resolve(top.stdout.trim());
  const specs = sourceDirs.filter((d) => typeof d === 'string' && d).map((d) => resolve(cwd, d)).filter((p) => {
    const r = relative(root, p);
    return !r.startsWith('..') && !isAbsolute(r);
  });
  if (!specs.length) return { top: root, files: [] };
  const r = git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...specs.map((p) => relative(root, p) || '.')]);
  const parts = (r.stdout || '').split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    files.push({ path: p.slice(3), tracked: xy !== '??' && xy[0] !== 'A' });
    // A rename's source follows as its own entry.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }
  return { top: root, files };
}

// What Continue would discard: the changes under the source folders, but only when the ledger has
// an attempt in progress (otherwise they are the person's own and stay).
export function interruptedDetails(cwd, run, sourceDirs) {
  const done = run.events.find((e) => e.type === 'done');
  const where = (done && done.interrupted) || interruptionOf(run);
  const inProgress = attemptsInProgress(cwd);
  const discard = inProgress.length ? changesUnder(cwd, sourceDirs).files.map((f) => f.path) : [];
  return { ...where, kind: run.kind, attemptInProgress: inProgress.length > 0, discard };
}

// Marks the attempts in progress `interrupted` and reverts their uncommitted changes under the
// source folders (tracked files restored, new files removed). Returns the paths discarded.
export function discardInterrupted(cwd, sourceDirs) {
  const file = join(cwd, WORK_DIR, 'ledger.json');
  const inProgress = attemptsInProgress(cwd);
  if (!inProgress.length) return [];
  const { top, files } = changesUnder(cwd, sourceDirs);
  if (top && files.length) {
    const all = files.map((f) => f.path);
    git(top, ['reset', '-q', '--', ...all]);
    const tracked = files.filter((f) => f.tracked).map((f) => f.path);
    if (tracked.length) git(top, ['checkout', '--', ...tracked]);
    const fresh = files.filter((f) => !f.tracked).map((f) => f.path);
    if (fresh.length) git(top, ['clean', '-fq', '--', ...fresh]);
  }
  const ledger = loadLedger(file);
  for (const e of Object.values(ledger.findings || {})) for (const a of e.attempts || []) if (!a.outcome) {
    a.outcome = 'interrupted';
    a.files = a.files || files.map((f) => f.path);
  }
  saveLedger(file, ledger);
  return files.map((f) => f.path);
}

export { LOOP_KINDS };
