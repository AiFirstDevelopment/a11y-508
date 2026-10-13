// The tests' removal guard: a test can only ever remove what it created under the temp directory.
// (A server test once started the dashboard in the checkout, and its teardown removed the checkout.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT, assertRemovable, removeTemp, startServer, tmp } from './helpers.mjs';

test('removal guard: the repository, its ancestors and anything inside it are refused', () => {
  for (const p of [REPO_ROOT, dirname(REPO_ROOT), join(REPO_ROOT, 'ui'), join(REPO_ROOT, '.git')]) {
    assert.throws(() => removeTemp(p), /refusing to remove/, p);
  }
  assert.ok(existsSync(join(REPO_ROOT, '.git')), 'the checkout is intact');
  assert.ok(existsSync(join(REPO_ROOT, 'package.json')), 'the checkout is intact');
});

test('removal guard: a temp directory the tests did not create, and a .git path, are refused', () => {
  const foreign = realpathSync(mkdtempSync(join(tmpdir(), 'a11y-508-foreign-')));
  try {
    assert.throws(() => removeTemp(foreign), /did not create it/);
    assert.ok(existsSync(foreign));
    const mine = tmp('a11y-508-guard-');
    mkdirSync(join(mine, '.git'));
    assert.throws(() => removeTemp(join(mine, '.git')), /contains \.git/);
    assert.ok(existsSync(join(mine, '.git')));
    assert.throws(() => assertRemovable(''), /not a path/);
    removeTemp(mine);
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }
});

test('removal guard: what the tests created is removed, and so is anything inside it', () => {
  const mine = tmp('a11y-508-guard-');
  mkdirSync(join(mine, 'inside'));
  writeFileSync(join(mine, 'inside', 'f.txt'), 'x');
  removeTemp(join(mine, 'inside'));
  assert.equal(existsSync(join(mine, 'inside')), false);
  removeTemp(mine);
  assert.equal(existsSync(mine), false);
  // Removing it again is a no-op, not a refusal.
  removeTemp(mine);
});

test('removal guard: the dashboard is never started with the repository as its working directory', async () => {
  await assert.rejects(() => startServer({ cwd: REPO_ROOT }), /refusing to remove .*repository/);
  assert.ok(existsSync(join(REPO_ROOT, '.git')), 'the checkout is intact');
});
