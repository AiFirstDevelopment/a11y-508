// Where the dashboard keeps its own files, so it never litters the app's repository: a per-user
// directory per working directory (~/.a11y-508/<12 hex of sha1(path)>/, or %APPDATA%\a11y-508\…
// on Windows; A11Y_508_HOME overrides the base, for tests). It holds config.json (the loop's
// config, unless the repository has its own), state.json (the sign-in session) and settings.json
// (the remembered start URL and assistant). The outputs (a11y-508-report/, -history/, -work/)
// stay in the working directory, kept out of git through .git/info/exclude.

import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const WRITTEN_BY = 'a11y-508-dashboard';
export const OUTPUT_DIRS = ['a11y-508-report/', 'a11y-508-history/', 'a11y-508-work/'];
export const REPO_CONFIG = 'a11y-508.config.json';
export const REPO_STATE = 'a11y-508-state.json';

export function stateBase(env = process.env, platform = process.platform) {
  if (env.A11Y_508_HOME) return env.A11Y_508_HOME;
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'a11y-508');
  return join(homedir(), '.a11y-508');
}

export function stateDirFor(cwd, env = process.env, platform = process.platform) {
  const id = createHash('sha1').update(resolve(cwd)).digest('hex').slice(0, 12);
  return join(stateBase(env, platform), id);
}

export function paths(cwd, env, platform) {
  const dir = stateDirFor(cwd, env, platform);
  return { dir, config: join(dir, 'config.json'), state: join(dir, 'state.json'), settings: join(dir, 'settings.json') };
}

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

// Whole or not at all, owner-only (the session holds live credentials).
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

export function readSettings(file) {
  const s = readJson(file);
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

// The repository's .git directory for a working directory (it or an ancestor), or null. A .git
// file (a worktree, a submodule) points at the real one.
export function gitDirOf(cwd) {
  for (let d = resolve(cwd); ; ) {
    const g = join(d, '.git');
    try {
      if (existsSync(g)) {
        if (statSync(g).isDirectory()) return g;
        const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(g, 'utf8'));
        if (m) return resolve(d, m[1].trim());
        return null;
      }
    } catch {
      return null;
    }
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

// Adds the output directories to .git/info/exclude (local to this clone, never committed), once.
// Returns the names added; nothing is written outside a git repository.
export function excludeOutputs(cwd) {
  const git = gitDirOf(cwd);
  if (!git) return [];
  const file = join(git, 'info', 'exclude');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {}
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = OUTPUT_DIRS.filter((d) => !have.has(d) && !have.has(d.replace(/\/$/, '')) && !have.has('/' + d));
  if (!missing.length) return [];
  try {
    mkdirSync(join(git, 'info'), { recursive: true });
    appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}# a11y-508 dashboard outputs\n${missing.join('\n')}\n`);
  } catch {
    return [];
  }
  return missing;
}

// Files in the working directory the dashboard may have written before it kept them elsewhere:
// a config marked as the dashboard's moves without asking; the others are asked about once.
export function legacyFiles(cwd) {
  const out = [];
  const cfg = join(cwd, REPO_CONFIG);
  if (existsSync(cfg)) {
    const c = readJson(cfg);
    out.push({ name: REPO_CONFIG, ours: !!(c && c.writtenBy === WRITTEN_BY) });
  }
  if (existsSync(join(cwd, REPO_STATE))) out.push({ name: REPO_STATE, ours: false });
  return out;
}

// Moves the named legacy files into the state directory (config -> config.json, session -> state.json).
export function moveLegacy(cwd, p, names) {
  const moved = [];
  for (const name of names) {
    const from = join(cwd, name);
    if (!existsSync(from)) continue;
    const to = name === REPO_CONFIG ? p.config : name === REPO_STATE ? p.state : null;
    if (!to) continue;
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    if (name === REPO_CONFIG) {
      const c = readJson(from) || {};
      writeJson(to, { ...c, writtenBy: WRITTEN_BY });
      rmSync(from, { force: true });
    } else {
      // Across file systems a rename fails: copy, then remove.
      try {
        renameSync(from, to);
      } catch {
        copyFileSync(from, to);
        rmSync(from, { force: true });
      }
    }
    moved.push(name);
  }
  return moved;
}
