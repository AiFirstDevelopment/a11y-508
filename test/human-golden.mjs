// The CLI's default human-readable output must not change. test/golden/human-output.txt
// was captured from origin/main's code before --events existed:
//
//   git archive origin/main | tar -x -C /tmp/a11y-main
//   node test/human-golden.mjs --write /tmp/a11y-main
//
// Timings, ports, paths and the browser's version are normalized away; with one
// tab the crawl order, and so every line, is deterministic.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureSite, TOKEN } from './fixture-site.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const GOLDEN = join(here, 'golden', 'human-output.txt');
export const HUMAN_ARGS = ['--concurrency', '1', '--no-screenshots', '--token-storage', 'fixture_custom_key', '--max-pages', '8'];

export function normalizeHuman(text, { base, out, externalUrl }) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    // A plain string split: escaping it would miss every Windows path. The
    // path separator after OUT is normalized too (OUT\report.html on Windows).
    .split(out).join('OUT')
    .replace(/OUT\\/g, 'OUT/')
    .replace(new RegExp(esc(base), 'g'), 'BASE/')
    .replace(new RegExp(esc(new URL(base).origin), 'g'), 'BASE')
    .replace(new RegExp(esc(externalUrl), 'g'), 'EXTERNAL')
    .replace(/\(\d+\.\ds\)/g, '(T)')
    .replace(/^browser: .*$/m, 'browser: BROWSER');
}

// Runs the CLI at toolRoot against a fresh fixture site and returns its
// normalized stdout+stderr, in order.
export async function humanRun(toolRoot, extraArgs = []) {
  const site = await startFixtureSite();
  const out = mkdtempSync(join(tmpdir(), 'a11y-508-human-'));
  try {
    const text = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(toolRoot, 'bin/a11y-508.mjs'), site.base, '--out', out, ...HUMAN_ARGS, ...extraArgs], {
        env: { ...process.env, TOKEN, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let all = '';
      child.stdout.on('data', (d) => (all += d));
      child.stderr.on('data', (d) => (all += d));
      const timer = setTimeout(() => child.kill('SIGKILL'), 400000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(all + `exit ${code}\n`);
      });
    });
    return normalizeHuman(text, { base: site.base, out, externalUrl: site.externalUrl });
  } finally {
    site.close();
    rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === '--write') {
  const toolRoot = process.argv[3];
  if (!toolRoot) throw new Error('usage: node test/human-golden.mjs --write <tool root>');
  const text = await humanRun(toolRoot);
  writeFileSync(GOLDEN, text);
  process.stdout.write(text);
}

export const readGolden = () => readFileSync(GOLDEN, 'utf8');
