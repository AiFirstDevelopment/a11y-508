// AC 19: without --events the CLI's output is what origin/main printed, the
// event stream fits its schema, and the core still has no dependencies.

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN, ROOT, TOKEN, fixtureSite, run, tempDir } from './harness';

test('AC 19: the human output is unchanged from origin/main, events fit the schema, and the core has no dependencies', async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  expect(pkg.dependencies).toBeUndefined();
  expect(pkg.files).toEqual(['bin', 'src', 'README.md', 'LICENSE']);
  expect(spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' }).status).toBe(0);

  const { humanRun, readGolden }: any = await import('../../test/human-golden.mjs');
  const human: string = await humanRun(ROOT);
  const golden: string = readGolden();
  const a = golden.split('\n');
  const b = human.split('\n');
  const i = a.findIndex((l, k) => l !== b[k]);
  expect(human, `first difference at line ${i + 1}: origin/main "${a[i]}" vs "${b[i]}"`).toBe(golden);

  const { parseEvents }: any = await import('../../test/event-schema.mjs');
  const site = await fixtureSite();
  try {
    const out = tempDir('a11y-508-ev-');
    const r = await run(process.execPath, [BIN, site.base, '--events', '--max-pages', '2', '--no-interact', '--no-zoom', '--no-screenshots', '--out', out], { env: { ...process.env, TOKEN } });
    const { events, problems } = parseEvents(r.stdout);
    expect(problems).toEqual([]);
    expect(events.filter((e: any) => e.type === 'page').length).toBe(JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')).pages.length);
  } finally {
    site.close();
  }
});
