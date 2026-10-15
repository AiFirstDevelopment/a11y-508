// GET /api/loop/defaults: what the Fix loop infers from the working directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, tmp } from './helpers.mjs';

const repo = (scripts, { remote = true } = {}) => {
  const dir = tmp('a11y-508-defaults-');
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  if (remote) g('remote', 'add', 'origin', 'https://example.invalid/app.git');
  if (scripts) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', scripts }));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'main.ts'), 'export {};\n');
  return dir;
};

test('loop defaults: build and test scripts, a source folder and a remote', async () => {
  const s = await startServer({ cwd: repo({ build: 'ng build', test: 'ng test' }) });
  try {
    const r = await s.call('GET', '/api/loop/defaults');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.repo, { git: true, remote: 'origin', branch: 'main' });
    // ng test watches unless told otherwise (AC 19): the check runs it once, and says why.
    assert.deepEqual(r.json.package, { exists: true, build: 'npm run build', test: 'npm test -- --watch=false --browsers=ChromeHeadless', testHint: 'ng test watches for changes and never exits; the check runs it once' });
    assert.deepEqual(r.json.source, ['src']);
    assert.deepEqual(r.json.suggested, { source: ['src'], check: 'npm run build && npm test -- --watch=false --browsers=ChromeHeadless', branch: 'a11y-508', push: true, deployed: 'bundle-change', deployTimeout: 0, maxAttempts: 3 });
    assert.equal(r.json.configExists, false);
  } finally {
    await s.stop();
  }
});

test('loop defaults: npm\'s placeholder test script is not a test; build only; no remote means no push', async () => {
  const s = await startServer({ cwd: repo({ build: 'tsc', test: 'echo "Error: no test specified" && exit 1' }, { remote: false }) });
  try {
    const r = await s.call('GET', '/api/loop/defaults');
    assert.deepEqual(r.json.package, { exists: true, build: 'npm run build', test: null });
    assert.equal(r.json.suggested.check, 'npm run build');
    assert.equal(r.json.suggested.push, false);
    assert.equal(r.json.repo.remote, null);
    // An existing config wins over the suggestions.
    writeFileSync(join(s.cwd, 'a11y-508.config.json'), JSON.stringify({ url: 'http://x/', check: 'make check', branch: 'fixes' }));
    const c = await s.call('GET', '/api/loop/defaults');
    assert.equal(c.json.configExists, true);
    assert.equal(c.json.effective.check, 'make check');
    assert.equal(c.json.effective.branch, 'fixes');
    assert.equal(c.json.suggested.check, 'npm run build');
  } finally {
    await s.stop();
  }
});

test('loop defaults: no package.json and not a repository', async () => {
  const dir = tmp('a11y-508-defaults-bare-');
  mkdirSync(join(dir, 'pages'));
  writeFileSync(join(dir, 'pages', 'index.html'), '<!doctype html>');
  const s = await startServer({ cwd: dir });
  try {
    const r = await s.call('GET', '/api/loop/defaults');
    assert.equal(r.json.repo.git, false);
    assert.equal(r.json.package.exists, false);
    assert.equal(r.json.suggested.check, null);
    assert.deepEqual(r.json.source, ['pages']);
  } finally {
    await s.stop();
  }
});

// docs/plans/loop-resilience.md AC 19: `ng test` watches and never exits; the suggested check runs it once.
test('loop defaults: a test script that runs ng test in watch mode is run once, with the reason', async () => {
  const s = await startServer({ cwd: repo({ build: 'ng build', test: 'ng test' }) });
  try {
    const r = await s.call('GET', '/api/loop/defaults');
    assert.equal(r.json.suggested.check, 'npm run build && npm test -- --watch=false --browsers=ChromeHeadless');
    assert.equal(r.json.package.testHint, 'ng test watches for changes and never exits; the check runs it once');
    writeFileSync(join(s.cwd, 'package.json'), JSON.stringify({ name: 'app', scripts: { build: 'ng build', test: 'ng test --watch=false' } }));
    const once = await s.call('GET', '/api/loop/defaults');
    assert.equal(once.json.suggested.check, 'npm run build && npm test');
    assert.equal(once.json.package.testHint, undefined);
  } finally {
    await s.stop();
  }
});

// docs/plans/loop-resilience.md AC 3: an a11y-508/* branch makes a11y-508 impossible to create, so
// the suggestion (and the "commits to branch" line) is the branch the loop will continue on.
test('loop defaults: with a11y-508/fixes in the repository, the branch is a11y-508/fixes, for the suggestion and for a config naming a11y-508', async () => {
  const dir = repo({ build: 'ng build' });
  const g = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  g('config', 'user.email', 'defaults-test@example.test');
  g('config', 'user.name', 'defaults test');
  g('config', 'commit.gpgsign', 'false');
  g('add', '-A');
  g('commit', '-q', '-m', 'app');
  g('branch', 'a11y-508/fixes');
  const s = await startServer({ cwd: dir });
  try {
    const r = await s.call('GET', '/api/loop/defaults');
    assert.equal(r.json.suggested.branch, 'a11y-508/fixes');
    assert.equal(r.json.effective.branch, 'a11y-508/fixes');
    assert.equal(r.json.branch.wanted, 'a11y-508');
    assert.match(r.json.branch.reason, /a branch a11y-508 cannot be created while a11y-508\/fixes exists/);
    writeFileSync(join(s.cwd, 'a11y-508.config.json'), JSON.stringify({ url: 'http://x/', branch: 'a11y-508' }));
    const c = await s.call('GET', '/api/loop/defaults');
    assert.equal(c.json.effective.branch, 'a11y-508/fixes');
    assert.deepEqual(c.json.branch, { wanted: 'a11y-508', used: 'a11y-508/fixes', reason: r.json.branch.reason });
    // A branch nothing is in the way of stays as configured.
    writeFileSync(join(s.cwd, 'a11y-508.config.json'), JSON.stringify({ url: 'http://x/', branch: 'fixes' }));
    const f = await s.call('GET', '/api/loop/defaults');
    assert.deepEqual(f.json.branch, { wanted: 'fixes', used: 'fixes', reason: null });
  } finally {
    await s.stop();
  }
});
