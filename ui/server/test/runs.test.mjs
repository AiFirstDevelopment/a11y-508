import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './helpers.mjs';

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
    assert.match(signin.json.command, /^node \S+ http:\/\/x\/ --login --stay --state a11y-508-state\.json$/);
  } finally {
    await s.stop();
  }
});

test('before a crawl the previous report moves to a11y-508-history/<finishedAt>/', async () => {
  const s = await startServer();
  try {
    mkdirSync(join(s.cwd, 'a11y-508-report'));
    writeFileSync(join(s.cwd, 'a11y-508-report', 'report.json'), JSON.stringify({ finishedAt: '2026-01-02T03:04:05.000Z', summary: {}, pages: [] }));
    const r = await s.call('POST', '/api/runs', { body: { kind: 'crawl', url: 'http://127.0.0.1:9/', options: { 'no-interact': true, 'no-zoom': true }, auth: { mode: 'none' } } });
    assert.equal(r.status, 202, r.text);
    assert.deepEqual(readdirSync(join(s.cwd, 'a11y-508-history')), ['2026-01-02T03-04-05.000Z']);
    assert.ok(existsSync(join(s.cwd, 'a11y-508-history', '2026-01-02T03-04-05.000Z', 'report.json')));
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

test('deleting reports: history entries only, confined to a11y-508-history, behind the secret', async () => {
  const s = await startServer();
  try {
    const rep = (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'report.json'), JSON.stringify({ finishedAt: '2026-01-02T03:04:05.000Z', summary: {}, pages: [] }));
    };
    rep(join(s.cwd, 'a11y-508-report'));
    rep(join(s.cwd, 'a11y-508-work', 'round-1'));
    rep(join(s.cwd, 'a11y-508-history', 'one'));
    rep(join(s.cwd, 'a11y-508-history', 'two'));
    // Outside the history directory, or not a history id: refused, nothing removed.
    for (const id of ['latest', 'round-1', 'h-..', encodeURIComponent('h-../a11y-508-report'), encodeURIComponent('../a11y-508-report'), 'h-.hidden']) {
      const r = await s.call('DELETE', `/api/reports/${id}`);
      assert.ok([400, 404].includes(r.status), `${id}: ${r.status}`);
    }
    assert.equal((await s.call('DELETE', '/api/reports/h-missing')).status, 404);
    assert.equal((await s.call('DELETE', '/api/reports/history', { secret: 'wrong' })).status, 401);
    assert.ok(existsSync(join(s.cwd, 'a11y-508-report', 'report.json')));
    assert.ok(existsSync(join(s.cwd, 'a11y-508-work', 'round-1', 'report.json')));
    assert.deepEqual(readdirSync(join(s.cwd, 'a11y-508-history')).sort(), ['one', 'two']);
    // One entry, then the rest.
    const one = await s.call('DELETE', '/api/reports/h-one');
    assert.equal(one.status, 200);
    assert.deepEqual(readdirSync(join(s.cwd, 'a11y-508-history')), ['two']);
    const all = await s.call('DELETE', '/api/reports/history');
    assert.equal(all.status, 200);
    assert.equal(all.json.removed, 1);
    assert.deepEqual(readdirSync(join(s.cwd, 'a11y-508-history')), []);
    assert.ok(existsSync(join(s.cwd, 'a11y-508-report', 'report.json')), 'the latest report stays');
    assert.ok(existsSync(join(s.cwd, 'a11y-508-work', 'round-1', 'report.json')), 'the loop rounds stay');
  } finally {
    await s.stop();
  }
});
