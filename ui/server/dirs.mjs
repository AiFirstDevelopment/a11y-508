// The folder picker's view of the machine: directories only, never files,
// with the five facts that say what an a11y-508 working directory holds.
// The server is local, bound to 127.0.0.1 and behind the session secret, so
// it can list folders for the page, which a browser cannot do for itself.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BadRequest } from './args.mjs';
import { repoHome } from '../../src/home.mjs';

export const CONFIG_FILE = 'a11y-508.config.json';

const home = (dir) => {
  try {
    return repoHome(dir);
  } catch {
    return { report: '', work: '' };
  }
};
const exists = (...p) => {
  try {
    return !!p[0] && existsSync(join(...p));
  } catch {
    return false;
  }
};

// What a directory holds, as five booleans.
export function factsOf(dir) {
  const has = (...p) => {
    try {
      return existsSync(join(dir, ...p));
    } catch {
      return false;
    }
  };
  return {
    git: has('.git'),
    config: has(CONFIG_FILE),
    // The tool's own folder for it (or, before it was migrated, the old folders in it).
    report: exists(home(dir).report, 'report.json') || has('a11y-508-report', 'report.json'),
    ledger: exists(home(dir).work, 'ledger.json') || has('a11y-508-work', 'ledger.json'),
    session: has('a11y-508-state.json'),
    package: has('package.json'),
  };
}

// Inside a git work tree: this directory or any parent holds .git, the way
// the loop's `git rev-parse --is-inside-work-tree` sees it. (facts.git is
// the folder itself being a repository root, for the picker's badge.)
export function inGitRepo(dir) {
  for (let d = dir; ; ) {
    try {
      if (existsSync(join(d, '.git'))) return true;
    } catch {}
    const parent = dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}

// An operating-system error as an HTTP error: missing or not a directory is
// 404, not allowed is 403; the message is the operating system's own.
function osError(e) {
  const status = e.code === 'EACCES' || e.code === 'EPERM' ? 403 : e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 404 : 400;
  return new BadRequest(e.message, status);
}

// A path from the page: absolute, or ~ / ~/... for the home directory.
export function expandPath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new BadRequest('path must be a non-empty string');
  let s = p.trim();
  if (s.includes('\0')) throw new BadRequest('path must not contain a NUL character');
  if (s === '~') s = homedir();
  else if (/^~[\\/]/.test(s)) s = join(homedir(), s.slice(2));
  if (!isAbsolute(s)) throw new BadRequest(`path must be absolute (or start with ~): ${p}`);
  return resolve(s);
}

// The real directory behind a path (symlinks followed), readable, or an error.
export function realDir(p) {
  const abs = expandPath(p);
  let real;
  try {
    real = realpathSync(abs);
    if (!statSync(real).isDirectory()) {
      const e = new Error(`ENOTDIR: not a directory, '${abs}'`);
      e.code = 'ENOTDIR';
      throw e;
    }
    readdirSync(real);
  } catch (e) {
    throw osError(e);
  }
  return real;
}

// The roots: / on macOS and Linux; the drive letters that exist on Windows,
// probed one by one.
export function roots(platform = process.platform) {
  if (platform !== 'win32') return ['/'];
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:\\`;
    try {
      if (statSync(d).isDirectory()) out.push(d);
    } catch {}
  }
  return out;
}

// Names of the subdirectories Windows marks hidden (the attribute, which Node
// cannot read), from cmd's own dir. Empty when there are none.
function windowsHidden(dir) {
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"chcp 65001>nul & dir /a:hd /b "${dir}""`], { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true, timeout: 10000 });
  return new Set(String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// Each ancestor of dir, root first, for the breadcrumbs.
function crumbs(dir) {
  const out = [];
  let d = dir;
  for (;;) {
    const parent = dirname(d);
    out.unshift({ name: parent === d ? d : d.slice(parent.length).replace(/^[\\/]/, ''), path: d });
    if (parent === d) break;
    d = parent;
  }
  return out;
}

// GET /api/dirs: the roots with no path; otherwise the directory's
// subdirectories (never files), sorted by name, with its parent and facts.
export function listDirs(p, platform = process.platform) {
  if (p === null || p === undefined || p === '') {
    return { roots: true, path: null, parent: null, crumbs: [], facts: null, dirs: roots(platform).map((r) => ({ name: r, path: r, hidden: false, facts: factsOf(r) })) };
  }
  const dir = realDir(p);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw osError(e);
  }
  const hiddenAttr = platform === 'win32' ? windowsHidden(dir) : new Set();
  const dirs = [];
  for (const ent of entries) {
    const full = join(dir, ent.name);
    let isDir = ent.isDirectory();
    if (!isDir && ent.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory();
      } catch {}
    }
    if (!isDir) continue;
    dirs.push({ name: ent.name, path: full, hidden: ent.name.startsWith('.') || hiddenAttr.has(ent.name), facts: factsOf(full) });
  }
  dirs.sort(byName);
  const parent = dirname(dir);
  return { roots: false, path: dir, parent: parent === dir ? null : parent, crumbs: crumbs(dir), facts: factsOf(dir), dirs };
}
