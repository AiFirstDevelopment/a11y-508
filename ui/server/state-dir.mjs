// Where the dashboard keeps its own files, so it never litters the app's repository: a per-user
// directory per working directory (~/.a11y-508/<12 hex of sha1(path)>/, or %APPDATA%\a11y-508\…
// on Windows; A11Y_508_HOME overrides the base, for tests). It holds config.json (the loop's
// config, unless the repository has its own), state.json (the sign-in session) and settings.json
// (the remembered start URL and assistant). The outputs (the report, the history, the loop's work
// folder) are under the same base too, per repository (src/home.mjs: repos/<name>-<hash>/).

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { gitDirOf, stateBase } from '../../src/home.mjs';

export { gitDirOf, stateBase };

export const WRITTEN_BY = 'a11y-508-dashboard';
export const REPO_CONFIG = 'a11y-508.config.json';
export const REPO_STATE = 'a11y-508-state.json';

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

// The dashboard's own settings across repositories (~/.a11y-508/settings.json): the last app
// repository folder and start URL, so a new browser profile (the dashboard's own Chrome) starts
// where the person left off.
export const globalSettingsFile = (env = process.env, platform = process.platform) => join(stateBase(env, platform), 'settings.json');
export function readGlobal(env, platform) {
  return readSettings(globalSettingsFile(env, platform));
}
export function writeGlobal(patch, env, platform) {
  const cur = readGlobal(env, platform);
  const next = { ...cur, ...patch };
  if (JSON.stringify(next) !== JSON.stringify(cur)) writeJson(globalSettingsFile(env, platform), next);
  return next;
}

// The remembered folder to start in, or null: it must still be a directory, and must not be the
// launch directory's parent or any ancestor of it (a launch inside a repository is never moved up
// to the folder that holds it).
export function rememberedStart(lastCwd, launchDir, realDir) {
  if (typeof lastCwd !== 'string' || !lastCwd) return null;
  let dir;
  try {
    dir = realDir(lastCwd);
  } catch {
    return null;
  }
  let launch = resolve(launchDir);
  try {
    launch = realDir(launchDir);
  } catch {}
  const rel = relative(dir, launch);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return null;
  return dir;
}

export function readSettings(file) {
  const s = readJson(file);
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
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
