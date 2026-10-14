// Where the tool keeps its files for an app's repository, so nothing of its own lives in the
// repository: a per-user state base (~/.a11y-508, or %APPDATA%\a11y-508 on Windows; A11Y_508_HOME
// overrides it, for tests), and under it one folder per repository folder,
// repos/<name>-<6 hex of sha1(its real absolute path)>/ with work/ (the fix loop's ledger, rounds,
// prompts, results, logs and the run journal), report/ (the latest crawl) and history/ (the
// dashboard's earlier crawls). The CLI and the dashboard both use this one mapping.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const { basename, dirname, join, resolve } = path;

// The folders the tool used to keep inside the repository, and where each goes now.
export const LEGACY_DIRS = { 'a11y-508-work': 'work', 'a11y-508-report': 'report', 'a11y-508-history': 'history' };
// The lines the dashboard added to .git/info/exclude for them.
const EXCLUDE_LINES = new Set(['# a11y-508 dashboard outputs', ...Object.keys(LEGACY_DIRS).flatMap((d) => [`${d}/`, d, `/${d}/`, `/${d}`])]);

export function stateBase(env = process.env, platform = process.platform) {
  if (env.A11Y_508_HOME) return env.A11Y_508_HOME;
  if (platform === 'win32') return path.win32.join(env.APPDATA || path.win32.join(homedir(), 'AppData', 'Roaming'), 'a11y-508');
  return join(homedir(), '.a11y-508');
}

// The folder as one path: its real path when it exists (a symlinked or 8.3 spelling is the same
// folder), resolved otherwise. On Windows letter case does not matter.
function canonical(cwd, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let dir = p.resolve(String(cwd));
  if (platform === process.platform) {
    try {
      dir = realpathSync(dir);
    } catch {}
  }
  return platform === 'win32' ? dir.toLowerCase() : dir;
}

// <name>-<hash>: a readable name and a short hash of the folder's absolute path.
export function repoKey(cwd, platform = process.platform) {
  const full = canonical(cwd, platform);
  const p = platform === 'win32' ? path.win32 : path.posix;
  const name = p.basename(full).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 40) || 'repo';
  return `${name}-${createHash('sha1').update(full).digest('hex').slice(0, 6)}`;
}

// The repository folder's own folders under the state base.
export function repoHome(cwd, env = process.env, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dir = p.join(stateBase(env, platform), 'repos', repoKey(cwd, platform));
  return { dir, work: p.join(dir, 'work'), report: p.join(dir, 'report'), history: p.join(dir, 'history') };
}

export const workDir = (cwd, env, platform) => repoHome(cwd, env, platform).work;
export const reportDir = (cwd, env, platform) => repoHome(cwd, env, platform).report;
export const historyDir = (cwd, env, platform) => repoHome(cwd, env, platform).history;
// Where the prompt and result files are: the only folder of the tool's an assistant is given.
export const tasksDir = (cwd, env, platform) => join(workDir(cwd, env, platform), 'tasks');

// The repository's .git directory for a folder (it or an ancestor), or null. A .git file (a
// worktree, a submodule) points at the real one.
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

// A directory moved whole: a rename, or across file systems a copy and then removal of the copied
// source (only after the copy is complete).
function moveDir(from, to) {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
    return;
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
  }
  cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  rmSync(from, { recursive: true, force: true, maxRetries: 5 });
}

// The first free "<name>-old", "<name>-old-2", … next to the destination.
function asideName(to) {
  let name = `${to}-old`;
  for (let i = 2; existsSync(name); i++) name = `${to}-old-${i}`;
  return name;
}

// Removes the .git/info/exclude lines the dashboard added for the old folders; returns them.
export function removeExcludeLines(cwd) {
  const git = gitDirOf(cwd);
  if (!git) return [];
  const file = join(git, 'info', 'exclude');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const removed = lines.filter((l) => EXCLUDE_LINES.has(l.trim()));
  if (!removed.length) return [];
  try {
    writeFileSync(file, lines.filter((l) => !EXCLUDE_LINES.has(l.trim())).join('\n'));
  } catch {
    return [];
  }
  return removed.filter((l) => !l.startsWith('#'));
}

// Whether git tracks anything under a folder of the repository (then it is the team's, not the tool's).
function tracked(root, name) {
  const r = spawnSync('git', ['ls-files', '--', name], { cwd: root, encoding: 'utf8', windowsHide: true });
  return r.status === 0 && (r.stdout || '').trim() !== '';
}

// Once per folder, on first use: a11y-508-work, a11y-508-report and a11y-508-history found directly
// inside it (real directories, never a link, nothing in them tracked by git) move to the folder's
// own place under the state base. Nothing else is touched. Where that place already holds one, the
// repository's copy is set aside as <work|report|history>-old next to it. Returns
// { moved: [{ from, to }], aside: [{ from, to }], kept: [tracked folders left in place],
// excluded: [lines removed from .git/info/exclude] }.
export function migrateRepo(cwd, env = process.env, platform = process.platform) {
  const out = { moved: [], aside: [], kept: [], excluded: [] };
  const root = resolve(cwd);
  const home = repoHome(root, env, platform);
  for (const [legacy, kind] of Object.entries(LEGACY_DIRS)) {
    const from = join(root, legacy);
    let st;
    try {
      st = lstatSync(from);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink() || dirname(from) !== root || basename(from) !== legacy) continue;
    if (tracked(root, legacy)) {
      out.kept.push(from);
      continue;
    }
    const dest = home[kind];
    if (existsSync(dest)) {
      const to = asideName(dest);
      moveDir(from, to);
      out.aside.push({ from, to });
    } else {
      moveDir(from, dest);
      out.moved.push({ from, to: dest });
    }
  }
  out.excluded = removeExcludeLines(root);
  return out;
}

// What a migration did, in lines for a person (none when it did nothing).
export function migrationLines(m) {
  const lines = [];
  for (const x of m.moved) lines.push(`moved ${x.from} to ${x.to} (the tool keeps its files outside the repository now)`);
  for (const x of m.aside) lines.push(`moved ${x.from} aside to ${x.to}: ${dirname(x.to)} already had one`);
  for (const x of m.kept || []) lines.push(`left ${x} where it is: git tracks it`);
  if (m.excluded.length) lines.push(`removed ${m.excluded.join(', ')} from .git/info/exclude`);
  return lines;
}

// Text with the state base shortened to ~/.a11y-508 (both slash directions, for Windows).
export function shortenHome(text, env = process.env, platform = process.platform) {
  const base = stateBase(env, platform);
  let s = String(text);
  const forms = new Set([base, base.replace(/\\/g, '/')]);
  try {
    const real = realpathSync(base);
    forms.add(real);
    forms.add(real.replace(/\\/g, '/'));
  } catch {}
  for (const f of [...forms].sort((a, b) => b.length - a.length)) if (f && f.length > 1) s = s.split(f).join('~/.a11y-508');
  return s;
}
