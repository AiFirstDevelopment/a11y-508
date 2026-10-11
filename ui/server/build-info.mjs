// ui/dist is committed so the dashboard runs with no install. build-info.json
// beside it records a hash of the source it was built from (ui/app/ plus
// ui/package-lock.json). The server warns at startup when that hash does not
// match the source, and CI runs this file with --check, which exits 1.
//
//   node ui/server/build-info.mjs --write   (after ng build)
//   node ui/server/build-info.mjs --check

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Line endings are normalized so a Windows checkout hashes the same.
export function sourceHash(uiDir = UI_DIR) {
  const app = join(uiDir, 'app');
  const lock = join(uiDir, 'package-lock.json');
  if (!existsSync(app) || !existsSync(lock)) return null;
  const h = createHash('sha256');
  for (const f of [...walk(app), lock]) {
    h.update(relative(uiDir, f).split(sep).join('/'));
    h.update('\0');
    h.update(readFileSync(f).toString('utf8').replace(/\r\n/g, '\n'));
    h.update('\0');
  }
  return h.digest('hex');
}

export function readBuildInfo(uiDir = UI_DIR) {
  try {
    return JSON.parse(readFileSync(join(uiDir, 'dist', 'build-info.json'), 'utf8'));
  } catch {
    return null;
  }
}

// { fresh, built, source, reason }. fresh is null when the source is not
// present (a copy that carries only dist/), which is not a mismatch.
export function freshness(uiDir = UI_DIR) {
  const info = readBuildInfo(uiDir);
  const source = sourceHash(uiDir);
  if (!info) return { fresh: false, built: null, source, reason: 'ui/dist/build-info.json is missing; the dashboard was never built' };
  if (!source) return { fresh: null, built: info.hash, source: null, reason: 'the UI source is not present, so the build cannot be checked' };
  if (info.hash !== source) return { fresh: false, built: info.hash, source, reason: `ui/dist was built from different source (built ${info.hash.slice(0, 12)}, source ${source.slice(0, 12)}); rebuild with: npm --prefix ui run build` };
  return { fresh: true, built: info.hash, source, reason: null };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2];
  const uiDir = process.argv[3] || UI_DIR;
  if (mode === '--write') {
    const pkg = JSON.parse(readFileSync(join(uiDir, 'package-lock.json'), 'utf8'));
    const v = (name) => (pkg.packages && pkg.packages[`node_modules/${name}`] && pkg.packages[`node_modules/${name}`].version) || null;
    const info = { hash: sourceHash(uiDir), builtAt: new Date().toISOString(), angular: v('@angular/core'), ngxCharts: v('@swimlane/ngx-charts') };
    writeFileSync(join(uiDir, 'dist', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
    process.stdout.write(`wrote ui/dist/build-info.json: ${info.hash}\n`);
  } else if (mode === '--check') {
    const f = freshness(uiDir);
    if (f.fresh === false) {
      process.stderr.write(`ui/dist is stale: ${f.reason}\n`);
      process.exitCode = 1;
    } else process.stdout.write(f.fresh ? `ui/dist is fresh (${f.built})\n` : `${f.reason}\n`);
  } else {
    process.stderr.write('usage: node ui/server/build-info.mjs --write | --check [ui dir]\n');
    process.exitCode = 2;
  }
}
