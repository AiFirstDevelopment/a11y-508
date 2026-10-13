// Runs outlive the dashboard (docs/plans/resume.md): a run is started detached and recorded under
// <folder>/a11y-508-work/runs/; a server that dies leaves it running; a new server reattaches to it
// with its whole log, or reports a fix loop whose process is gone as interrupted. One dashboard per
// port: a second launch opens the running one. An idle dashboard ends after a day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAIN, startServer, tmp } from './helpers.mjs';
import { WIN, mergeEnv, recordOpen, stopTree } from './platform.mjs';
import { killTreeWindows } from '../runs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const runsDir = (cwd) => join(cwd, 'a11y-508-work', 'runs');
const records = (cwd) => (existsSync(runsDir(cwd)) ? readdirSync(runsDir(cwd)).filter((n) => n.endsWith('.run.json')).map((n) => JSON.parse(readFileSync(join(runsDir(cwd), n), 'utf8'))) : []);
async function until(fn, ms = 30000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
// The run's whole process tree, whatever the test's outcome.
async function endRun(pid) {
  if (!pid || !alive(pid)) return;
  if (WIN) await killTreeWindows(pid);
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
}
// What an event stream sends within ms (a live run's stream does not end).
function streamFor(s, ms) {
  return new Promise((ok, fail) => {
    let text = '';
    const req = request({ host: '127.0.0.1', port: s.port, path: '/api/runs/current/events', headers: { host: `127.0.0.1:${s.port}`, 'x-a11y-508-secret': s.secret } }, (res) => {
      res.on('data', (d) => (text += d));
      res.on('end', () => ok(text));
    });
    req.on('error', (e) => (text ? ok(text) : fail(e)));
    req.end();
    setTimeout(() => {
      req.destroy();
      ok(text);
    }, ms);
  });
}
const eventsOf = (text) => text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));

