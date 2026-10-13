// Startup: the folder and URL chosen last time are kept server-side (~/.a11y-508/settings.json),
// the server starts in that folder (never in a folder above the launch directory), and /api/env
// answers at once while the assistants are still being detected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, tmp } from './helpers.mjs';
import { rememberedStart } from '../state-dir.mjs';
import { realDir } from '../dirs.mjs';

test('startup: the remembered folder must exist and must not be above the launch directory', () => {
  const root = tmp('a11y-508-remember-');
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'sub'), { recursive: true });
  assert.equal(rememberedStart(repo, root, realDir), repo);
  assert.equal(rememberedStart(repo, repo, realDir), repo);
  assert.equal(rememberedStart(root, repo, realDir), null, 'the parent of the launch directory');
  assert.equal(rememberedStart(root, join(repo, 'sub'), realDir), null, 'an ancestor of the launch directory');
  assert.equal(rememberedStart(join(root, 'gone'), root, realDir), null, 'a folder that no longer exists (not its parent)');
  assert.equal(rememberedStart(null, root, realDir), null);
});

test('startup: the server starts in the folder chosen last time, and remembers each new choice and URL', async () => {
  const home = tmp('a11y-508-home-');
  const repo = tmp('a11y-508-lastrepo-');
  const launch = tmp('a11y-508-launch-');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ lastCwd: repo, lastUrl: 'http://127.0.0.1:9/app' }));
  const s = await startServer({ cwd: launch, env: { A11Y_508_HOME: home } });
  try {
    const env = (await s.call('GET', '/api/env')).json;
    assert.equal(env.cwd, repo);
    assert.equal(env.restored, true);
    assert.deepEqual(env.last, { cwd: repo, url: 'http://127.0.0.1:9/app' });
    assert.ok(s.output().includes(`dashboard for ${repo} (the folder chosen last time)`), s.output());
    // A new choice and a new URL are written at once.
    const other = tmp('a11y-508-other-');
    assert.equal((await s.call('PUT', '/api/cwd', { body: { path: other } })).status, 200);
    assert.equal((await s.call('PUT', '/api/last', { body: { url: 'http://127.0.0.1:9/next' } })).status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')), { lastCwd: other, lastUrl: 'http://127.0.0.1:9/next' });
    assert.equal((await s.call('PUT', '/api/last', { body: { nope: 1 } })).status, 400);
  } finally {
    await s.stop();
  }
});

test('startup: a remembered folder above the launch directory is not used', async () => {
  const home = tmp('a11y-508-home-');
  const parent = tmp('a11y-508-parent-');
  const launch = join(parent, 'repo');
  mkdirSync(launch);
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ lastCwd: parent }));
  const s = await startServer({ cwd: launch, env: { A11Y_508_HOME: home } });
  try {
    const env = (await s.call('GET', '/api/env')).json;
    assert.equal(env.cwd, launch);
    assert.equal(env.restored, false);
  } finally {
    await s.stop();
  }
});

test('startup: /api/env answers at once while the assistants are detected, and has them once detected', async () => {
  const s = await startServer({ env: { A11Y_508_DETECT_DELAY_MS: '3000' } });
  try {
    const t0 = Date.now();
    const first = (await s.call('GET', '/api/env')).json;
    assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
    assert.equal(first.detecting, true);
    assert.equal(first.presets, null);
    const waited = (await s.call('GET', '/api/env?wait=1')).json;
    assert.equal(waited.detecting, false);
    assert.ok(Array.isArray(waited.presets) && waited.presets.length >= 3);
    assert.equal((await s.call('GET', '/api/env')).json.detecting, false);
  } finally {
    await s.stop();
  }
});

test('carry: the analysis for the URL moves to the new folder, or is copied when git tracks it in the old one; another URL stays', async () => {
  const { carryAnalysis } = await import('../reports.mjs');
  const { inGitRepo } = await import('../dirs.mjs');
  const { spawnSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const report = (dir, url, at) => {
    mkdirSync(join(dir, 'a11y-508-report'), { recursive: true });
    writeFileSync(join(dir, 'a11y-508-report', 'report.json'), JSON.stringify({ baseUrl: url, finishedAt: at, pages: [], summary: {} }));
  };
  const a = tmp('a11y-508-carry-a-');
  const b = tmp('a11y-508-carry-b-');
  report(a, 'http://app.example/x/', '2026-01-01T00:00:00.000Z');
  mkdirSync(join(a, 'a11y-508-history', 'old'), { recursive: true });
  writeFileSync(join(a, 'a11y-508-history', 'old', 'report.json'), JSON.stringify({ baseUrl: 'http://app.example/x', finishedAt: '2025' }));
  assert.deepEqual(carryAnalysis(a, b, 'http://other.example/', { inGit: inGitRepo }).report, false, 'another URL');
  const moved = carryAnalysis(a, b, 'http://app.example/x?q=1', { inGit: inGitRepo });
  assert.deepEqual([moved.report, moved.history, moved.moved], [true, 1, true]);
  assert.ok(!existsSync(join(a, 'a11y-508-report')) && existsSync(join(b, 'a11y-508-report', 'report.json')));
  // Tracked by git in the old folder: copied.
  const c = tmp('a11y-508-carry-c-');
  const d = tmp('a11y-508-carry-d-');
  report(c, 'http://app.example/', '2026-02-01T00:00:00.000Z');
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'r']]) spawnSync('git', args, { cwd: c });
  const copied = carryAnalysis(c, d, 'http://app.example/', { inGit: inGitRepo });
  assert.deepEqual([copied.report, copied.moved], [true, false]);
  assert.ok(existsSync(join(c, 'a11y-508-report', 'report.json')) && existsSync(join(d, 'a11y-508-report', 'report.json')));
});
