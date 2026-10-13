// The harness's removal guard: the dashboard never runs in the checkout, and teardown removes
// only what the tests created under the temp directory.
import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dashboard, removeTemp, tempDir, ROOT } from './harness';

test('removal guard: the checkout is refused as a dashboard working directory and for removal', async () => {
  await expect(dashboard({ cwd: ROOT })).rejects.toThrow(/refusing to remove .*repository/);
  for (const p of [ROOT, dirname(ROOT), join(ROOT, 'ui')]) expect(() => removeTemp(p), p).toThrow(/refusing to remove/);
  expect(existsSync(join(ROOT, '.git'))).toBe(true);
  const mine = tempDir('a11y-508-guard-');
  removeTemp(mine);
  expect(existsSync(mine)).toBe(false);
});
