// The process that carries one run for the dashboard, detached from it (run-journal.mjs starts
// it). It reads the run from stdin (the command, and the secrets to keep out of the record),
// starts the CLI, and appends every line of its output to the run's events file as the dashboard
// receives it: a `raw` event per line, the CLI's own events as they are, and one `done` at the end.
// It outlives the dashboard and its terminal; the dashboard reads the file, now or after a restart.

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readSync, statSync } from 'node:fs';
import { outcomeOf, redactor } from './runs.mjs';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const spec = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const redact = redactor(spec.secrets || []);
const write = (ev) => {
  try {
    appendFileSync(spec.eventsFile, JSON.stringify({ ...ev, at: ev.at || new Date().toISOString() }) + '\n');
  } catch {}
};

// Stop reaches this process group: the CLI shuts down cleanly and this process records it.
let stopped = false;
process.on('SIGINT', () => (stopped = true));
process.on('SIGTERM', () => (stopped = true));

let child;
try {
  child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
} catch (e) {
  write({ type: 'error', message: `could not start: ${e.message}` });
  write({ type: 'done', code: 2, signal: null, stopped: false, outcome: 'error' });
  process.exit(0);
}
child.stdin.on('error', () => {});

let childDone = null;
const onLine = (stream, text) => {
  write({ type: 'raw', stream, line: text });
  if (stream !== 'stdout' || !spec.events) return;
  let ev;
  try {
    ev = JSON.parse(text);
  } catch {
    return;
  }
  if (!ev || typeof ev.type !== 'string') return;
  if (ev.type === 'done') {
    childDone = ev;
    return;
  }
  write(ev);
};
for (const stream of ['stdout', 'stderr']) {
  let partial = '';
  child[stream].on('data', (d) => {
    const parts = (partial + d).split('\n');
    partial = parts.pop();
    for (const l of parts) onLine(stream, redact(l.replace(/\r$/, '')));
  });
  child[stream].on('end', () => {
    if (partial) onLine(stream, redact(partial));
    partial = '';
  });
}

// The dashboard's Enter ("Deployed — continue", the sign-in's wait): lines in the control file.
let offset = 0;
const control = setInterval(() => {
  let fd;
  try {
    const size = statSync(spec.controlFile).size;
    if (size <= offset) return;
    fd = openSync(spec.controlFile, 'r');
    const buf = Buffer.alloc(size - offset);
    offset += readSync(fd, buf, 0, buf.length, offset);
    for (const l of buf.toString('utf8').split('\n')) {
      const word = l.trim();
      if (word === 'continue') child.stdin.write('\n');
      else if (word === 'fix-remaining' || word === 'stop-waiting') child.stdin.write(`${word}\n`);
    }
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}, 250);

let errored = false;
child.on('error', (e) => {
  errored = true;
  write({ type: 'error', message: `could not start: ${e.message}` });
});
child.on('close', (code, signal) => {
  clearInterval(control);
  const exit = childDone && typeof childDone.code === 'number' && code !== null && !signal ? childDone.code : errored && code === null ? 2 : code;
  // The CLI's own reason for failing (a browser that went away), carried on the outcome.
  const reason = childDone && typeof childDone.reason === 'string' ? { reason: childDone.reason } : {};
  write({ type: 'done', code: exit, signal: signal || null, stopped, outcome: outcomeOf({ kind: spec.kind, code: exit, signal, stopped }), ...reason });
  process.exit(0);
});
