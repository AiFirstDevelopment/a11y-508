// AC 1: from a clean copy with nothing installed, `npm run ui` serves the
// dashboard on 127.0.0.1 and opens it, on Node 18 or newer.

import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT, stub, tempDir } from './harness';

// The oldest Node on this machine that is 18 or newer (CI runs this suite on 22).
function oldestNode(): string {
  const nvm = join(homedir(), '.nvm', 'versions', 'node');
  if (existsSync(nvm)) {
    const v18 = readdirSync(nvm).filter((v) => /^v18\./.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
    if (v18 && existsSync(join(nvm, v18, 'bin', 'npm'))) return join(nvm, v18, 'bin');
  }
  return dirname(process.execPath);
}

test('AC 1: npm run ui from a clean copy, no install, serves on 127.0.0.1 and opens the browser', async ({ page }) => {
  const clone = tempDir('a11y-508-clone-');
  for (const p of ['bin', 'src', 'package.json', 'README.md', 'LICENSE', 'ui/server', 'ui/dist']) cpSync(join(ROOT, p), join(clone, p), { recursive: true, filter: (s) => !/node_modules|\/test$/.test(s) });
  expect(existsSync(join(clone, 'node_modules'))).toBe(false);
  expect(existsSync(join(clone, 'ui', 'node_modules'))).toBe(false);
  expect(JSON.parse(readFileSync(join(clone, 'package.json'), 'utf8')).dependencies).toBeUndefined();

  // A stand-in for the system's "open" / "xdg-open" that records what it was asked to open.
  const opened = join(clone, 'opened.txt');
  const bin = join(tempDir('a11y-508-openbin-'), 'bin');
  for (const name of ['open', 'xdg-open']) stub(bin, name, `#!/bin/sh\necho "$@" >> ${JSON.stringify(opened)}\n`);
  const nodeDir = oldestNode();
  const proc = spawn(join(nodeDir, 'npm'), ['run', 'ui', '--', '--port', '0'], {
    cwd: clone,
    env: { ...process.env, PATH: `${bin}:${nodeDir}:/usr/bin:/bin`, TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  try {
    await expect.poll(() => (existsSync(opened) ? readFileSync(opened, 'utf8') : ''), { timeout: 30_000, message: out }).toMatch(/http:\/\/127\.0\.0\.1:\d+\/#secret=[0-9a-f]+/);
    const url = /http:\/\/127\.0\.0\.1:\d+\/#secret=[0-9a-f]+/.exec(readFileSync(opened, 'utf8'))![0];
    expect(out).toContain(url);
    const version = await new Promise<string>((ok) => {
      const v = spawn(join(nodeDir, 'node'), ['-v']);
      let s = '';
      v.stdout.on('data', (d) => (s += d));
      v.on('close', () => ok(s.trim()));
    });
    expect(Number(/^v(\d+)/.exec(version)![1])).toBeGreaterThanOrEqual(18);
    test.info().annotations.push({ type: 'node', description: version });
    await page.goto(url);
    await expect(page.locator('h1')).toHaveText('Run a crawl');
    await expect(page.getByText('Working directory')).toBeVisible();
    expect(page.url()).not.toContain('secret='); // moved out of the address bar
  } finally {
    proc.kill('SIGINT');
  }
});
