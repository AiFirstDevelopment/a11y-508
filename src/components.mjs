// The repository's components, for the manual flow's component picker and its plan: for an Angular
// app every @Component class with its selector and file; otherwise every source file. Read under the
// configured source folders only, never node_modules or a build's output.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const FILE_EXT = /\.(ts|tsx|js|jsx|vue|svelte|html)$/i;
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', '.angular', '.next']);
const MAX_FILES = 8000;

export function isAngular(cwd) {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    return !!({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })['@angular/core'];
  } catch {
    return false;
  }
}

export function walk(cwd, dirs, onFile) {
  let seen = 0;
  const go = (dir, depth) => {
    if (seen > MAX_FILES || depth > 14) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) go(full, depth + 1);
      else if (e.isFile() && FILE_EXT.test(e.name)) {
        seen++;
        onFile(full, relative(cwd, full).split(sep).join('/'));
      }
    }
  };
  for (const d of dirs) go(resolve(cwd, d), 0);
}

// [{ name, selector, file }]: Angular components (name = class, selector from the decorator), or one
// entry per source file (name = the file's base name, selector null). kind says which.
export function listComponents(cwd, sourceDirs = ['src']) {
  const angular = isAngular(cwd);
  const out = [];
  const seen = new Set();
  walk(cwd, sourceDirs, (full, rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    if (!angular) {
      out.push({ name: rel.split('/').pop(), selector: null, file: rel });
      return;
    }
    if (!/\.ts$/.test(rel) || /\.spec\.ts$/.test(rel)) return;
    let text;
    try {
      if (statSync(full).size > 1024 * 1024) return;
      text = readFileSync(full, 'utf8');
    } catch {
      return;
    }
    for (const m of text.matchAll(/@Component\s*\(\s*\{([\s\S]*?)\}\s*\)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g)) {
      const sel = /\bselector\s*:\s*['"`]([^'"`]+)['"`]/.exec(m[1]);
      out.push({ name: m[2], selector: sel ? sel[1] : null, file: rel });
    }
  });
  return { kind: angular ? 'angular' : 'files', components: out };
}

// The listed entry a plan names, by file and name (or by file alone, or name alone); null when none.
export function findComponent(list, c) {
  if (!c) return null;
  const name = typeof c === 'string' ? c : c.name;
  const file = typeof c === 'string' ? null : c.file;
  return list.find((x) => x.file === file && x.name === name) || (file && list.find((x) => x.file === file)) || (name && list.find((x) => x.name === name)) || null;
}
