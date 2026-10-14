import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './helpers.mjs';
import { argPattern } from './platform.mjs';

test('one run at a time: 409 while active, Stop ends it', async () => {
  // A page that never finishes loading keeps the run busy.
  const hang = createServer(() => {});
  await new Promise((ok) => hang.listen(0, '127.0.0.1', ok));
  const s = await startServer();
  try {
    const url = `http://127.0.0.1:${hang.address().port}/`;
    const first = await s.call('POST', '/api/runs', { body: { kind: 'troubleshoot', url, options: { timeout: '60000' }, auth: { mode: 'none' } } });
    assert.equal(first.status, 202, first.text);
    const second = await s.call('POST', '/api/runs', { body: { kind: 'crawl', url, options: {}, auth: { mode: 'none' } } });
    assert.equal(second.status, 409);
    assert.equal((await s.call('POST', '/api/agent/install', { body: { agent: 'codex' } })).status, 409);
    assert.equal((await s.call('POST', '/api/runs/current/stop')).status, 200);
    const done = await s.waitDone(20000);
    assert.equal(done.status, 'done');
    const ev = await s.call('GET', '/api/runs/current/events');
    assert.match(ev.text, /"outcome":"stopped"/);
  } finally {
    await s.stop();
    hang.closeAllConnections?.();
    hang.close();
  }
});

test('bad forms are 400 with the core\'s message', async () => {
  const s = await startServer();
  try {
    const r = await s.call('POST', '/api/runs', { body: { kind: 'crawl', url: 'http://x/', options: { 'fail-on': 'loud' }, auth: { mode: 'none' } } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /--fail-on: unknown impact "loud"/);
    assert.equal((await s.call('POST', '/api/runs', { body: { kind: 'crawl', url: 'http://x/', options: { out: '/tmp/x' } } })).status, 400);
    assert.equal((await s.call('POST', '/api/runs', { body: { kind: 'rm', url: 'http://x/' } })).status, 400);
    const cmd = await s.call('GET', '/api/command?form=' + encodeURIComponent(JSON.stringify({ kind: 'crawl', url: 'http://x/', options: { 'max-pages': '5' }, auth: { mode: 'token', token: 'never-shown' } })));
    assert.match(cmd.json.command, /^TOKEN=\$TOKEN node \S+ http:\/\/x\/ --max-pages 5$/);
    assert.ok(!cmd.text.includes('never-shown'));
    // The dashboard's Sign in: one crawl that signs in and stays in the window.
    const signin = await s.call('GET', '/api/command?form=' + encodeURIComponent(JSON.stringify({ kind: 'crawl', url: 'http://x/', options: {}, auth: { mode: 'signin' } })));
    // The session file is the dashboard's own, outside the working directory.
    const stateFile = (await s.call('GET', '/api/env')).json.session.file;
    assert.match(signin.json.command, /^node \S+ http:\/\/x\/ --login --stay --state /);
    assert.match(signin.json.command, argPattern('--state', stateFile, '--login --stay '));
    assert.match(stateFile, /[\\/]state\.json$/);
  } finally {
    await s.stop();
  }
});

test('before a crawl the previous report moves to history/<finishedAt>/, in the tool\'s own folder', async () => {
  const s = await startServer();
  try {
    mkdirSync(s.dirs().report, { recursive: true });
    writeFileSync(join(s.dirs().report, 'report.json'), JSON.stringify({ finishedAt: '2026-01-02T03:04:05.000Z', summary: {}, pages: [] }));
    const r = await s.call('POST', '/api/runs', { body: { kind: 'crawl', url: 'http://127.0.0.1:9/', options: { 'no-interact': true, 'no-zoom': true }, auth: { mode: 'none' } } });
    assert.equal(r.status, 202, r.text);
    assert.deepEqual(readdirSync(s.dirs().history), ['2026-01-02T03-04-05.000Z']);
    assert.ok(existsSync(join(s.dirs().history, '2026-01-02T03-04-05.000Z', 'report.json')));
    await s.waitDone();
    const list = await s.call('GET', '/api/reports');
    assert.ok(list.json.some((e) => e.id === 'h-2026-01-02T03-04-05.000Z' && e.source === 'history'));
  } finally {
    await s.stop();
  }
});

test('the shown command is written for the shell: POSIX (Git Bash too), PowerShell, cmd', async () => {
  const { commandLine, BIN } = await import('../args.mjs');
  const args = ['http://x/', '--max-pages', '5', '--include', 'a b'];
  const cwd = join(BIN, '..', '..');
  const rel = join('bin', 'a11y-508.mjs'); // bin\a11y-508.mjs on Windows, which sh syntax quotes
  const sh = rel.includes('\\') ? `'${rel}'` : rel;
  assert.equal(commandLine({ cwd, args, token: 'form' }), `TOKEN=$TOKEN node ${sh} http://x/ --max-pages 5 --include 'a b'`);
  assert.equal(commandLine({ cwd, args, token: 'form', shell: 'bash' }), `TOKEN=$TOKEN node ${sh} http://x/ --max-pages 5 --include 'a b'`);
  assert.equal(commandLine({ cwd, args, token: 'form', shell: 'powershell' }), `$env:TOKEN='...'; node ${rel} http://x/ --max-pages 5 --include 'a b'`);
  assert.equal(commandLine({ cwd, args, token: 'none', shell: 'cmd' }), `node ${rel} http://x/ --max-pages 5 --include "a b"`);
});

test('deleting reports: history entries only, confined to the history folder, behind the secret', async () => {
  const s = await startServer();
  try {
    const rep = (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'report.json'), JSON.stringify({ finishedAt: '2026-01-02T03:04:05.000Z', summary: {}, pages: [] }));
    };
    rep(s.dirs().report);
    rep(join(s.dirs().work, 'round-1'));
    rep(join(s.dirs().history, 'one'));
    rep(join(s.dirs().history, 'two'));
    // Outside the history directory, or not a history id: refused, nothing removed.
    for (const id of ['latest', 'round-1', 'h-..', encodeURIComponent('h-../report'), encodeURIComponent('../report'), 'h-.hidden']) {
      const r = await s.call('DELETE', `/api/reports/${id}`);
      assert.ok([400, 404].includes(r.status), `${id}: ${r.status}`);
    }
    assert.equal((await s.call('DELETE', '/api/reports/h-missing')).status, 404);
    assert.equal((await s.call('DELETE', '/api/reports/history', { secret: 'wrong' })).status, 401);
    assert.ok(existsSync(join(s.dirs().report, 'report.json')));
    assert.ok(existsSync(join(s.dirs().work, 'round-1', 'report.json')));
    assert.deepEqual(readdirSync(s.dirs().history).sort(), ['one', 'two']);
    // One entry, then the rest.
    const one = await s.call('DELETE', '/api/reports/h-one');
    assert.equal(one.status, 200);
    assert.deepEqual(readdirSync(s.dirs().history), ['two']);
    const all = await s.call('DELETE', '/api/reports/history');
    assert.equal(all.status, 200);
    assert.equal(all.json.removed, 1);
    assert.deepEqual(readdirSync(s.dirs().history), []);
    assert.ok(existsSync(join(s.dirs().report, 'report.json')), 'the latest report stays');
    assert.ok(existsSync(join(s.dirs().work, 'round-1', 'report.json')), 'the loop rounds stay');
  } finally {
    await s.stop();
  }
});

