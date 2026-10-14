// The dashboard keeps its own files out of the app's repository (state-dir.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, tmp } from './helpers.mjs';
import { argPattern } from './platform.mjs';

// The tool keeps its outputs outside the repository too (src/home.mjs): only git's own folder is there.
const OUTPUTS = new Set(['.git']);

test('state dir: the config, the session and the settings go to the per-user directory; runs get --config and --state there', async () => {
  const cwd = tmp('a11y-508-statedir-');
  spawnSync('git', ['init', '-q'], { cwd });
  const s = await startServer({ cwd });
  try {
    const env = (await s.call('GET', '/api/env')).json;
    assert.ok(!env.stateDir.startsWith(cwd), `${env.stateDir} is outside the working directory`);
    assert.equal(env.session.file, join(env.stateDir, 'state.json'));
    // The config is written to the state dir, marked as the dashboard's.
    const put = await s.call('PUT', '/api/config', { body: { config: { url: 'http://127.0.0.1:9/', args: ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots'] } } });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.file, join(env.stateDir, 'config.json'));
    assert.equal(JSON.parse(readFileSync(join(env.stateDir, 'config.json'), 'utf8')).writtenBy, 'a11y-508-dashboard');
    // A session saved: the crawl's and the loop's commands name it there.
    writeFileSync(join(env.stateDir, 'state.json'), JSON.stringify({ version: 1, origins: [], cookies: [], storage: {} }));
    const cmd = await s.call('GET', '/api/command?form=' + encodeURIComponent(JSON.stringify({ kind: 'crawl', url: 'http://x/', options: {}, auth: { mode: 'signin' } })));
    assert.match(cmd.json.command, argPattern('--state', join(env.stateDir, 'state.json'), '--login --stay '));
    const run = await s.call('POST', '/api/runs', { body: { kind: 'dry-run', auth: { mode: 'none' } } });
    assert.equal(run.status, 202, run.text);
    assert.match(run.json.meta.command, argPattern('--config', join(env.stateDir, 'config.json')));
    assert.match(run.json.meta.command, argPattern('--state', join(env.stateDir, 'state.json')));
    for (let i = 0; i < 120 && (await s.call('GET', '/api/runs/current')).json.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 500));
    // Settings, server-side.
    assert.equal((await s.call('PUT', '/api/settings', { body: { url: 'http://127.0.0.1:9/' } })).status, 200);
    assert.equal((await s.call('GET', '/api/settings')).json.url, 'http://127.0.0.1:9/');
    // Nothing in the working directory at all; the dry run's ledger is in the tool's own folder.
    const left = readdirSync(cwd).filter((n) => !OUTPUTS.has(n));
    assert.deepEqual(left, []);
    assert.ok(existsSync(join(s.dirs().work, 'ledger.json')), 'the ledger under the state base');
    // .git/info/exclude gains nothing, on launch or on a switch.
    const exclude = () => readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(!/a11y-508/.test(exclude()), exclude());
    const other = tmp('a11y-508-other-');
    assert.equal((await s.call('PUT', '/api/cwd', { body: { path: other } })).status, 200);
    assert.equal((await s.call('PUT', '/api/cwd', { body: { path: cwd } })).status, 200);
    assert.ok(!/a11y-508/.test(exclude()), exclude());
    // Not a repository: nothing written there.
    assert.deepEqual(readdirSync(other), []);
  } finally {
    await s.stop();
  }
});

test('state dir: a repository\'s own config is used as is and never written; the dashboard\'s old files are moved on request', async () => {
  const cwd = tmp('a11y-508-teamcfg-');
  const g = (...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
  g('init', '-q');
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({ url: 'http://team.example/', check: 'make check' }));
  g('add', 'a11y-508.config.json');
  writeFileSync(join(cwd, 'a11y-508-state.json'), JSON.stringify({ version: 1, origins: [], cookies: [], storage: {} }));
  const s = await startServer({ cwd });
  try {
    const c = await s.call('GET', '/api/config');
    assert.equal(c.json.repository, true);
    assert.equal(c.json.config.url, 'http://team.example/');
    const put = await s.call('PUT', '/api/config', { body: { config: { url: 'http://other/' } } });
    assert.equal(put.status, 409);
    assert.equal(JSON.parse(readFileSync(join(cwd, 'a11y-508.config.json'), 'utf8')).url, 'http://team.example/');
    // The session file is asked about (the committed config is the team's, not asked about).
    const env = (await s.call('GET', '/api/env')).json;
    assert.deepEqual(env.legacy, ['a11y-508-state.json']);
    const mv = await s.call('POST', '/api/migrate', { body: { move: true } });
    assert.deepEqual(mv.json.moved.sort(), ['a11y-508-state.json']);
    assert.equal(existsSync(join(cwd, 'a11y-508-state.json')), false);
    assert.equal(existsSync(join(env.stateDir, 'state.json')), true);
    assert.deepEqual((await s.call('GET', '/api/env')).json.legacy, []);
  } finally {
    await s.stop();
  }
});
