// What the Fix loop can work out from the working directory instead of asking:
// the repository, its build and test scripts, the folders to edit, and the
// config those suggest. An existing a11y-508.config.json wins over every suggestion.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inGitRepo } from './dirs.mjs';
import { resolveBranch } from '../../src/loop.mjs';

// npm's own placeholder for a package with no tests.
export const PLACEHOLDER_TEST = /no test specified/i;
const SOURCE_DIRS = ['src', 'app', 'lib', 'projects'];
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'a11y-508-work', 'a11y-508-report', 'a11y-508-history', 'coverage']);
// No limit: the dashboard's loop waits for the new build however long it takes (the CLI's own
// default stays 30 minutes).
export const DEPLOY_TIMEOUT = 0;

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? (r.stdout || '').trim() : null;
};

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Folders at the root that hold web source files, for a repository without src/app/lib/projects.
function sourceFolders(cwd) {
  const named = SOURCE_DIRS.find((d) => existsSync(join(cwd, d)) && statSync(join(cwd, d)).isDirectory());
  if (named) return [named];
  const holds = (dir, depth = 0) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.isFile() && /\.(ts|js|html)$/.test(e.name)) return true;
      if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.') && depth < 3 && holds(join(dir, e.name), depth + 1)) return true;
    }
    return false;
  };
  let dirs = [];
  try {
    dirs = readdirSync(cwd, { withFileTypes: true }).filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')).map((e) => e.name);
  } catch {}
  const found = dirs.filter((d) => holds(join(cwd, d))).sort();
  return found.length ? found : ['.'];
}

// `ng test` (Karma) watches for changes and never exits unless told to run once.
export const WATCHING_TEST = (script) => /\bng\s+test\b|\bkarma\b/.test(script) && !/--watch[= ]false|--no-watch|--single-run/.test(script);
export const WATCH_HINT = 'ng test watches for changes and never exits; the check runs it once';

export function checkCommand(scripts) {
  const build = scripts && typeof scripts.build === 'string' && scripts.build.trim() ? 'npm run build' : null;
  const raw = scripts && typeof scripts.test === 'string' && scripts.test.trim() && !PLACEHOLDER_TEST.test(scripts.test) ? scripts.test : null;
  const watching = !!raw && WATCHING_TEST(raw);
  const test = raw ? (watching ? 'npm test -- --watch=false --browsers=ChromeHeadless' : 'npm test') : null;
  return { build, test, check: build && test ? `${build} && ${test}` : build || test || null, ...(watching ? { testHint: WATCH_HINT } : {}) };
}

export function loopDefaults(cwd, config = null) {
  // The same test the rest of the dashboard uses (a .git here or above), so the screens agree.
  const inRepo = inGitRepo(cwd);
  const remotes = inRepo ? (git(cwd, ['remote']) || '').split(/\r?\n/).filter(Boolean) : [];
  const remote = remotes.includes('origin') ? 'origin' : null;
  // symbolic-ref also names the branch of a repository with no commits yet.
  const branch = inRepo ? git(cwd, ['symbolic-ref', '--short', 'HEAD']) || git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) : null;
  const pkg = readJson(join(cwd, 'package.json'));
  const { build, test, check, testHint } = checkCommand(pkg && pkg.scripts);
  const source = sourceFolders(cwd);
  // The branch the loop will really use: a11y-508 cannot be created while an a11y-508/* branch
  // exists, and the loop then continues on that one (resolveBranch, the loop's own rule).
  const use = (wanted) => (inRepo ? resolveBranch(cwd, wanted) : { branch: wanted, reason: null });
  const suggested = { source, check, branch: use('a11y-508').branch, push: !!remote, deployed: 'bundle-change', deployTimeout: DEPLOY_TIMEOUT, maxAttempts: 3 };
  const c = config && typeof config === 'object' ? config : null;
  const effective = { ...suggested };
  if (c) for (const k of Object.keys(suggested)) if (c[k] !== undefined && c[k] !== null && c[k] !== '') effective[k] = c[k];
  // The configured branch, and the one the loop will commit on for it (with why, when they differ).
  const wanted = c && typeof c.branch === 'string' && c.branch ? c.branch : 'a11y-508';
  const used = use(wanted);
  effective.branch = used.branch;
  return {
    repo: { git: inRepo, remote, branch },
    branch: { wanted, used: used.branch, reason: used.reason || null },
    package: { exists: !!pkg, build, test, ...(testHint ? { testHint } : {}) },
    source,
    suggested,
    effective,
    configExists: !!c,
  };
}