test('the fix loop timeline from the ledger, and clearing the loop history (rounds and ledger only)', async () => {
  const s = await startServer();
  try {
    const work = s.dirs().work;
    mkdirSync(join(work, 'round-1'), { recursive: true });
    mkdirSync(join(work, 'round-2'), { recursive: true });
    writeFileSync(join(work, 'prompt-r2-fix-0.md'), 'x');
    const e = (status, attempts = []) => ({ status, test: '7.A', impact: 'serious', message: 'm', pages: ['/'], attempts, selector: 'img' });
    writeFileSync(join(work, 'ledger.json'), JSON.stringify({
      version: 1,
      rounds: [
        { round: 1, at: '2026-01-01T00:00:00.000Z', pages: 2, audited: 2, violations: 5, reviews: 1, diff: { new: 5, verified: 0, failed: 0 } },
        { round: 2, at: '2026-01-01T01:00:00.000Z', pages: 2, audited: 2, violations: 3, reviews: 1, diff: { new: 0, verified: 2, failed: 0 } },
      ],
      findings: { a: e('verified', [{ round: 1, commit: 'abc', outcome: 'pending' }]), b: e('verified', [{ round: 1, commit: 'def', outcome: 'pending' }]), c: e('open'), d: e('open'), f: e('needs-human') },
    }));
    const t = await s.call('GET', '/api/loop/timeline');
    assert.deepEqual(t.json.rounds.map((r) => [r.round, r.found, r.fixed, r.verified, r.commits, r.remaining]), [[1, 5, 2, 0, 2, 3], [2, 3, 0, 2, 0, 2]]);
    assert.ok(!('needsHuman' in t.json.rounds[1]), 'nothing about a person');
    assert.deepEqual(t.json.total, { rounds: 2, fixed: 2, pending: 0, of: 4, remaining: 2 });
    const c = await s.call('DELETE', '/api/loop/history');
    assert.equal(c.status, 200);
    assert.equal(c.json.removed, 2);
    assert.deepEqual(readdirSync(work), ['prompt-r2-fix-0.md']);
    assert.equal((await s.call('GET', '/api/loop/timeline')).json, null);
  } finally {
    await s.stop();
  }
});

