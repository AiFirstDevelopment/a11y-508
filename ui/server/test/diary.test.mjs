// The diagnostics diary (docs/plans/browser-diary.md): every exit of the dashboard's own browser
// is written to <state base>/diary.ndjson with its exit code, Chrome's last stderr lines, what the
// dashboard was doing and an a11y-508 kill in the 5 seconds before; and no a11y-508 kill path can
// reach the dashboard's own browser, the dashboard server, or the process doing the killing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FAKE_OWN_BROWSER, startServer, tmp } from './helpers.mjs';
import { WIN } from './platform.mjs';
import { workDir } from '../../../src/home.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const diary = (home) => (existsSync(join(home, 'diary.ndjson')) ? readFileSync(join(home, 'diary.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
async function until(fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
// A process that stands in for a run's process (a group of its own, as the journal starts one).
const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: !WIN });
const endSleeper = (p) => {
  try {
    process.kill(p.pid, 'SIGKILL');
  } catch {}
};

// A fix loop the dashboard finds running when it starts (run-journal.mjs): round 2, checking fix 3 of 5.
function runningLoop(cwd, home, pid) {
  const dir = join(workDir(cwd, { A11Y_508_HOME: home }), 'runs');
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const at = new Date().toISOString();
  writeFileSync(join(dir, `${id}.run.json`), JSON.stringify({ id, kind: 'loop', pid, startedAt: at, cwd, meta: {}, args: [], request: null }));
  const events = [
    { type: 'run', id, kind: 'loop', at },
    { type: 'start', kind: 'loop', version: '0', url: 'http://127.0.0.1:9/', at },
    { type: 'round', round: 2, at },
    { type: 'step', round: 2, step: 'fix', at },
    { type: 'task', round: 2, n: 3, m: 5, test: '6.A', impact: 'serious', message: 'x', state: 'start', at },
    { type: 'step', round: 2, step: 'gate', at },
    { type: 'gate', round: 2, n: 3, m: 5, state: 'start', check: 'npm test', at },
  ];
  writeFileSync(join(dir, `${id}.events.ndjson`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(dir, `${id}.control`), '');
}

async function dashboardWithFakeBrowser() {
  const home = tmp('a11y-508-diary-home-');
  const cwd = tmp('a11y-508-diary-cwd-');
  const run = sleeper();
  runningLoop(cwd, home, run.pid);
  const s = await startServer({ cwd, open: true, env: { A11Y_508_HOME: home, A11Y_508_OWN_BROWSER_PATH: FAKE_OWN_BROWSER, A11Y_508_NO_RESTORE: '1' } });
  await until(() => s.output().includes('opened in its own browser window'), 20000, 'the own browser');
  const port = readFileSync(join(home, 'browser-profile', 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
  const current = (await s.call('GET', '/api/runs/current')).json;
  assert.equal(current && current.status, 'running', JSON.stringify(current));
  const exitBrowser = (code) => fetch(`http://127.0.0.1:${port}/exit?code=${code}`).then((r) => r.text()).catch(() => '');
  const exitEntry = () => until(() => diary(home).find((e) => e.type === 'own-browser-exit'), 15000, 'the own-browser-exit entry');
  return { s, home, run, exitBrowser, exitEntry, done: async () => {
    endSleeper(run);
    await s.stop();
  } };
}

test('guard 1, AC1/AC3: the own browser\'s exit is written with its code, its stderr and what the dashboard was doing, and the terminal says so', async () => {
  const d = await dashboardWithFakeBrowser();
  try {
    await d.exitBrowser(3);
    const e = await d.exitEntry();
    assert.equal(e.code, 3);
    assert.equal(e.signal, null);
    assert.ok(e.stderr.some((l) => l.includes('FATAL: fake browser went away (test)')), JSON.stringify(e.stderr));
    assert.equal(e.doing, 'round 2, checking fix 3');
    assert.equal(e.run.kind, 'loop');
    assert.equal(e.run.lastEvent, 'gate');
    assert.equal(e.kill, null);
    assert.match(e.message, /^The dashboard's browser window closed at \d{1,2}:\d{2} [AP]M \(Chrome exited unexpectedly — exit code 3, signal none — during round 2, checking fix 3\)\.$/);
    await until(() => d.s.output().includes(e.message), 5000, 'the terminal line');
    const info = (await d.s.call('GET', '/api/own-browser')).json;
    assert.equal(info.status, 'closed');
    assert.equal(info.lastExit.text, e.message);
    // The diagnostics list has it, newest first, in the same words.
    const list = (await d.s.call('GET', '/api/diagnostics')).json;
    assert.equal(list.entries[0].text, e.message);
    assert.ok(list.entries.some((x) => x.type === 'server-start'));
  } finally {
    await d.done();
  }
});

test('guard 2, AC1: Stop and then the own browser going away within 5 s: the entry names the Stop', async () => {
  const d = await dashboardWithFakeBrowser();
  try {
    assert.equal((await d.s.call('POST', '/api/runs/current/stop')).status, 200);
    await d.exitBrowser(1);
    const e = await d.exitEntry();
    assert.equal(e.kill, 'stop');
    assert.match(e.message, /; a11y-508 had just run Stop\)\.$/);
    assert.ok(diary(d.home).some((x) => x.type === 'kill' && x.kill === 'stop'), 'the Stop is in the diary');
  } finally {
    await d.done();
  }
});

test('AC2: the server writes its start and its stop with the reason; a run that is interrupted is written once', async () => {
  const home = tmp('a11y-508-diary-home-');
  const cwd = tmp('a11y-508-diary-cwd-');
  // A fix loop whose process is gone: interrupted.
  const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  runningLoop(cwd, home, Number(gone.stdout.trim()));
  const s = await startServer({ cwd, env: { A11Y_508_HOME: home, A11Y_508_NO_RESTORE: '1' } });
  try {
    assert.equal((await s.call('POST', '/api/quit', { body: {} })).status, 200);
    await until(() => s.proc.exitCode !== null, 10000, 'the server to end');
  } finally {
    await s.stop();
  }
  const d = diary(home);
  assert.ok(d.some((e) => e.type === 'server-start' && e.cwd === cwd), JSON.stringify(d));
  assert.ok(d.some((e) => e.type === 'server-stop' && e.reason === 'quit'), JSON.stringify(d));
  const interrupted = d.filter((e) => e.type === 'run-ended' && e.outcome === 'interrupted');
  assert.equal(interrupted.length, 1, JSON.stringify(d));
  assert.equal(interrupted[0].doing, 'round 2, checking fix 3');
  // A second start does not write the same interruption again (the first stop removed the folder).
  mkdirSync(cwd, { recursive: true });
  const again = await startServer({ cwd, env: { A11Y_508_HOME: home, A11Y_508_NO_RESTORE: '1' } });
  await again.stop();
  assert.equal(diary(home).filter((e) => e.type === 'run-ended').length, 1);
});

test('guard 3, AC6: kill paths refuse the dashboard\'s own browser, the dashboard server and the process doing the killing', async () => {
  const home = tmp('a11y-508-diary-home-');
  const before = process.env.A11Y_508_HOME;
  process.env.A11Y_508_HOME = home;
  const { killTreeWindows } = await import('../runs.mjs');
  const { killTree } = await import('../../../src/chrome.mjs');
  const { protectPid, _resetKills } = await import('../../../src/kills.mjs');
  const own = sleeper();
  let reused = null;
  let s = null;
  try {
    // The own browser, registered as the server registers it.
    protectPid(own.pid, "the dashboard's own browser");
    const a = await killTreeWindows(own.pid, 'stop');
    assert.equal(a && a.refused, true, JSON.stringify(a));
    const b = killTree(own.pid, 'crawl-close');
    assert.equal(b && b.refused, true, JSON.stringify(b));
    await sleep(300);
    assert.equal(alive(own.pid), true, 'the own browser is still running');
    assert.ok(diary(home).some((e) => e.type === 'kill-refused' && e.target === own.pid && /^refused to kill process \d+ \(the dashboard's own browser\)/.test(e.message)), JSON.stringify(diary(home)));
    // The process doing the killing (a CLI, a server) never kills itself.
    const chrome = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'chrome.mjs');
    const self = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(chrome).href)}); console.log(JSON.stringify(m.killTree(process.pid, 'check-time-limit')));`], { encoding: 'utf8', env: { ...process.env, A11Y_508_HOME: home } });
    assert.equal(self.status, 0, self.stderr);
    assert.equal(JSON.parse(self.stdout.trim()).refused, true, self.stdout);
    // A dashboard server recorded in server-<port>.json: refused from any process.
    s = await startServer({ env: { A11Y_508_HOME: home } });
    const record = join(home, `server-${s.port}.json`);
    await until(() => existsSync(record), 5000, 'the server record');
    const serverPid = JSON.parse(readFileSync(record, 'utf8')).pid;
    _resetKills();
    const c = killTree(serverPid, 'check-time-limit');
    assert.equal(c && c.refused, true, JSON.stringify(c));
    await sleep(300);
    assert.equal(alive(serverPid), true, 'the server is still running');
    assert.equal((await s.call('GET', '/api/ping')).status, 200);
    // A record left by a dashboard that is gone protects nothing: its pids may belong to anything now.
    reused = sleeper();
    const gone = Number(spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim());
    writeFileSync(join(home, 'server-1.json'), JSON.stringify({ pid: gone, ownBrowserPid: reused.pid }));
    const r = killTree(reused.pid, 'check-time-limit');
    assert.equal(r && r.killed, true, JSON.stringify(r));
    await until(() => !alive(reused.pid), 5000, 'the process named by a stale record to be ended');
  } finally {
    endSleeper(own);
    if (reused) endSleeper(reused);
    if (s) await s.stop();
    if (before === undefined) delete process.env.A11Y_508_HOME;
    else process.env.A11Y_508_HOME = before;
  }
});

test('AC2: nothing secret reaches the diary', async () => {
  const home = tmp('a11y-508-diary-home-');
  const { addDiarySecrets, writeDiary, readDiary } = await import('../../../src/diary.mjs');
  addDiarySecrets(['sekrit-cookie-value-1']);
  writeDiary({ type: 'x', message: 'cookie: session=abc123; Authorization: Bearer eyJhbGciOi.payload.sig token=t0k3nvalue', stderr: ['value sekrit-cookie-value-1 here', 'TOKEN zz-env-token-zz'] }, { env: { A11Y_508_HOME: home, TOKEN: 'zz-env-token-zz' } });
  const text = readFileSync(join(home, 'diary.ndjson'), 'utf8');
  for (const leak of ['abc123', 'eyJhbGciOi', 't0k3nvalue', 'sekrit-cookie-value-1', 'zz-env-token-zz']) assert.ok(!text.includes(leak), `${leak} in ${text}`);
  assert.equal(readDiary({ env: { A11Y_508_HOME: home } }).length, 1);
});
