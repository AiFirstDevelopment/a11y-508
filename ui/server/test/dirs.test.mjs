// The folder picker's server side: GET /api/dirs, PUT /api/cwd, and --dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { MAIN, startServer, tmp } from './helpers.mjs';
import { WIN, linkDir, mergeEnv, setHiddenAttribute, unreadableDir } from './platform.mjs';

const q = (p) => `/api/dirs?path=${encodeURIComponent(p)}`;

// A directory with folders in an order that sorting must fix, a file, a
// dot-folder, a link to a folder, and folders holding each fact.
function tree() {
  const root = tmp('a11y-508-tree-');
  for (const d of ['gamma10', 'beta', 'gamma9', 'Alpha', '.dotted', 'hidden-attr']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'file.txt'), 'a file, never listed');
  linkDir(join(root, 'beta'), join(root, 'link'));
  mkdirSync(join(root, 'Alpha', '.git'));
  writeFileSync(join(root, 'Alpha', 'a11y-508.config.json'), '{}');
  mkdirSync(join(root, 'beta', 'a11y-508-report'));
  writeFileSync(join(root, 'beta', 'a11y-508-report', 'report.json'), '{}');
  mkdirSync(join(root, 'beta', 'a11y-508-work'));
  writeFileSync(join(root, 'beta', 'a11y-508-work', 'ledger.json'), '{}');
  writeFileSync(join(root, 'beta', 'a11y-508-state.json'), '{}');
  const attr = setHiddenAttribute(join(root, 'hidden-attr'));
  return { root, attr };
}