// A page that never finishes loading: the crawl stays busy and reports progress every ~2 s.
async function hangingSite() {
  const hang = createServer(() => {});
  await new Promise((ok) => hang.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${hang.address().port}/`, close: () => (hang.closeAllConnections?.(), hang.close()) };
}

test('resume AC2/AC3, guards 2 and 3: a run outlives a server that dies, and a new server reattaches with its whole log; Stop still works', async () => {
  const site = await hangingSite();
  const cwd = tmp('a11y-508-resume-');
  const home = tmp('a11y-508-home-');
  // The dashboard as a terminal starts it: a process group of its own, which closing the terminal
  // ends as a whole (here: SIGKILL to the group). On Windows the server process alone is ended.
  const proc = spawn(process.execPath, [MAIN, '--no-open', '--port', '0'], { cwd, env: mergeEnv(process.env, { TOKEN: '', A11Y_508_HOME: home }), stdio: ['ignore', 'pipe', 'pipe'], detached: !WIN });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  let pid = null;
  let s2 = null;
  try {
    const url = await until(() => /open: (http:\S+)/.exec(out)?.[1], 30000, 'the first server');
    const u = new URL(url);
    const secret = /secret=([0-9a-f]+)/.exec(u.hash)[1];
    const res = await fetch(`${u.origin}/api/runs`, { method: 'POST', headers: { 'x-a11y-508-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'crawl', url: site.url, options: { timeout: '120000' }, auth: { mode: 'none' } }) });
    assert.equal(res.status, 202, await res.text());
    // AC2: run.json with kind, args, pid, startedAt, cwd, url; the events file is the stream.
    const rec = await until(() => records(cwd).find((r) => r.pid), 10000, 'run.json');
    pid = rec.pid;
    assert.equal(rec.kind, 'crawl');
    assert.equal(rec.cwd, cwd);
    assert.equal(rec.url, site.url);
    assert.ok(Array.isArray(rec.args) && rec.args.includes(site.url) && rec.args.includes('--events'), JSON.stringify(rec.args));
    assert.ok(Date.parse(rec.startedAt));
    const events = join(runsDir(cwd), `${rec.id}.events.ndjson`);
    await until(() => existsSync(events) && readFileSync(events, 'utf8').includes('"type":"progress"'), 60000, 'progress events');
    const first = readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(first[0].type, 'run');
    assert.equal(first[0].id, rec.id);

    // The server dies with its process group (the terminal closed).
    if (WIN) process.kill(proc.pid);
    else process.kill(-proc.pid, 'SIGKILL');
    await until(() => proc.exitCode !== null || proc.signalCode !== null, 10000, 'the server to end');
    await sleep(500);
    assert.ok(alive(pid), 'the run process outlived the server');
    const size = statSync(events).size;
    await until(() => statSync(events).size > size, 15000, 'the events file to keep growing');

    // AC3: a new server for the folder reattaches: the run is live, and its stream starts at the first event.
    s2 = await startServer({ cwd, env: { A11Y_508_HOME: home } });
    const cur = (await s2.call('GET', '/api/runs/current')).json;
    assert.equal(cur && cur.id, rec.id);
    assert.equal(cur.status, 'running');
    const seen = eventsOf(await streamFor(s2, 2500));
    assert.equal(seen[0] && seen[0].type, 'run', 'the reattached stream starts with the run event');
    assert.equal(seen[0].seq, 0);
    assert.ok(seen.some((e) => e.type === 'raw'), 'the earlier output lines are there');
    assert.ok(seen.filter((e) => e.type === 'progress').length >= first.filter((e) => e.type === 'progress').length, 'every earlier progress event is replayed');
    // Stop still works: the process tree ends and the run is recorded as stopped.
    assert.equal((await s2.call('POST', '/api/runs/current/stop')).status, 200);
    const done = await s2.waitDone(30000);
    assert.equal(done.status, 'done');
    await until(() => !alive(pid), 10000, 'the run process to end');
    assert.match(readFileSync(events, 'utf8'), /"type":"done"[^\n]*"outcome":"stopped"/);
  } finally {
    await endRun(pid);
    if (proc.exitCode === null && proc.signalCode === null) await stopTree(proc);
    if (s2) await s2.stop();
    site.close();
  }
});

// A finished process's pid: dead by the time it is used.
async function deadPid() {
  const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => p.on('exit', r));
  return p.pid;
}

// An interrupted fix loop on disk: its run.json names a process that is gone and its events have no done.
export async function interruptedLoop(cwd, { n = 8, m = 20, at = '2026-10-13T16:52:00.000Z', request = {} } = {}) {
  const id = '11111111-2222-4333-8444-555555555555';
  mkdirSync(runsDir(cwd), { recursive: true });
  const startedAt = new Date(Date.now() - 3600000).toISOString();
  writeFileSync(join(runsDir(cwd), `${id}.run.json`), JSON.stringify({ id, kind: 'loop', pid: await deadPid(), startedAt, cwd, url: request.url || null, args: [], meta: { url: request.url || null }, request: { kind: 'loop', ...request } }));
  const evs = [
    { type: 'run', id, kind: 'loop', at: startedAt },
    { type: 'round', round: 1, at: startedAt },
    { type: 'step', round: 1, step: 'fix', count: m, at: startedAt },
    { type: 'task', round: 1, n, m, test: '1.A', message: 'An image has no text alternative', state: 'start', at },
    { type: 'agent-output', round: 1, task: n, kind: 'fix', stream: 'stdout', text: 'editing src/app.html\n', at },
  ];
  writeFileSync(join(runsDir(cwd), `${id}.events.ndjson`), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return id;
}

test('resume AC3: a loop whose process is gone and whose events have no done is interrupted, with where it was', async () => {
  const cwd = tmp('a11y-508-intr-');
  const id = await interruptedLoop(cwd);
  const s = await startServer({ cwd });
  try {
    const cur = (await s.call('GET', '/api/runs/current')).json;
    assert.equal(cur.id, id);
    assert.equal(cur.status, 'interrupted');
    const evs = eventsOf((await s.call('GET', '/api/runs/current/events')).text);
    const done = evs[evs.length - 1];
    assert.equal(done.type, 'done');
    assert.equal(done.outcome, 'interrupted');
    assert.deepEqual([done.interrupted.n, done.interrupted.m, done.interrupted.at], [8, 20, '2026-10-13T16:52:00.000Z']);
    const info = (await s.call('GET', '/api/runs/interrupted')).json;
    assert.equal(info.n, 8);
    assert.equal(info.m, 20);
    assert.match(s.output(), /was interrupted; the Fix step offers to continue it/);
  } finally {
    await s.stop();
  }
});

test('resume AC1: a second launch on the same port opens the running dashboard instead of starting another', async () => {
  // A free port, for two launches that both ask for it.
  const probe = createServer();
  await new Promise((ok) => probe.listen(0, '127.0.0.1', ok));
  const port = probe.address().port;
  await new Promise((ok) => probe.close(ok));
  const home = tmp('a11y-508-home-');
  const bin = tmp('a11y-508-openbin-');
  const opened = join(bin, 'opened.txt');
  const env = mergeEnv(process.env, { TOKEN: '', A11Y_508_HOME: home, A11Y_508_OWN_BROWSER: '0', PATH: `${bin}${WIN ? ';' : ':'}${process.env.PATH}`, ...recordOpen(bin, opened) });
  const cwd = tmp('a11y-508-twice-');
  const first = spawn(process.execPath, [MAIN, '--no-open', '--port', String(port)], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  first.stdout.on('data', (d) => (out += d));
  first.stderr.on('data', (d) => (out += d));
  try {
    const url = await until(() => /open: (http:\S+)/.exec(out)?.[1], 30000, 'the first server');
    assert.equal(new URL(url).port, String(port));
    const second = spawn(process.execPath, [MAIN, '--port', String(port)], { cwd: tmp('a11y-508-twice2-'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out2 = '';
    second.stdout.on('data', (d) => (out2 += d));
    second.stderr.on('data', (d) => (out2 += d));
    const code = await new Promise((r) => second.on('exit', r));
    assert.equal(code, 0, out2);
    assert.match(out2, new RegExp(`already running for .*; using it instead of starting another`));
    assert.ok(out2.includes(`open: ${url}`), out2);
    assert.match(out2, /opened it in the browser/);
    // The running one opened its address in the browser.
    await until(() => existsSync(opened) && readFileSync(opened, 'utf8').includes(`127.0.0.1:${port}/#secret=`), 10000, 'the browser to open');
    assert.ok(first.exitCode === null, 'the first dashboard still runs');
  } finally {
    await stopTree(first);
  }
});