// docs/plans/deploy-wait.md AC 2 / guard f: a round whose fixes wait for a deployment is "awaiting
// deployment" in History's summary, never a failure; and only committed rows are listed (criterion 9).
test('loop timeline: a round waiting for its deployment is awaiting deployment, not failed; only committed rows are listed', async () => {
  const s = await startServer();
  try {
    const work = s.dirs().work;
    mkdirSync(work, { recursive: true });
    const e = (status, attempts) => ({ status, test: '7.A', impact: 'serious', message: 'm', pages: ['/'], attempts, selector: 'img' });
    writeFileSync(join(work, 'ledger.json'), JSON.stringify({
      version: 1,
      rounds: [{ round: 1, at: '2026-10-13T20:21:00.000Z', pages: 33, audited: 33, violations: 30, reviews: 4, diff: { new: 34 }, committed: 1, branch: 'a11y-508', pushed: true, remote: 'origin' }],
      deploy: { round: 1, signature: '/main.abc.js', branch: 'a11y-508', remote: 'origin', pushed: true, host: 'cargo-dev.example.gov', since: '2026-10-13T20:30:00.000Z' },
      findings: {
        a: e('pending', [{ round: 1, n: 1, commit: 'abc1234', outcome: 'pending', files: ['src/a.html'], note: 'added alt text' }]),
        b: e('open', [{ round: 1, n: 2, outcome: 'no-change', files: [], note: 'could not locate the element; it is rendered by a library component' }]),
      },
    }));
    const t = (await s.call('GET', '/api/loop/timeline')).json;
    assert.equal(t.rounds[0].state, 'awaiting-deploy');
    assert.equal(t.rounds[0].label, 'awaiting deployment');
    assert.deepEqual([t.rounds[0].branch, t.rounds[0].pushed, t.rounds[0].remote, t.rounds[0].covered], ['a11y-508', true, 'origin', 1]);
    assert.equal(t.deploy.host, 'cargo-dev.example.gov');
    assert.equal(t.deploy.signature, undefined);
    // Criterion 9: only what the assistant changed and committed is listed.
    assert.deepEqual(t.rounds[0].changes.map((c) => c.outcome), ['committed']);
    assert.equal(t.rounds[0].fixed, 1);
    const { outcomeOf } = await import('../runs.mjs');
    assert.equal(outcomeOf({ kind: 'loop', code: 4 }), 'awaiting-deploy');
    assert.equal(outcomeOf({ kind: 'crawl', code: 4 }), 'error');
  } finally {
    await s.stop();
  }
});

// docs/plans/loop-resilience.md AC 17/21: History lists a fix task once, with the elements it covered,
// and counts its one commit once.
test('loop timeline: a group of findings fixed by one task is one row and one commit', async () => {
  const { loopTimeline } = await import('../reports.mjs');
  const a = { round: 1, n: 3, files: ['src/a.html'], outcome: 'pending', commit: 'abc1234', agentMs: 10, gateMs: 20, gateCode: 0 };
  const f = (sel) => ({ status: 'pending', test: '7.A', impact: 'serious', message: 'no alt', pages: ['/'], selector: sel, attempts: [{ ...a }] });
  const ledger = { version: 1, rounds: [{ round: 1, at: '2026-10-13T10:00:00Z', violations: 4, diff: { verified: 0 } }], findings: { a: f('img.a'), b: f('img.b'), c: f('img.c'), d: f('img.d') } };
  const t = loopTimeline(ledger, { pending: 4 });
  assert.equal(t.rounds[0].commits, 1);
  assert.equal(t.rounds[0].changes.length, 1);
  assert.equal(t.rounds[0].changes[0].elements, 4);
  assert.equal(t.rounds[0].changes[0].commit, 'abc1234');
});