test('GET /api/dirs lists subdirectories only, by name, with hidden flags, facts, parent and the link followed', async () => {
  const s = await startServer();
  const t = tree();
  try {
    const r = await s.call('GET', q(t.root));
    assert.equal(r.status, 200, r.text);
    const l = r.json;
    assert.equal(l.path, t.root);
    assert.equal(l.parent, realpathSync(join(t.root, '..')));
    assert.deepEqual(l.dirs.map((d) => d.name), ['.dotted', 'Alpha', 'beta', 'gamma9', 'gamma10', 'hidden-attr', 'link']);
    assert.ok(!l.dirs.some((d) => d.name === 'file.txt'), 'files are never listed');
    const by = Object.fromEntries(l.dirs.map((d) => [d.name, d]));
    assert.equal(by['.dotted'].hidden, true);
    assert.equal(by['Alpha'].hidden, false);
    // The hidden attribute exists on Windows only; elsewhere the folder is plain.
    assert.equal(by['hidden-attr'].hidden, t.attr, `hidden attribute ${t.attr ? 'set' : 'not available'}`);
    assert.equal(by['Alpha'].path, join(t.root, 'Alpha'));
    assert.deepEqual(by['Alpha'].facts, { git: true, config: true, report: false, ledger: false, session: false });
    assert.deepEqual(by['beta'].facts, { git: false, config: false, report: true, ledger: true, session: true });
    assert.deepEqual(by['gamma9'].facts, { git: false, config: false, report: false, ledger: false, session: false });
    // Browsing the link lands on the real directory.
    const link = await s.call('GET', q(join(t.root, 'link')));
    assert.equal(link.status, 200, link.text);
    assert.equal(link.json.path, join(t.root, 'beta'));
    assert.deepEqual(link.json.facts, by['beta'].facts);
    assert.deepEqual(link.json.dirs.map((d) => d.name), ['a11y-508-report', 'a11y-508-work']);
    // Breadcrumbs: every ancestor, root first, ending at the directory.
    const crumbs = link.json.crumbs;
    assert.equal(crumbs[crumbs.length - 1].path, join(t.root, 'beta'));
    assert.equal(crumbs[crumbs.length - 1].name, 'beta');
    assert.equal(crumbs[0].path, WIN ? t.root.slice(0, 3) : '/');
  } finally {
    await s.stop();
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('GET /api/dirs with no path lists the roots: / on POSIX, the drive letters that exist on Windows', async () => {
  const s = await startServer();
  try {
    const r = await s.call('GET', '/api/dirs');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.roots, true);
    assert.equal(r.json.parent, null);
    const names = r.json.dirs.map((d) => d.name);
    if (WIN) {
      assert.ok(names.length >= 1);
      for (const n of names) {
        assert.match(n, /^[A-Z]:\\$/);
        assert.ok(existsSync(n), n);
      }
      assert.ok(names.includes(`${(process.env.SystemDrive || 'C:').toUpperCase()}\\`), names.join(' '));
    } else {
      assert.deepEqual(names, ['/']);
    }
    const top = await s.call('GET', q(r.json.dirs[0].path));
    assert.equal(top.status, 200);
    assert.equal(top.json.parent, null, 'a root has no parent');
  } finally {
    await s.stop();
  }
});

test('GET /api/dirs: ~ is the home directory; missing, a file, relative and unreadable paths are errors with the OS message; the server keeps serving', async () => {
  const s = await startServer();
  const t = tree();
  const locked = unreadableDir(t.root);
  try {
    const home = await s.call('GET', q('~'));
    assert.equal(home.status, 200, home.text);
    assert.equal(home.json.path, realpathSync(homedir()));
    const missing = await s.call('GET', q(join(t.root, 'nope')));
    assert.equal(missing.status, 404);
    assert.match(missing.json.error, /ENOENT/);
    assert.ok(!/\n\s+at /.test(missing.text), 'no stack trace');
    const file = await s.call('GET', q(join(t.root, 'file.txt')));
    assert.equal(file.status, 404);
    assert.match(file.json.error, /ENOTDIR/);
    const rel = await s.call('GET', q('relative/path'));
    assert.equal(rel.status, 400);
    assert.match(rel.json.error, /absolute/);
    if (locked) {
      const r = await s.call('GET', q(locked.path));
      assert.equal(r.status, locked.status, `${locked.path}: ${r.text}`);
      assert.ok(r.json.error && r.json.error.length > 0);
      // A later listing of its parent still works and names it.
      const parent = await s.call('GET', q(t.root));
      assert.equal(parent.status, 200);
      if (!WIN) assert.ok(parent.json.dirs.some((d) => d.name === 'locked'));
    }
    assert.equal((await s.call('GET', '/api/env')).status, 200, 'the server keeps serving');
  } finally {
    if (locked) locked.cleanup();
    await s.stop();
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('the two new endpoints need the session secret and a local Host', async () => {
  const s = await startServer();
  try {
    for (const [m, p, body] of [['GET', '/api/dirs'], ['GET', q(s.cwd)], ['PUT', '/api/cwd', { path: s.cwd }]]) {
      assert.equal((await s.call(m, p, { body, secret: null })).status, 401, `${m} ${p}`);
      assert.equal((await s.call(m, p, { body, secret: 'nope' })).status, 401, `${m} ${p}`);
      assert.equal((await s.call(m, p, { body, host: 'evil.example' })).status, 403, `${m} ${p}`);
    }
  } finally {
    await s.stop();
  }
});

test('PUT /api/cwd switches every handler and a spawned run to the new directory; errors leave it unchanged', async () => {
  const s = await startServer();
  const other = tmp('a11y-508-other-');
  try {
    const before = (await s.call('GET', '/api/env')).json;
    assert.equal(before.cwd, s.cwd);
    assert.equal(before.launchDir, s.cwd);
    assert.deepEqual(before.cwdFacts, { git: false, config: false, report: false, ledger: false, session: false });
    // The other directory has a config, a report and a ledger.
    writeFileSync(join(other, 'a11y-508.config.json'), JSON.stringify({ url: 'http://127.0.0.1:9/other', check: 'true' }));
    mkdirSync(join(other, 'a11y-508-report'));
    writeFileSync(join(other, 'a11y-508-report', 'report.json'), JSON.stringify({ finishedAt: '2026-02-03T04:05:06.000Z', baseUrl: 'http://other.example/', summary: { audited: 1 }, passed: true, pages: [] }));
    mkdirSync(join(other, 'a11y-508-work'));
    writeFileSync(join(other, 'a11y-508-work', 'ledger.json'), JSON.stringify({ version: 1, rounds: [], findings: {} }));

    // Errors: 400 for a bad body or a relative path, 404 for a missing one or a file; nothing moves.
    for (const [body, status] of [[{}, 400], [{ path: 3 }, 400], [{ path: other, extra: 1 }, 400], [{ path: 'relative' }, 400], [{ path: join(other, 'nope') }, 404], [{ path: join(other, 'a11y-508.config.json') }, 404]]) {
      const r = await s.call('PUT', '/api/cwd', { body });
      assert.equal(r.status, status, `${JSON.stringify(body)}: ${r.text}`);
      assert.ok(r.json.error);
    }
    assert.equal((await s.call('GET', '/api/env')).json.cwd, s.cwd);

    const sw = await s.call('PUT', '/api/cwd', { body: { path: other } });
    assert.equal(sw.status, 200, sw.text);
    assert.equal(sw.json.cwd, other);
    assert.equal(sw.json.launchDir, s.cwd);
    assert.deepEqual(sw.json.cwdFacts, { git: false, config: true, report: true, ledger: true, session: false });
    const env = (await s.call('GET', '/api/env')).json;
    assert.equal(env.cwd, other);
    assert.equal(env.report.baseUrl, 'http://other.example/');
    assert.equal((await s.call('GET', '/api/config')).json.config.url, 'http://127.0.0.1:9/other');
    assert.equal((await s.call('GET', '/api/ledger')).json.exists, true);
    assert.deepEqual((await s.call('GET', '/api/reports')).json.map((r) => r.baseUrl), ['http://other.example/']);

    // A run spawned now runs in the new directory: its history move and its report land there.
    const r = await s.call('POST', '/api/runs', { body: { kind: 'crawl', url: 'http://127.0.0.1:9/', options: { 'max-pages': '1', 'no-interact': true, 'no-zoom': true }, auth: { mode: 'none' } } });
    assert.equal(r.status, 202, r.text);
    await s.waitDone();
    assert.ok(existsSync(join(other, 'a11y-508-history', '2026-02-03T04-05-06.000Z', 'report.json')), 'the earlier report moved to history in the new directory');
    assert.ok(existsSync(join(other, 'a11y-508-report', 'report.json')), 'the crawl wrote its report in the new directory');
    assert.ok(!existsSync(join(s.cwd, 'a11y-508-report')), 'and nothing in the old one');
    assert.ok(!existsSync(join(s.cwd, 'a11y-508-history')));

    // A finished run belongs to its directory: switching back forgets it.
    assert.notEqual((await s.call('GET', '/api/runs/current')).json, null);
    const back = await s.call('PUT', '/api/cwd', { body: { path: s.cwd } });
    assert.equal(back.status, 200);
    assert.equal(back.json.run, null);
    assert.equal((await s.call('GET', '/api/runs/current')).json, null);
    assert.equal((await s.call('GET', '/api/runs/current/events')).status, 404);
  } finally {
    await s.stop();
    rmSync(other, { recursive: true, force: true });
  }
});

test('PUT /api/cwd is 409 while a run is active and the directory stays', async () => {
  const hang = createServer(() => {});
  await new Promise((ok) => hang.listen(0, '127.0.0.1', ok));
  const s = await startServer();
  const other = tmp('a11y-508-other-');
  try {
    const url = `http://127.0.0.1:${hang.address().port}/`;
    assert.equal((await s.call('POST', '/api/runs', { body: { kind: 'troubleshoot', url, options: { timeout: '60000' }, auth: { mode: 'none' } } })).status, 202);
    const r = await s.call('PUT', '/api/cwd', { body: { path: other } });
    assert.equal(r.status, 409, r.text);
    assert.match(r.json.error, /troubleshoot run is active/);
    assert.equal((await s.call('GET', '/api/env')).json.cwd, s.cwd);
    await s.call('POST', '/api/runs/current/stop');
    await s.waitDone(20000);
    assert.equal((await s.call('PUT', '/api/cwd', { body: { path: other } })).status, 200, 'allowed once the run has ended');
  } finally {
    await s.stop();
    rmSync(other, { recursive: true, force: true });
    hang.closeAllConnections?.();
    hang.close();
  }
});

// Starts main.mjs and returns how it ended: its exit code and output, or the
// address it printed when it did start.
function launch(args, cwd) {
  return new Promise((ok) => {
    const proc = spawn(process.execPath, [MAIN, '--no-open', '--port', '0', ...args], { cwd, env: mergeEnv(process.env, { TOKEN: '' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 20000);
    const done = (r) => {
      clearTimeout(timer);
      ok(r);
    };
    proc.stdout.on('data', (d) => {
      out += d;
      if (/open: http:\S+/.test(out)) {
        proc.kill('SIGKILL');
        done({ started: true, out });
      }
    });
    proc.stderr.on('data', (d) => (out += d));
    proc.on('exit', (code) => done({ started: /open: http/.test(out), code, out }));
  });
}

test('--dir starts in that directory, relative to the launch directory; a file or a missing path exits non-zero with the reason', async () => {
  const launchDir = tmp('a11y-508-launch-');
  const other = tmp('a11y-508-launch-');
  mkdirSync(join(launchDir, 'repo'));
  writeFileSync(join(launchDir, 'file.txt'), 'x');
  try {
    for (const [arg, cwd, reason] of [['file.txt', launchDir, /ENOTDIR/], ['missing', launchDir, /ENOENT/], [relative(other, join(launchDir, 'missing')), other, /ENOENT/]]) {
      const r = await launch(['--dir', arg], cwd);
      assert.equal(r.started, false, `--dir ${arg} must not start: ${r.out}`);
      assert.notEqual(r.code, 0);
      assert.ok(r.out.includes(`error: --dir ${arg}: `), r.out);
      assert.match(r.out, reason);
    }
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
  const s = await startServer({ cwd: launchDir, args: ['--dir', 'repo'] });
  try {
    const env = (await s.call('GET', '/api/env')).json;
    assert.equal(env.cwd, join(launchDir, 'repo'));
    assert.equal(env.launchDir, join(launchDir, 'repo'));
    assert.ok(s.output().includes(`dashboard for ${join(launchDir, 'repo')}`), s.output());
  } finally {
    await s.stop();
  }
});
