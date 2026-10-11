// AC 21: a stale ui/dist is reported at startup, and the CI check fails.

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dashboard, ROOT, tempDir } from './harness';

function copyTool(): string {
  const dir = tempDir('a11y-508-fresh-');
  for (const p of ['bin', 'src', 'package.json', 'ui/server', 'ui/dist', 'ui/app', 'ui/package.json', 'ui/package-lock.json']) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  return dir;
}

test('AC 21: the server warns at startup and the freshness check fails when ui/dist does not match the source', async () => {
  const fresh = copyTool();
  const ok = await dashboard({ main: join(fresh, 'ui', 'server', 'main.mjs') });
  await ok.stop();
  expect(ok.output()).not.toContain('was built from different source');
  expect(spawnSync(process.execPath, [join(fresh, 'ui', 'server', 'build-info.mjs'), '--check'], { encoding: 'utf8' }).status).toBe(0);

  const stale = copyTool();
  const file = join(stale, 'ui', 'app', readdirSync(join(stale, 'ui', 'app')).find((f) => f.endsWith('.ts'))!);
  appendFileSync(file, '\n// changed after the build\n');
  const warned = await dashboard({ main: join(stale, 'ui', 'server', 'main.mjs') });
  await warned.stop();
  expect(warned.output()).toMatch(/^warn ui\/dist was built from different source/m);
  const check = spawnSync(process.execPath, [join(stale, 'ui', 'server', 'build-info.mjs'), '--check'], { encoding: 'utf8' });
  expect(check.status).toBe(1);
  expect(check.stderr).toContain('ui/dist is stale');
});