test('resume AC1: Quit ends the dashboard (asking first when a run is active), and an idle dashboard ends by itself', async () => {
  const site = await hangingSite();
  const s = await startServer();
  let pid = null;
  try {
    assert.equal((await s.call('POST', '/api/runs', { body: { kind: 'crawl', url: site.url, options: { timeout: '60000' }, auth: { mode: 'none' } } })).status, 202);
    pid = (await until(() => records(s.cwd).find((r) => r.pid), 10000, 'run.json')).pid;
    const refused = await s.call('POST', '/api/quit', { body: {} });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.kind, 'crawl');
    assert.equal((await s.call('POST', '/api/quit', { body: { stopRun: true } })).status, 200);
    await until(() => /Quit from the dashboard; ending it/.test(s.output()), 10000, 'quit');
    await until(() => !alive(pid), 15000, 'the run to end with the dashboard');
  } finally {
    await endRun(pid);
    await s.stop();
    site.close();
  }
  const idle = await startServer({ env: { A11Y_508_IDLE_MS: '1500' } });
  try {
    await until(() => /no run and no open dashboard for 2 seconds; ending/.test(idle.output()), 15000, 'the idle shutdown');
  } finally {
    await idle.stop();
  }
});

test('resume: cookies and extra headers never reach the run record or its events file, which are owner-only', async () => {
  const site = await hangingSite();
  const s = await startServer();
  let pid = null;
  try {
    const r = await s.call('POST', '/api/runs', { body: { kind: 'crawl', url: site.url, options: { timeout: '60000', header: ['X-Api-Key: HEADERSECRET789xyz'] }, auth: { mode: 'cookies', cookies: 'sid=COOKIESECRET123' } } });
    assert.equal(r.status, 202, r.text);
    const rec = await until(() => records(s.cwd).find((x) => x.pid), 10000, 'run.json');
    pid = rec.pid;
    await sleep(2000);
    for (const n of readdirSync(runsDir(s.cwd))) {
      const text = readFileSync(join(runsDir(s.cwd), n), 'utf8');
      for (const secret of ['COOKIESECRET123', 'HEADERSECRET789xyz']) assert.ok(!text.includes(secret), `${n} holds ${secret}`);
      if (!WIN) assert.equal(statSync(join(runsDir(s.cwd), n)).mode & 0o077, 0, `${n} is owner-only`);
    }
    assert.ok(rec.args.some((a) => a.includes('[redacted]')), JSON.stringify(rec.args));
    await s.call('POST', '/api/runs/current/stop');
    await s.waitDone(30000);
  } finally {
    await endRun(pid);
    await s.stop();
    site.close();
  }
});
