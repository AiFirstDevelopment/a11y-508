// The autonomous fix loop: crawl, diff against the ledger, triage review
// items through the agent, fix open findings through the agent one at a
// time, gate each fix with the app's own build/test command, commit and push,
// wait for the deployment, and go round again until nothing is open or the
// person stops it. State lives in the ledger, so Ctrl+C and resume are safe.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyReport, byStatus, isDone, loadLedger, openFindings, saveLedger, statusCounts } from './ledger.mjs';
import { PRESET_INFO, QUOTA_DELAYS, agentLog, fixPrompt, resolveAgentCommand, runAgent, triagePrompt, writePrompt } from './agent.mjs';
import { testInfo } from './checks/catalog.mjs';
import { migrateRepo, migrationLines, shortenHome, tasksDir, workDir } from './home.mjs';
import { sleep } from './page.mjs';
import { killTree } from './chrome.mjs';
import { MARKER_NAME, bundleSignature as readBuild, hasHashes, sameBuild } from './deploy-check.mjs';

const TOOL_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

// What the application is built with, from its package.json: "Angular 22.2 and Angular Material
// 22.2, with PrimeNG 19; styles in SCSS". null when nothing known is found.
export function frameworkLine(cwd) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const ver = (name) => (deps[name] ? ` ${String(deps[name]).replace(/^[\^~>=<\s]+/, '').split('.').slice(0, 2).join('.')}` : null);
  const known = [['@angular/core', 'Angular'], ['@angular/material', 'Angular Material'], ['primeng', 'PrimeNG'], ['react', 'React'], ['next', 'Next.js'], ['vue', 'Vue'], ['nuxt', 'Nuxt'], ['svelte', 'Svelte'], ['@mui/material', 'MUI'], ['bootstrap', 'Bootstrap'], ['tailwindcss', 'Tailwind CSS'], ['@ionic/angular', 'Ionic']];
  const parts = known.filter(([n]) => deps[n]).map(([n, label]) => `${label}${ver(n) || ''}`);
  if (!parts.length) return null;
  const styles = deps.sass || deps['sass-embedded'] || deps['node-sass'] ? '; styles in SCSS' : deps.less ? '; styles in Less' : '';
  return `${parts.join(', ')}${styles}`;
}

// The app's index.html under its source folders (an Angular, React or Vue app's src/index.html, a
// public/index.html, or one at the root of a source folder), relative to the repository; null when none.
export function findIndexHtml(cwd, sourceDirs) {
  const candidates = [];
  for (const d of sourceDirs) for (const rel of ['index.html', 'public/index.html', 'app/index.html', 'src/index.html']) candidates.push(join(d, rel));
  candidates.push('index.html', 'public/index.html');
  for (const c of candidates) {
    const full = resolve(cwd, c);
    if (existsSync(full) && /<head\b/i.test(readFileSync(full, 'utf8').slice(0, 20000))) return relative(cwd, full).split(sep).join('/');
  }
  return null;
}

// Puts <meta name="a11y-508-build" content="token"> into the file's <head> (replacing an earlier one),
// keeping its line endings. true when the file changed.
export function stampBuildMarker(cwd, file, token) {
  const full = resolve(cwd, file);
  const text = readFileSync(full, 'utf8');
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const tag = `<meta name="${MARKER_NAME}" content="${token}">`;
  const had = /<meta\b[^>]*\bname=["']a11y-508-build["'][^>]*>/i;
  let next;
  if (had.test(text)) next = text.replace(had, tag);
  else {
    const m = /<head\b[^>]*>/i.exec(text);
    if (!m) return false;
    const at = m.index + m[0].length;
    const indent = (/\n([ \t]*)<meta/.exec(text.slice(at, at + 2000)) || [, '  '])[1];
    next = `${text.slice(0, at)}${eol}${indent}${tag}${text.slice(at)}`;
  }
  if (next === text) return false;
  writeFileSync(full, next);
  return true;
}

const SOURCE_EXT = /\.(html?|ts|tsx|js|jsx|mjs|vue|svelte|scss|sass|css|less|cshtml|razor|erb|jsp|php|hbs|njk|twig)$/i;
const LIB_CLASS = /^(mat-|mdc-|cdk-|ng-|ngx-|p-|pi-|fa-|fas-|bi-|btn-|col-|row$|d-|m[tbxy]?-\d|p[tbxy]?-\d|text-|bg-|flex|justify-|align-|w-|h-)/;
// The source files that mention the finding's element -- its ids, data-testids, aria-labels, class
// names (an app's own, not a library's) and visible text -- most matches first, at most `max`.
export function likelyFiles(cwd, sourceDirs, finding, max = 5) {
  const html = String(finding.html || '');
  const tokens = new Map(); // token -> weight
  const add = (t, w) => {
    const k = String(t || '').trim();
    if (k.length >= 3 && !tokens.has(k)) tokens.set(k, w);
  };
  for (const m of html.matchAll(/\b(?:id|data-testid|data-test|name|formcontrolname|aria-label|routerlink|href)=["']([^"']{3,80})["']/gi)) add(m[1], 3);
  for (const m of html.matchAll(/\bclass=["']([^"']+)["']/gi)) for (const c of m[1].split(/\s+/)) if (c && !LIB_CLASS.test(c) && !/^_?ng(content|host)/.test(c)) add(c, 1);
  for (const m of String(finding.selector || '').matchAll(/#([\w-]{3,})/g)) add(m[1], 3);
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  for (const phrase of text.split(/[.!?|·]+/).map((s) => s.trim()).filter((s) => s.length >= 8 && s.length <= 60).slice(0, 4)) add(phrase, 2);
  for (const m of String(finding.message || '').matchAll(/"([^"]{4,60})"/g)) add(m[1], 2);
  if (!tokens.size) return [];
  const scores = new Map();
  let seen = 0;
  const walk = (dir, depth) => {
    if (seen > 6000 || depth > 12) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build' || e.name === 'coverage' || e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && SOURCE_EXT.test(e.name)) {
        seen++;
        let body;
        try {
          if (statSync(full).size > 1024 * 1024) continue;
          body = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        let score = 0;
        for (const [t, w] of tokens) if (body.includes(t)) score += w;
        if (score) scores.set(relative(cwd, full).split(sep).join('/'), score);
      }
    }
  };
  for (const d of sourceDirs) walk(resolve(cwd, d), 0);
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([f]) => f);
}
const BIN = join(TOOL_DIR, 'bin', 'a11y-508.mjs');

export function loadConfig(file, cwd) {
  const path = resolve(cwd, file);
  if (!existsSync(path)) return { _path: path, _missing: true };
  let c;
  try {
    c = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  return { _path: path, ...c };
}

// interactive: whether someone can answer the "deployed": "enter" prompt. A
// terminal can; so can the dashboard, which runs the loop with --events and
// writes the newline to its stdin.
// events: the loop is run by the dashboard. A config that says nothing about the deployment then
// waits for the start page's build to change (with no limit unless the config sets one) rather than
// for an Enter nobody is there to press: the dashboard's loop decides for itself when the site is new.
export function normalizeConfig(c, overrides = {}, { interactive = !!process.stdin.isTTY, events = false } = {}) {
  const cfg = {
    url: overrides.url || c.url || null,
    args: Array.isArray(c.args) ? c.args : [],
    agent: overrides.agent || c.agent || null,
    // A second assistant (a preset or a command), tried on a finding the first failed twice on.
    fallback: typeof c.fallback === 'string' && c.fallback.trim() && c.fallback !== (overrides.agent || c.agent) ? c.fallback.trim() : null,
    source: Array.isArray(c.source) && c.source.length ? c.source : ['src'],
    check: c.check || null,
    checkEvery: c.checkEvery === 'round' ? 'round' : 'finding',
    branch: c.branch || null,
    push: c.push !== false,
    deployed: c.deployed || (c.deploy ? 'command' : events ? 'bundle-change' : 'enter'),
    deploy: c.deploy || null,
    // 0: no limit (the dashboard's): the loop waits for the new build however long it takes and
    // never ends with "has not arrived" (exit 4).
    deployTimeout: typeof c.deployTimeout === 'number' && c.deployTimeout >= 0 ? c.deployTimeout : 30 * 60 * 1000,
    // How often "bundle-change" fetches the start page while it waits for the new build.
    deployPoll: typeof c.deployPoll === 'number' && c.deployPoll > 0 ? c.deployPoll : 30 * 1000,
    maxAttempts: typeof c.maxAttempts === 'number' ? c.maxAttempts : 3,
    agentTimeout: typeof c.agentTimeout === 'number' ? c.agentTimeout : 15 * 60 * 1000,
    triageBatch: typeof c.triageBatch === 'number' ? c.triageBatch : 15,
    // 'ignore' (the default): review items are left out; 'triage': the assistant judges them.
    reviews: c.reviews === 'triage' ? 'triage' : 'ignore',
    // Waits before each retry of an assistant call refused for quota (default 30 s, then 90 s).
    quotaDelays: Array.isArray(c.quotaDelays) && c.quotaDelays.every((n) => typeof n === 'number' && n >= 0) ? c.quotaDelays : QUOTA_DELAYS,
    // After this long with no output from the assistant, the dashboard says it is still waiting.
    quietAfter: typeof c.quietAfter === 'number' && c.quietAfter >= 0 ? c.quietAfter : 30 * 1000,
    // How long one run of the check may take before it is ended (its whole process tree) and the fix reverted.
    checkTimeout: typeof c.checkTimeout === 'number' && c.checkTimeout > 0 ? c.checkTimeout : 20 * 60 * 1000,
    // The session file a crawl behind a sign-in portal uses (see sessionArgs).
    state: typeof c.state === 'string' && c.state ? c.state : 'a11y-508-state.json',
  };
  const errors = [];
  if (!cfg.url) errors.push('no start URL: pass it on the command line or set "url" in the config');
  if (!cfg.agent) errors.push('no agent: set "agent" in the config to claude, gemini, codex, or a command with {promptFile}');
  if (cfg.deployed === 'command' && !cfg.deploy) errors.push('"deployed" is "command" but no "deploy" command is set');
  if (!['command', 'bundle-change', 'enter', 'none'].includes(cfg.deployed)) errors.push(`"deployed" must be command, bundle-change, enter, or none (got ${cfg.deployed})`);
  if (cfg.deployed === 'enter' && !interactive) errors.push('"deployed" is "enter" but there is no interactive terminal to press Enter in; set "deploy" or "deployed": "bundle-change"');
  return { cfg, errors };
}

export const git = (cwd, args, opts = {}) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

// Changed paths under the given directories, from porcelain output (which
// must not be trimmed: the first two columns can be spaces).
export const gitChanged = (cwd, paths = []) => {
  const r = spawnSync('git', ['status', '--porcelain', '--', ...paths], { cwd, encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter((l) => l.length > 3).map((l) => l.slice(3).replace(/^"(.*)"$/, '$1'));
};

// timeoutMs: past it the command and everything it started are ended (taskkill /T on Windows) and
// the result says timedOut.
export const sh = (cwd, command, env, onData = null, timeoutMs = 0) =>
  new Promise((r) => {
    const child = spawn(command, { cwd, shell: true, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let timedOut = false;
    const keep = (d) => {
      out = (out + d).slice(-8000);
      if (onData) onData(String(d));
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      // A process this loop started is never the dashboard's: if a stale record made the tree kill
      // refuse it, the command itself is still ended, so the time limit holds.
      const r = killTree(child.pid, 'check-time-limit');
      if (r && r.refused) {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    }, timeoutMs) : null;
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      r({ code: timedOut ? null : code, out, timedOut });
    });
  });

// A finding's message with its element-specific parts set aside (quoted names, numbers, colours), so
// the same problem on different elements reads the same.
export function messageTemplate(message) {
  return String(message || '')
    .replace(/"[^"]*"|'[^']*'|“[^”]*”/g, '"…"')
    .replace(/#[0-9a-f]{3,8}\b/gi, '#…')
    .replace(/\d+(?:\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

// The check as a build part, run on every fix, and a test part, run once per round: a check of the
// form "<build> && <test>" splits at its first &&; any other check runs whole on every fix.
export function splitCheck(check) {
  const t = typeof check === 'string' ? check.trim() : '';
  if (!t) return { build: null, test: null };
  const i = t.indexOf('&&');
  const build = i > 0 ? t.slice(0, i).trim() : '';
  const test = i > 0 ? t.slice(i + 2).trim() : '';
  // Only two commands joined once: not a quoted "&&", not a second one, and not a first part that
  // sets up the second (cd, export, nvm use, …), whose meaning a split would change.
  const quoted = (str) => ((str.match(/"/g) || []).length % 2 === 1) || ((str.match(/'/g) || []).length % 2 === 1);
  const plain = build && test && !quoted(t.slice(0, i)) && !test.includes('&&') && !/^(cd|pushd|export|set|source|\.|nvm|env|call)\b/i.test(build);
  return plain ? { build, test } : { build: t, test: null };
}

// For an app behind a sign-in portal: when the working directory holds the session file and
// nothing in the crawl options names a way in (--state, --login, --cookie), every round's crawl
// uses the saved session. Returns the arguments to add ([] or ['--state', file]).
export function sessionArgs(cfg, passthrough = [], cwd = process.cwd()) {
  const given = [...(cfg.args || []), ...passthrough].some((a) => /^--(state|login|login-only|cookie)(=|$)/.test(String(a)));
  if (given) return [];
  const file = cfg.state || 'a11y-508-state.json';
  return existsSync(resolve(cwd, file)) ? ['--state', file] : [];
}

// A crawl that could not get into the app because of its sign-in: no page audited, and its pages
// were sent off to another host (a sign-in portal) or refused (401, 403).
export function bouncedToSignIn(report) {
  if (!report || !report.summary || report.summary.audited) return false;
  const pages = Array.isArray(report.pages) ? report.pages : [];
  return pages.length > 0 && pages.some((p) => /redirected off-origin/.test(String(p.skipped || '')) || p.status === 401 || p.status === 403);
}

// Event types from a round's crawl that the loop passes on, tagged with the round.
const RELAYED = new Set(['page', 'coverage', 'summary', 'login-waiting', 'session-saved', 'progress']);

// also: pages audited besides the start page, as they are (the fixes' pages, so they are re-checked).
async function crawlOnce({ cfg, cwd, round, log, passthrough, events, session = [], also = [] }) {
  const out = join(workDir(cwd), `round-${round}`);
  mkdirSync(out, { recursive: true });
  const args = [BIN, cfg.url, ...cfg.args, ...passthrough, ...session, ...also.flatMap((u) => ['--also', u]), '--out', out, '--json', '--quiet'];
  if (events) args.push('--events');
  const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let partial = '';
  const onEventLine = (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (RELAYED.has(ev.type)) {
      const { type, at, ...data } = ev;
      log.event(type, { ...data, round });
    } else if (ev.type === 'warn' || ev.type === 'error') stderr = (stderr + `${ev.type} ${ev.message}\n`).slice(-6000);
  };
  child.stdout.on('data', (d) => {
    if (!events) return void (stdout += d);
    const lines = (partial + d).split('\n');
    partial = lines.pop();
    for (const l of lines) if (l.trim()) onEventLine(l);
  });
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-6000)));
  const code = await new Promise((r) => child.on('exit', r));
  if (partial.trim()) onEventLine(partial);
  writeFileSync(join(out, 'crawl.log'), stderr);
  const reportFile = join(out, 'report.json');
  if (!existsSync(reportFile)) throw new Error(`the crawl produced no report (exit ${code}):\n${stderr.split('\n').filter((l) => /error|warn|redirected/.test(l)).slice(-6).join('\n')}`);
  for (const l of stderr.split('\n')) if (/^(warn|error) /.test(l) && !/TOKEN is not set/.test(l)) log.warn(`crawl: ${l.replace(/^(warn|error) /, '')}`);
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  return { report, code, out };
}

// A visible sign-in on the start page (--login-only): the session is saved to stateFile and nothing
// is crawled. Its sign-in events reach the dashboard with --events. true when a session was saved;
// false when no sign-in happened within the usual wait (or the window could not open).
// connectArgs (the dashboard's own browser): the sign-in is a tab in that window, not a window of its own.
export async function signInOnly({ cfg, cwd, log, events, stateFile, passthrough = [], connectArgs = [] }) {
  const args = [BIN, cfg.url, ...cfg.args.filter((a, i, all) => a !== '--state' && all[i - 1] !== '--state'), ...passthrough, ...connectArgs, '--login-only', '--state', stateFile, '--quiet'];
  if (events) args.push('--events');
  const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let partial = '';
  child.stdout.on('data', (d) => {
    if (!events) return;
    const lines = (partial + d).split('\n');
    partial = lines.pop();
    for (const l of lines) {
      try {
        const ev = JSON.parse(l);
        if (ev.type === 'login-waiting' || ev.type === 'session-saved') {
          const { type, at, ...data } = ev;
          log.event(type, data);
        }
      } catch {}
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  const code = await new Promise((r) => child.on('exit', r));
  if (code === 0) log.info(`signed in; the session is saved to ${stateFile}`);
  else {
    // Why, in the words the sign-in run gave (its last error or warning line), never silently.
    const lines = stderr.split('\n').map((l) => l.trim()).filter((l) => /^(error|warn) /.test(l) || (!/^\{/.test(l) && l));
    const why = (lines.filter((l) => /^error /.test(l)).pop() || lines.pop() || `exit code ${code}`).replace(/^(error|warn) /, '');
    log.warn(`the sign-in did not happen: ${why}`);
    log.event && log.event('sign-in-failed', { reason: why });
  }
  return code === 0;
}

// With --events, the dashboard writes a word per line to stdin while the loop waits for a new build:
// "check" has the site checked now; "fix-remaining" fixes what is open without waiting,
// "stop-waiting" ends the wait, and any other line (an empty one) is "verify": the site is updated.
// onWord is told each word; cancel() stops listening.
function dashboardWords(onWord) {
  const stdin = process.stdin;
  let buf = '';
  const onData = (chunk) => {
    buf += String(chunk);
    for (;;) {
      const nl = buf.search(/\r?\n/);
      if (nl < 0) return;
      const word = buf.slice(0, nl).trim();
      buf = buf.slice(nl).replace(/^\r?\n/, '');
      onWord(word === 'check' || word === 'sign-in' || word === 'fix-remaining' || word === 'stop-waiting' ? word : 'verify');
    }
  };
  stdin.setEncoding('utf8');
  stdin.on('data', onData);
  if (stdin.ref) stdin.ref();
  stdin.resume();
  return {
    cancel: () => {
      stdin.off('data', onData);
      stdin.pause();
      if (stdin.unref) stdin.unref();
    },
  };
}

export function waitForEnter(message, prompt) {
  if (prompt) prompt();
  else process.stdout.write(message);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const onData = (chunk) => {
      if (!/[\r\n]/.test(String(chunk))) return;
      stdin.off('data', onData);
      stdin.pause();
      // With --events stdin is a pipe from the dashboard, which stays open;
      // unref it so the loop can exit when it is done.
      if (prompt && stdin.unref) stdin.unref();
      resolve();
    };
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    if (prompt && stdin.ref) stdin.ref();
    stdin.resume();
  });
}

// One line when each assistant call starts and one when it ends (exit code, time, quota, the last
// lines of its output), in the work folder's agent-calls.log: a call that hangs shows as a start with no
// end, while the loop is still running and afterwards.
export async function callAgent(work, label, args, onOutput = null, onWait = null) {
  const file = join(work, 'agent-calls.log');
  const t0 = new Date();
  appendFileSync(file, `${t0.toISOString()} start ${label}\n`);
  const res = await runAgent({ ...args, onOutput, onWait });
  const tail = `${res.stdout || ''}\n${res.stderr || ''}`.split('\n').map((l) => l.trim()).filter(Boolean).slice(-5).map((l) => `    ${l.slice(0, 300)}`).join('\n');
  appendFileSync(file, `${new Date().toISOString()} end   ${label} exit ${res.code}${res.timedOut ? ' timed-out' : ''}${res.quota ? ` quota (retries ${res.quotaRetries})` : ''} result ${res.result ? 'yes' : 'no'} ${Math.round((Date.now() - t0) / 1000)}s\n${tail ? tail + '\n' : ''}`);
  return res;
}

// The branch the loop commits on, for the one it was given. Git keeps a branch as a path, so while
// "a11y-508/fixes" exists no branch "a11y-508" can be created, and the reverse: the loop then
// continues on the branch in the way (of several nested ones, the most recently committed).
// { branch, exists, reason } -- reason only when it is not the branch asked for. Reads the refs
// through git, never the .git directory (packed refs, worktrees, Windows).
export function resolveBranch(cwd, wanted) {
  // Local branches and origin's (a fresh clone has the earlier run's branch only on origin), newest first.
  const r = git(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads/', 'refs/remotes/origin/']);
  const local = new Set();
  const heads = [];
  for (const ref of r.code === 0 ? r.out.split(/\r?\n/).filter(Boolean) : []) {
    const name = ref.startsWith('refs/heads/') ? ref.slice(11) : ref.slice('refs/remotes/origin/'.length);
    if (ref.startsWith('refs/heads/')) local.add(name);
    else if (name === 'HEAD') continue;
    if (!heads.includes(name)) heads.push(name);
  }
  // remote: only origin has it, so the switch creates the local branch tracking origin's.
  const at = (branch, reason = null) => ({ branch, exists: heads.includes(branch), remote: heads.includes(branch) && !local.has(branch), reason });
  if (!wanted || heads.includes(wanted)) return at(wanted);
  const nested = heads.filter((h) => h.startsWith(`${wanted}/`));
  if (nested.length) {
    const more = nested.length > 1 ? `, the most recently committed of ${nested.length} ${wanted}/* branches` : '';
    return at(nested[0], `a branch ${wanted} cannot be created while ${nested[0]} exists (git keeps branches as paths); continuing on ${nested[0]}${more}`);
  }
  const parts = wanted.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const parent = parts.slice(0, i).join('/');
    if (heads.includes(parent)) return at(parent, `a branch ${wanted} cannot be created while ${parent} exists (git keeps branches as paths); continuing on ${parent}`);
  }
  return at(wanted);
}

// The git command (or setting) that clears a branch the loop could not switch to or create.
function branchRemedy(cwd, target, err) {
  const b = target.branch;
  if (/would be overwritten|commit your changes or stash them/i.test(err)) return `Files outside the source folders block the switch: git stash --include-untracked, then try again.`;
  if (/not a valid branch name|is not a valid|invalid ref/i.test(err)) return `"${b}" is not a name git accepts: set "branch" in the loop settings to one it does (check with: git check-ref-format --branch "${b}"), then try again.`;
  const lock = /'refs\/heads\/([^']+)' exists/.exec(err);
  if (lock) return `Rename the branch in the way: git branch -m "${lock[1]}" "${lock[1]}-old", then try again.`;
  return `Run git ${target.exists ? 'checkout' : 'checkout -b'} "${b}" in ${cwd} to see what git needs, resolve it, then try again.`;
}

// What a run that commits fixes needs of the repository before it starts: a git repository, nothing
// uncommitted under the source folders, and the configured branch checked out (created when it is
// not there). null when it is ready; else { code, message, remedy } for the precondition event.
export function prepareRepo({ cwd, cfg, sourceDirs, log }) {
  if (git(cwd, ['rev-parse', '--is-inside-work-tree']).out !== 'true') {
    return { code: 'not-a-repo', message: `${cwd} is not a git repository; the loop commits each fix, so it needs one`,
      remedy: `Choose the folder that holds the app's git repository, or make this one a repository: git init && git add -A && git commit -m "Initial commit"` };
  }
  const dirty = gitChanged(cwd, sourceDirs);
  if (dirty.length) {
    return { code: 'dirty-tree', message: `uncommitted changes under ${sourceDirs.join(', ')}: ${dirty.join(', ')}`,
      remedy: `Commit or stash them (git stash --include-untracked), then try again, so the loop's commits contain only its own fixes: ${dirty.join(', ')}` };
  }
  if (cfg.branch) {
    const current = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
    const target = resolveBranch(cwd, cfg.branch);
    if (current !== target.branch) {
      const sw = git(cwd, target.remote ? ['checkout', '-b', target.branch, '--track', `origin/${target.branch}`] : target.exists ? ['checkout', target.branch] : ['checkout', '-b', target.branch]);
      if (sw.code !== 0) return { code: 'branch', message: `cannot switch to branch ${target.branch}: ${sw.err.split(/\r?\n/)[0]}`, remedy: branchRemedy(cwd, target, sw.err) };
    }
    if (target.reason) log.info(`on branch ${target.branch}: ${target.reason}`);
    else if (current !== target.branch) log.info(`on branch ${target.branch}`);
  }
  if (!cfg.check) log.warn('no "check" command in the config: fixes are committed without a build or test gate');
  return null;
}

// The tests once for a round's fixes. When they fail: the first fix that breaks them is found (the
// round's commits, bisected; each run within checkTimeout), reverted, and the tests run again; after
// 3 reverts the whole round is rolled back. Tests that also fail without the round's fixes are not
// theirs to answer for: the fixes are kept. fixes: [{ sha, n, test?, message? }] in commit order (a
// fix applied again after a revert gets its new sha). runTests(label) runs the tests once and
// resolves the gate's result ({ code, out, timedOut, ... }); onFail(fix, gate, why) is told of each
// fix taken out, onReapplied(fix) of each applied again, onChange() after each revert.
export async function testRoundFixes({ cwd, sourceDirs, roundBase, fixes, runTests, stopped = () => false, log, ev = () => {}, round, checkTimeout, onFail = () => {}, onReapplied = () => {}, onChange = () => {} }) {
  const duration = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);
  const failed = new Set();
  const live = () => fixes.filter((f) => !failed.has(f));
  const fail = (f, gate, why) => {
    failed.add(f);
    onFail(f, gate, why);
  };
  // The tests run against the source folders as they were at a commit (git restore), never by
  // moving the branch: a stop, or a kill, mid-way leaves every commit in place.
  const at = (sha) => git(cwd, ['restore', `--source=${sha}`, '--worktree', '--', ...sourceDirs]);
  const atTip = () => {
    git(cwd, ['restore', '--source=HEAD', '--worktree', '--', ...sourceDirs]);
    git(cwd, ['clean', '-fdq', '--', ...sourceDirs]);
  };
  // Stopped while the tests ran: their result says nothing about the fixes, which stay committed.
  let halted = false;
  const halt = () => {
    atTip();
    halted = true;
    log.warn("stopped while the tests ran; the round's fixes stay committed, not yet tested");
  };
  log.info(`running the tests once for the round's ${fixes.length} fix(es)`);
  let tests = await runTests('');
  let reverts = 0;
  if (stopped()) halt();
  else if (tests.code !== 0) {
    at(roundBase);
    const before = await runTests('without this round\'s fixes');
    atTip();
    if (stopped()) halt();
    else if (before.code !== 0) {
      log.warn(tests.timedOut && before.timedOut
        ? `the tests did not finish within ${duration(checkTimeout)}, with or without this round's fixes; the fixes are kept, not tested`
        : 'the tests also fail without this round\'s fixes; the fixes are kept, not tested (each passed the build)');
      tests = { code: 0 };
    }
  }
  while (!halted && tests.code !== 0 && reverts < 3 && live().length) {
    const list = live();
    ev('bisect', { round, state: 'start', count: list.length });
    // The first commit whose state fails the tests: a binary search over the round's commits.
    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      at(list[mid].sha);
      const t = await runTests(`with fixes up to ${list[mid].n}`);
      if (stopped()) break;
      if (t.code !== 0) hi = mid;
      else lo = mid + 1;
    }
    atTip();
    if (stopped()) {
      halt();
      break;
    }
    const culprit = list[lo];
    ev('bisect', { round, state: 'found', n: culprit.n ?? 0, test: culprit.test, message: culprit.message, commit: git(cwd, ['rev-parse', '--short', culprit.sha]).out });
    log.warn(`  fix ${culprit.n} (${culprit.test || ''} "${String(culprit.message || '').slice(0, 60)}") breaks the tests; reverting it`);
    // Back to the commit before it, and the later fixes applied again on top (no test runs in between).
    const base = lo > 0 ? list[lo - 1].sha : roundBase;
    git(cwd, ['reset', '-q', '--hard', base]);
    fail(culprit, tests, `fix ${culprit.n} broke the tests`);
    for (const f of list.slice(lo + 1)) {
      const cp = git(cwd, ['cherry-pick', f.sha]);
      if (cp.code !== 0) {
        git(cwd, ['cherry-pick', '--abort']);
        fail(f, tests, `fix ${f.n} could not be applied again after fix ${culprit.n} was reverted`);
        continue;
      }
      f.sha = git(cwd, ['rev-parse', 'HEAD']).out;
      onReapplied(f);
    }
    reverts++;
    onChange();
    tests = live().length ? await runTests('after the revert') : { code: 0 };
    if (stopped()) halt();
  }
  if (!halted && tests.code !== 0) {
    log.warn(`the tests still fail after ${reverts} revert(s); rolling back this round's fixes`);
    git(cwd, ['reset', '-q', '--hard', roundBase]);
    for (const f of live()) fail(f, tests, 'the round\'s tests failed');
  }
  return { halted, failed: [...failed] };
}

// --from-report: the report a crawl just produced, used for the run's first round instead of a
// crawl, when it is for the config's URL and newer than the loop's last commit. Returns the report,
// or null with the reason logged (the round then crawls as before).
export function reportForFirstRound(file, cfg, cwd, log) {
  if (!file) return null;
  const why = (reason) => {
    log.warn(`not starting from ${file}: ${reason}; round 1 crawls instead`);
    return null;
  };
  let report;
  try {
    report = JSON.parse(readFileSync(resolve(cwd, file), 'utf8'));
  } catch (e) {
    return why(`cannot read it (${e.message})`);
  }
  if (!report || !Array.isArray(report.pages) || !report.summary) return why('it is not an a11y-508 report');
  const same = (a, b) => {
    try {
      const x = new URL(a);
      const y = new URL(b);
      return x.origin === y.origin && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '');
    } catch {
      return false;
    }
  };
  if (!same(report.baseUrl, cfg.url)) return why(`it is for ${report.baseUrl}, not ${cfg.url}`);
  if (!report.summary.audited) return why('no page was audited in it');
  const finished = Date.parse(report.finishedAt);
  if (!finished) return why('it has no finishedAt');
  const last = git(cwd, ['log', '-1', '--format=%cI', '--grep=^a11y-508: ']).out;
  if (last && Date.parse(last) >= finished) return why(`it is older than the loop's last commit (${last}), so it would not show that fix`);
  return report;
}

// The words for fixes that wait for a deployment someone else runs: the same in the terminal and on
// the Fix step. d: { pending, branch, remote, pushed, host }.
export function committedSentence(d) {
  const n = d.pending;
  return `${n} fix${n === 1 ? ' is' : 'es are'} committed on branch ${d.branch}${d.pushed && d.remote ? ` and pushed to ${d.remote}` : ''}`;
}
export function deploySentence(d) {
  return `${committedSentence(d)}. The site at ${d.host} still serves the build from before them, so they cannot be verified yet. Deploy that branch — or merge it into the branch your pipeline builds`;
}

// fromReport: a report file for round 1, or true (`--from-report` with no file): the first round
// fixes what the ledger has open, with no crawl. verify / verifyAnyway / wait: what to do about fixes
// that wait for a deployment (ledger.deploy): check the bundles first (the default), crawl whatever
// the site serves, or go on waiting.
export async function runLoop({ config, cwd, log, maxRounds = 20, dryRun = false, signInFirst = false, fromReport = null, resume = false, verifyAnyway = false, wait = false, passthrough = [], stopSignal, events = false }) {
  const { cfg, errors } = normalizeConfig(config, { url: config._url, agent: config._agent }, { interactive: events || !!process.stdin.isTTY, events });
  const ev = (type, data) => log.event && log.event(type, data);
  const ledgerEvent = () => ev('ledger', { rounds: ledger.rounds.length, counts: statusCounts(ledger), line: summaryLine(ledger) });
  if (dryRun) errors.splice(0, errors.length, ...errors.filter((e) => !/agent|deploy|Enter/.test(e)));
  if (errors.length) {
    for (const e of errors) log.error(e);
    return 2;
  }
  // The tool's files for this repository live under the state base (home.mjs); folders an earlier
  // version left in the repository move there first.
  for (const l of migrationLines(migrateRepo(cwd))) log.info(l);
  const work = workDir(cwd);
  const taskFolder = tasksDir(cwd);
  mkdirSync(taskFolder, { recursive: true });
  const ledgerFile = join(work, 'ledger.json');
  const ledger = loadLedger(ledgerFile);
  const save = () => saveLedger(ledgerFile, ledger);
  // The tool's own code, when it is not inside the repository; the prompt names no repository path
  // for the tool's files (there are none).
  const toolRel = relative(cwd, TOOL_DIR);
  // The tool's code is protected wherever it is installed (inside the repository, e.g.
  // node_modules/a11y-508 or tools/a11y-508, by its relative path).
  const protectedDirs = toolRel.startsWith('..') || isAbsolute(toolRel) ? [TOOL_DIR] : toolRel ? [toolRel] : [];
  const agentCommand = resolveAgentCommand(cfg.agent);
  const fallbackCommand = cfg.fallback ? resolveAgentCommand(cfg.fallback) : null;
  const fallbackName = cfg.fallback ? (PRESET_INFO[cfg.fallback] && PRESET_INFO[cfg.fallback].label) || 'the fallback assistant' : null;
  if (fallbackCommand) log.info(`fallback assistant: ${fallbackName}, for a finding ${(PRESET_INFO[cfg.agent] && PRESET_INFO[cfg.agent].label) || 'the assistant'} fails twice on`);
  const sourceDirs = cfg.source;
  const stopped = () => stopSignal && stopSignal.stopped;

  // A set-up error that ends the loop before its first round: one event with what went wrong and
  // what a person can do about it (--events), or both lines printed.
  const precondition = (code, message, remedy) => {
    if (log.events) ev('precondition', { code, message, remedy });
    else {
      log.error(message);
      log.info(`to fix: ${remedy}`);
    }
    return 2;
  };

  if (!dryRun) {
    const pre = prepareRepo({ cwd, cfg, sourceDirs, log });
    if (pre) return precondition(pre.code, pre.message, pre.remedy);
  }

  // --sign-in-first: round 1 signs in, in a visible window, and crawls there (saving a fresh
  // session); the later rounds crawl headless with that session.
  // The session file: the one the crawl options name (the dashboard passes its own), else the config's.
  const named = passthrough.indexOf('--state');
  const stateFile = named >= 0 && passthrough[named + 1] ? passthrough[named + 1] : cfg.state;
  // --connect (the dashboard's own browser): round 1 signs in and crawls in a tab of that window, and
  // a later sign-in (an expired session before verifying) is a tab there too; no other crawl uses it.
  const ci = passthrough.indexOf('--connect');
  const connectArgs = ci >= 0 && passthrough[ci + 1] ? ['--connect', passthrough[ci + 1]] : [];
  if (ci >= 0) passthrough = passthrough.filter((a, i) => i !== ci && i !== ci + 1);
  const signInArgs = connectArgs.length ? [...connectArgs, '--login', '--state', stateFile] : ['--login', '--stay', '--state', stateFile];
  let session = sessionArgs(cfg, passthrough, cwd);
  // The start page's build (deployed: bundle-change): a plain fetch, or the crawler's browser with
  // the crawl's way in when the page is behind a sign-in. null when neither could read it. Says
  // which way only when that changes, so a poll stays quiet.
  let buildVia;
  let lastBuild = null;
  const checkBuild = async (url) => {
    const r = await readBuild(url, { args: [...(cfg.args || []), ...passthrough, ...session], cwd });
    if (r.via !== buildVia) log.info(r.via === 'browser' ? 'read the start page\'s build through the browser with the saved session' : r.via === 'fetch' ? 'read the start page\'s build with a plain request' : `could not read the start page's build${r.reason ? ` (${r.reason})` : ''}`);
    buildVia = r.via;
    lastBuild = r;
    return r;
  };
  // Opens the sign-in (a tab in the dashboard's window, or a window) and, once someone has signed in,
  // takes that session for the checks and the crawls. why: said in the log.
  const openSignIn = async (why) => {
    log.info(`${why}: opening ${connectArgs.length ? 'a tab in the dashboard\'s window' : 'a window'} to sign in`);
    ev('sign-in-opening', { how: connectArgs.length ? 'tab' : 'window', why });
    const ok = await signInOnly({ cfg, cwd, log, events, stateFile, connectArgs, passthrough: passthrough.filter((a, i, all) => a !== '--state' && all[i - 1] !== '--state') });
    if (!ok) return false;
    // Signed in just now: the crawl uses that session instead of signing in again (--sign-in-first).
    signedInNow = true;
    session = sessionArgs(cfg, passthrough, cwd);
    return true;
  };
  const bundleSignature = async (url) => (await checkBuild(url)).signature;
  // Before verifying: when even the browser with the saved session ends on the sign-in portal (the
  // session expired, or there is none), a visible window opens on the start page for the person to
  // sign in, as round 1 does, and the session is saved for the check and the crawl. Returns the
  // build's signature then (null when it still cannot be read, or no sign-in happened in time).
  let signedInNow = false;
  const buildForVerify = async () => {
    const r = await checkBuild(cfg.url);
    if (!r.portal) return r.signature;
    if (!(await openSignIn('the start page asks for a sign-in'))) return null;
    return bundleSignature(cfg.url);
  };
  if (signInFirst && fromReport) log.info(`the first round that crawls signs in first in a visible window; the later rounds crawl with the saved session ${stateFile}`);
  else if (signInFirst) log.info(`round 1 signs in first in a visible window; the later rounds crawl with the saved session ${stateFile}`);
  else if (session.length) log.info(`crawling with the saved session ${session[1]}`);
  // The assistant's output as it arrives (--events): a few events a second at most per call.
  const outputTo = (round, task, kind) => {
    if (!events) return null;
    const buf = { stdout: '', stderr: '' };
    let timer = null;
    const flush = () => {
      timer = null;
      for (const stream of ['stdout', 'stderr']) {
        if (!buf[stream]) continue;
        // The tool's folders are shown as ~/.a11y-508/…, never the full state base.
        ev('agent-output', { round, task, kind, stream, text: shortenHome(buf[stream].slice(-16384)) });
        buf[stream] = '';
      }
    };
    const on = (stream, text) => {
      buf[stream] += text;
      if (!timer) timer = setTimeout(flush, 300);
    };
    on.flush = () => {
      if (timer) clearTimeout(timer);
      flush();
    };
    return on;
  };
  // A quota retry's wait, so the dashboard can count it down; and every call's end, in plain words
  // when it gave no answer (what happens to the work it was given, and that the loop goes on).
  const agentName = (PRESET_INFO[cfg.agent] && PRESET_INFO[cfg.agent].label) || 'The assistant';
  const duration = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);
  const clock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  // Fixes committed and waiting for a new build of the site (deployed: bundle-change): ledger.deploy
  // holds the start page's bundles from before them, the branch and where it was pushed.
  const awaitingDeploy = () => cfg.deployed === 'bundle-change' && !!ledger.deploy && byStatus(ledger, 'pending').length > 0;
  // The pages the fixes awaiting verification were found on (same origin, at most ten): a crawl
  // audits them as they are, so a fix is verified on its own page and not left unchecked.
  const pendingPages = () => {
    let origin = null;
    try {
      origin = new URL(cfg.url).origin;
    } catch {}
    const urls = new Set();
    for (const e of byStatus(ledger, 'pending')) for (const u of e.pages || []) {
      if (u === 'site') continue;
      try {
        if (new URL(u).origin === origin) urls.add(u);
      } catch {}
    }
    return [...urls].slice(0, 10);
  };
  // The build from before the fixes, when it can be compared with: a record with names only (written
  // by an earlier version) cannot tell a same-name deployment, so it counts as no record.
  const baseline = () => (ledger.deploy && ledger.deploy.signature != null && hasHashes(ledger.deploy.signature) ? ledger.deploy.signature : null);
  const hostOf = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return String(u || 'the site');
    }
  };
  const deployFacts = () => ({
    pending: byStatus(ledger, 'pending').length, open: openFindings(ledger).length,
    branch: (ledger.deploy && ledger.deploy.branch) || git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out || 'the current branch',
    remote: ledger.deploy ? ledger.deploy.remote : null, pushed: !!(ledger.deploy && ledger.deploy.pushed), host: hostOf(cfg.url),
    pushedAt: (ledger.deploy && ledger.deploy.pushedAt) || null,
  });
  // deployTimeout 0 (the dashboard's): the wait has no limit, a start against the old build waits
  // instead of ending, and whatever is still open is fixed from the ledger while the build is awaited.
  const forever = !(cfg.deployTimeout > 0);
  // The wait's limit in ms; 0 is none.
  const deployLimit = () => (cfg.deployTimeout > 0 ? cfg.deployTimeout : 0);
  // Fixes waiting while the remaining findings are fixed from the ledger (no crawl): the same facts
  // as the wait itself, so the dashboard says what it is waiting for while it fixes.
  const meanwhileEvent = (round) => {
    const facts = deployFacts();
    ev('await-deploy', { round, committed: facts.pending, nextRound: round + 1, ...facts, intervalMs: cfg.deployPoll, timeoutMs: 0, until: null, meanwhile: true });
  };
  // Waits for the start page's bundles to differ from the ones before the fixes, or for the
  // dashboard's word. Returns 'live', 'verify', 'fix-remaining', 'stop-waiting', 'timeout', 'unreachable'
  // (the time ran out and no poll could read the build to compare) or 'stopped'. With no limit only
  // 'live' or 'stopped' (or a word).
  const waitForDeploy = async (round) => {
    const limit = deployLimit();
    const until = limit ? Date.now() + limit : Infinity;
    const facts = deployFacts();
    log.info(`waiting for your deployment: ${deploySentence(facts)}; checking the start page every ${duration(cfg.deployPoll)}${limit ? ` for up to ${duration(limit)}` : ' until the new build is live'}`);
    // The dashboard's words while the wait goes on: "check" has the site checked at once.
    let said = null;
    let forced = false;
    let signIn = false;
    let wake = null;
    const words = events ? dashboardWords((w) => {
      if (w === 'check') forced = true;
      else if (w === 'sign-in') signIn = forced = true;
      else said = w;
      if (wake) wake();
    }) : null;
    ev('await-deploy', { round, committed: facts.pending, nextRound: round + 1, ...facts, intervalMs: cfg.deployPoll, timeoutMs: limit, until: limit ? new Date(until).toISOString() : null });
    // compared: some poll could set the build against the one from before the fixes.
    let compared = false;
    // With a marker awaited: the first build read in this wait, and builds seen changed without any marker
    // (a pipeline that drops meta tags: two such builds and the bundles' change decides, as without a marker).
    let firstSig = null;
    let markerless = 0;
    try {
      while (Date.now() < until && !stopped()) {
        await Promise.race([sleep(Math.max(0, Math.min(cfg.deployPoll, until - Date.now()))), new Promise((r) => {
          wake = r;
          if (said || forced) r();
        })]);
        wake = null;
        if (said) return said;
        const asked = forced;
        forced = false;
        // Sign in, as asked: the tab opens whatever the check thinks of the page.
        if (signIn) {
          signIn = false;
          await openSignIn('sign-in asked for');
          if (said) return said;
        }
        // With no limit an expired session is signed in again (a tab opens), so the wait can go on checking.
        const sig = limit ? await bundleSignature(cfg.url) : await buildForVerify();
        if (said) return said;
        // Each check on record (when, what the site served, read how, or why not), so the wait is never silent.
        const served = sig !== null && lastBuild ? lastBuild.marker || null : null;
        const expected = ledger.deploy.marker || null;
        let result;
        if (sig === null) result = 'unreadable';
        else if (expected && served === expected) result = 'changed';
        else if (expected && served) result = 'same';
        else if (expected) {
          const against = baseline() || firstSig;
          if (!firstSig) firstSig = sig;
          if (against && !sameBuild(sig, against)) markerless++;
          result = markerless >= 2 ? 'changed' : 'same';
          if (result === 'changed') log.info('the site serves no build marker; going by the bundles having changed');
        } else result = baseline() == null ? 'no-baseline' : sameBuild(sig, baseline()) ? 'same' : 'changed';
        const at = new Date();
        const reason = result === 'unreadable' && lastBuild && lastBuild.reason ? lastBuild.reason : null;
        ev('deploy-check', { round, at: at.toISOString(), result, forced: asked, via: buildVia || null, host: facts.host, pending: facts.pending, ...(reason ? { reason } : {}), ...(expected ? { expected } : {}), ...(served ? { marker: served } : {}) });
        const words = result === 'same' ? (expected ? `still a build without this round's marker ${expected}${served ? ` (it serves ${served})` : ''}` : 'still the build from before the fixes')
          : result === 'changed' ? (expected && served === expected ? `the build with marker ${expected} is live` : 'a new build is live')
          : result === 'unreadable' ? `the start page could not be read${reason ? ` (${reason})` : ''}` : 'no build from before the fixes on record, so this one is verified';
        log.info(`checked ${facts.host} at ${clock(at)}: ${words}`);
        if (expected) {
          if (result === 'changed') return 'live';
          if (sig !== null) compared = true;
          continue;
        }
        // Nothing to compare with when the build from before could not be read: the person's word decides.
        // No limit and no build from before the fixes on record: nothing can ever be compared, so the
        // first build that can be read is verified, as a start with no build on record does.
        if (sig !== null && baseline() == null && !limit) return 'live';
        if (sig === null || baseline() == null) continue;
        compared = true;
        if (result === 'changed') return 'live';
      }
    } finally {
      if (words) words.cancel();
    }
    return stopped() ? 'stopped' : compared ? 'timeout' : 'unreachable';
  };
  // The loop ends waiting for the deployment: not an error (exit 4). What happened, the same
  // explanation, and the three commands that go on.
  const endAwaiting = (state, round) => {
    const facts = deployFacts();
    const head = state === 'still-old' ? 'The site still serves the old build (checked just now); nothing was changed.'
      : state === 'unreachable' ? 'Could not check the site\'s build: a11y-508 could not reach the start page (it may be behind your sign-in).'
      : state === 'timeout' ? `Your deployment has not arrived yet: the start page's bundles did not change within ${duration(cfg.deployTimeout)}.`
      : 'Your deployment has not arrived yet; stopped waiting for it.';
    ev('deployment', { state, round, ...facts, checkedAt: new Date().toISOString(), timeoutMs: cfg.deployTimeout });
    log.warn(head);
    // Unreachable: whether the site still serves the old build is not known, so it is not said.
    log.info(`${state === 'unreachable' ? committedSentence(facts) : deploySentence(facts)}. Then:`);
    log.info('  a11y-508 loop --verify          the site is updated: check its bundles, then verify the fixes');
    if (facts.open) log.info(`  a11y-508 loop --from-report     fix the remaining ${facts.open} without waiting (no crawl)`);
    log.info('  a11y-508 loop --wait            keep waiting for the new build');
    log.info('  a11y-508 loop --verify-anyway   crawl whatever the site serves (fixes not yet deployed count as not holding)');
    save();
    return 4;
  };
  const withOutput = async (label, args, round, task, kind, count = 1) => {
    const on = outputTo(round, task, kind);
    const onWait = (w) => {
      if (on) on.flush();
      ev('agent-wait', { round, task, kind, reason: 'quota', delayMs: w.delayMs, attempt: w.attempt, attempts: w.attempts });
    };
    let res;
    try {
      // A streaming assistant's closing line says what the loop does next, so it is not read as the loop finishing.
      const next = kind === 'triage' ? 'recording its answers next' : cfg.check && cfg.checkEvery === 'finding' ? 'checking the fix next' : 'committing it next';
      const doneLine = (changed, failed, msg) => failed ? `${agentName} ended with an error${msg ? `: ${msg}` : ''}`
        : kind === 'triage' ? `${agentName} is done — ${next}`
        : changed ? `${agentName} is done: ${changed} file${changed === 1 ? '' : 's'} changed — ${next}` : `${agentName} is done: no files changed`;
      res = await callAgent(work, label, { ...args, quotaDelays: cfg.quotaDelays, doneLine }, on, onWait);
    } finally {
      if (on) on.flush();
    }
    const ok = !!res.result;
    const message = ok ? null
      : res.timedOut ? `${agentName} did not answer within ${duration(cfg.agentTimeout)}; the loop goes on`
      : res.circled ? `${agentName} repeated the same failing step over and over, so its call was ended; the loop goes on`
      : res.quota ? `${agentName} was still rate-limited after ${res.quotaRetries} ${res.quotaRetries === 1 ? 'retry' : 'retries'}; the loop goes on`
      : `${agentName} ended without an answer (exit code ${res.code}); the loop goes on`;
    ev('agent-result', { round, task, kind, ok, timedOut: !!res.timedOut, quota: !!res.quota, code: typeof res.code === 'number' ? res.code : null, message });
    return res;
  };

  // The gate, with its output as it arrives (a few events a second at most) and how it ended.
  const parts = cfg.checkEvery === 'finding' ? splitCheck(cfg.check) : { build: cfg.check, test: null };
  const runGate = async (round, n, m, command = cfg.check, part = 'check') => {
    const t0 = Date.now();
    ev('gate', { round, ...(n ? { n, m } : {}), state: 'start', check: command, part });
    let buf = '';
    let timer = null;
    const flush = () => {
      timer = null;
      if (buf) ev('gate-output', { round, text: buf.slice(-16384) });
      buf = '';
    };
    const gate = await sh(cwd, command, process.env, events ? (d) => {
      buf += d;
      if (!timer) timer = setTimeout(flush, 300);
    } : null, cfg.checkTimeout);
    if (timer) clearTimeout(timer);
    flush();
    const tail = gate.out.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-15).join('\n');
    gate.durationMs = Date.now() - t0;
    gate.reason = gate.timedOut ? `the check did not finish within ${duration(cfg.checkTimeout)}` : null;
    gate.tail = gate.reason ? `${gate.reason}\n${tail}`.trim() : tail;
    ev('gate', { round, ...(n ? { n, m } : {}), state: 'done', check: command, part, ok: gate.code === 0, code: gate.code, durationMs: gate.durationMs, tail: gate.tail, ...(gate.reason ? { reason: gate.reason } : {}) });
    return gate;
  };

  // --resume (Continue after an interruption): the ledger's last round goes on from its open
  // findings, with no crawl; the next round crawls.
  const resuming = resume && ledger.rounds.length > 0;
  const startRound = resuming ? ledger.rounds.length : ledger.rounds.length + 1;
  // The report the person just saw stands in for round 1's crawl; the first crawl (and its sign-in) is round 2's.
  // --from-report with no file: the first round fixes what the ledger has open, with no crawl.
  const fromLedger = fromReport === true && !resuming && ledger.rounds.length > 0;
  if (fromReport === true && !resuming && !ledger.rounds.length) log.warn('--from-report: the ledger has no round yet, so round 1 crawls');
  // Fixes waiting for a deployment: a report given for round 1 cannot tell whether it shows them.
  const waiting = !dryRun && !resuming && awaitingDeploy();
  const given = resuming || fromLedger || waiting || fromReport === true ? null : reportForFirstRound(fromReport, cfg, cwd, log);
  if (waiting && typeof fromReport === 'string') log.info(`not starting from ${fromReport}: fixes wait for a deployment, so the site's bundles are checked first and the round crawls`);
  log.info(`a11y-508 loop: ${cfg.url}  agent: ${cfg.agent}  ledger: ${shortenHome(ledgerFile)}${ledger.rounds.length ? `  (resuming after round ${ledger.rounds.length})` : ''}`);

  // The next round fixes from the ledger with no crawl (fix the remaining without waiting).
  let noCrawlNext = fromLedger;
  // ...and it does so while the waiting fixes' build is awaited (no limit on the wait): it says so, and waits after.
  let meanwhileNext = false;
  // Before any crawl that would verify fixes waiting for a deployment: are the start page's bundles
  // still the ones from before them? Then the crawl would count every such fix as not holding, so
  // the loop ends at once instead (--verify-anyway crawls all the same; --wait waits again).
  if (waiting && !fromLedger) {
    if (wait) {
      const w = await waitForDeploy(ledger.rounds.length);
      if (w === 'timeout' || w === 'unreachable' || w === 'stop-waiting') return endAwaiting(w === 'stop-waiting' ? 'stopped-waiting' : w, ledger.rounds.length);
      if (w === 'stopped') {
        log.warn(`stopped. ${summaryLine(ledger)} Rerun the same command to resume.`);
        save();
        return 1;
      }
      if (w === 'fix-remaining') noCrawlNext = true;
      else if (w === 'verify') await buildForVerify();
      else if (w === 'live') {
        log.info('new build is live; giving it 10 seconds to settle');
        // Said at once (no limit on the wait, the dashboard's): the next crawl verifies the fixes.
        if (forever) ev('deployment', { state: 'arrived', round: ledger.rounds.length, ...deployFacts() });
        await sleep(10000);
      }
    } else if (verifyAnyway) {
      log.warn(`verifying anyway: the ${byStatus(ledger, 'pending').length} fixes waiting for a deployment count as not holding wherever the site still shows the finding`);
      ev('deployment', { state: 'verify-anyway', round: ledger.rounds.length, ...deployFacts() });
    } else {
      const sig = await buildForVerify();
      // With no limit on the wait, a start against the build from before the fixes (or one whose build
      // cannot be read) waits for the new one the same way a round does, rather than ending.
      let awaitBuild = false;
      const servedNow = sig !== null && lastBuild ? lastBuild.marker || null : null;
      const expectedNow = ledger.deploy.marker || null;
      const markerSays = expectedNow && sig !== null ? (servedNow === expectedNow ? 'arrived' : servedNow || baseline() != null ? 'old' : null) : null;
      if (markerSays === 'arrived') {
        log.info(`Your deployment arrived (the build with marker ${expectedNow} is live): verifying ${byStatus(ledger, 'pending').length} fixes`);
        ev('deployment', { state: 'arrived', round: ledger.rounds.length, ...deployFacts() });
      } else if (markerSays === 'old') {
        if (!forever) return endAwaiting('still-old', ledger.rounds.length);
        awaitBuild = true;
      } else if (baseline() == null) {
        // No build from before the fixes on record (an earlier run could not read the page), so there is
        // nothing to compare: the person's word stands, and nothing is said about a check that never was.
        log.info(`verifying ${byStatus(ledger, 'pending').length} fixes`);
        ev('deployment', { state: 'verify-anyway', reason: 'no-baseline', round: ledger.rounds.length, ...deployFacts() });
      } else if (sig === null && !forever) {
        // The page could not be read, so the build cannot be compared: the person said the site is updated.
        log.info('could not read the start page to check its build; going by your word that the site is updated');
        ev('deployment', { state: 'verify-anyway', reason: 'unreachable', round: ledger.rounds.length, ...deployFacts() });
      } else if (sig === null || sameBuild(sig, baseline())) {
        if (!forever) return endAwaiting('still-old', ledger.rounds.length);
        awaitBuild = true;
      } else {
        log.info(`Your deployment arrived: verifying ${byStatus(ledger, 'pending').length} fixes`);
        ev('deployment', { state: 'arrived', round: ledger.rounds.length, ...deployFacts() });
      }
      if (awaitBuild && openFindings(ledger).length) {
        log.info(`the site still serves the build from before the ${byStatus(ledger, 'pending').length} waiting fixes; fixing the ${openFindings(ledger).length} remaining meanwhile, then waiting for the new build`);
        noCrawlNext = true;
        meanwhileNext = true;
      } else if (awaitBuild) {
        const w = await waitForDeploy(ledger.rounds.length);
        if (w === 'stopped') {
          log.warn(`stopped. ${summaryLine(ledger)} Rerun the same command to resume.`);
          save();
          return 1;
        }
        if (w === 'fix-remaining') noCrawlNext = true;
        else if (w === 'verify') await buildForVerify();
        else {
          log.info('new build is live; giving it 10 seconds to settle');
          // Said at once (no limit on the wait, the dashboard's): the next crawl verifies the fixes.
          if (forever) ev('deployment', { state: 'arrived', round: ledger.rounds.length, ...deployFacts() });
          await sleep(10000);
        }
      }
    }
  }
  const firstCrawl = given || resuming || noCrawlNext ? startRound + 1 : startRound;

  // When this run last pushed (the dashboard says "pushed to origin at 3:28 PM").
  let pushedAt = null;
  // --max-rounds 0 (the dashboard's): no cap; the loop ends when nothing is left to do, or is stopped.
  const lastRound = maxRounds > 0 ? startRound + maxRounds : Infinity;
  for (let round = startRound; round < lastRound; round++) {
    if (stopped()) break;
    log.info('');
    const resumed = resuming && round === startRound;
    const fromTheLedger = noCrawlNext && !resumed;
    const meanwhile = fromTheLedger && meanwhileNext;
    noCrawlNext = false;
    meanwhileNext = false;
    let signatureBefore = null;
    if (resumed) {
      signatureBefore = cfg.deployed === 'bundle-change' ? (awaitingDeploy() && ledger.deploy.signature != null ? ledger.deploy.signature : await bundleSignature(cfg.url)) : null;
      log.info(`=== round ${round}: continuing where it was interrupted (no crawl) ===`);
      ev('round', { round, resumed: true });
    } else if (fromTheLedger) {
      // A round with no crawl: the ledger's open findings, fixed while the earlier fixes still wait
      // for their deployment (they stay pending). Recorded as a round so its attempts are its own.
      // Fixing meanwhile (no limit on the wait): the build live now, which this round's fixes are not in;
      // once they are pushed the wait compares with it, so a build of only the earlier push is not taken for theirs.
      signatureBefore = cfg.deployed === 'bundle-change' ? (meanwhile ? await bundleSignature(cfg.url) : awaitingDeploy() && ledger.deploy.signature != null ? ledger.deploy.signature : await bundleSignature(cfg.url)) : null;
      const prev = ledger.rounds[ledger.rounds.length - 1] || {};
      ledger.rounds.push({ round, at: new Date().toISOString(), source: 'ledger', pages: prev.pages || 0, audited: prev.audited || 0, violations: prev.violations || 0, reviews: prev.reviews || 0, coverage: null, diff: { new: 0, still: 0, failed: 0, verified: 0, gone: 0, reopened: 0, unchecked: 0, gaveUp: 0 } });
      save();
      log.info(`=== round ${round}: fixing the remaining findings from the ledger (no crawl) ===`);
      ev('round', { round, fromLedger: true });
      ev('step', { round, step: 'ledger', pending: byStatus(ledger, 'pending').length, open: openFindings(ledger).length });
      if (meanwhile) meanwhileEvent(round);
      ledgerEvent();
    } else {
    log.info(`=== round ${round}: crawl ===`);
    ev('round', { round });
    // first: the run's first round, which re-checks the site so this run's fixes are verified against it.
    const fromGiven = given && round === startRound;
    ev('step', fromGiven ? { round, step: 'report', file: fromReport, finishedAt: given.finishedAt } : { round, step: 'crawl', first: round === startRound });
    signatureBefore = cfg.deployed === 'bundle-change' ? await bundleSignature(cfg.url) : null;
    let crawl;
    if (fromGiven) {
      log.info(`round ${round}: starting from ${fromReport} (${given.finishedAt}) instead of crawling; round ${round + 1} crawls to verify the fixes`);
      // The round's report is that report (History lists rounds by their folder): copied whole.
      const out = join(work, `round-${round}`);
      try {
        cpSync(dirname(resolve(cwd, fromReport)), out, { recursive: true });
      } catch (e) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, 'report.json'), JSON.stringify(given, null, 2));
      }
      crawl = { report: given };
    } else try {
      const first = signInFirst && round === firstCrawl && !signedInNow;
      const once = () => crawlOnce({ cfg, cwd, round, log, passthrough: first ? passthrough.filter((a, i, all) => a !== '--state' && all[i - 1] !== '--state') : passthrough, events, session: first ? signInArgs : session, also: pendingPages() });
      try {
        crawl = await once();
      } catch (e) {
        // The saved session file is gone: sign in again, as for an expired one (below).
        if (!(events && !first && /cannot read session file/.test(e.message))) throw e;
        crawl = null;
      }
      if (first) session = sessionArgs(cfg, passthrough, cwd);
      // From the dashboard: a crawl that could not get into the app (the session expired or is gone,
      // and every page was sent to the sign-in) signs in again in a visible tab, waiting as long as it
      // takes, and crawls again; once per round.
      if (events && !first && (!crawl || bouncedToSignIn(crawl.report))) {
        log.info(`round ${round}: the crawl could not get into the app (the sign-in expired); opening ${connectArgs.length ? 'a tab in the dashboard\'s window' : 'a window'} to sign in, then crawling again`);
        ev('step', { round, step: 'sign-in', reason: 'expired' });
        const ok = await signInOnly({ cfg, cwd, log, events, stateFile, connectArgs, passthrough: passthrough.filter((a, i, all) => a !== '--state' && all[i - 1] !== '--state') });
        if (stopped()) break;
        if (ok) {
          signedInNow = true;
          session = sessionArgs(cfg, passthrough, cwd);
          ev('step', { round, step: 'crawl', first: round === startRound, again: true });
          crawl = await crawlOnce({ cfg, cwd, round, log, passthrough, events, session, also: pendingPages() });
        } else if (!crawl) throw new Error('the saved session file is gone and no sign-in happened');
      }
      // Behind a sign-in the build could not be read before this round signed in; the site has not
      // changed since, so it is read again now with the session just saved.
      if ((first || signedInNow) && cfg.deployed === 'bundle-change' && signatureBefore === null) signatureBefore = await bundleSignature(cfg.url);
    } catch (e) {
      log.error(`crawl failed: ${e.message}`);
      save();
      return 2;
    }
    if (stopped()) break;
    const { report } = crawl;
    const s = report.summary;
    if (!s.audited) {
      log.error(`no page could be audited this round; the loop cannot continue. Run the crawl by hand with --troubleshoot.`);
      save();
      return 2;
    }
    const diff = applyReport(ledger, report, round, { maxAttempts: cfg.maxAttempts });
    // The crawl has verified whatever waited for a deployment.
    // The crawl has verified (or failed) whatever waited for a deployment -- unless some of it was on
    // pages this crawl did not reach: then the wait goes on for them.
    if (!byStatus(ledger, 'pending').length) delete ledger.deploy;
    if (fromGiven) Object.assign(ledger.rounds[ledger.rounds.length - 1], { source: 'report', reportFinishedAt: given.finishedAt });
    save();
    ledgerEvent();
    log.info(`pages: ${s.pages} crawled, ${s.audited} audited  violations: ${s.violations}  review items: ${s.reviews}`);
    if (round > 1 || diff.verified.length) log.info(`since last round: ${diff.verified.length} verified fixed, ${diff.failed.length} fix(es) did not hold, ${diff.new.length} new, ${diff.still.length} still open, ${diff.gone.length} gone on their own, ${diff.reopened.length} came back, ${diff.unchecked.length} on pages not audited this round`);
    else log.info(`${diff.new.length} finding(s) recorded`);
    for (const e of diff.gaveUp) log.info(`skipping ${e.test} "${e.message.slice(0, 80)}" after ${e.attempts.length} attempts`);
    for (const w of (s.coverage && s.coverage.warnings) || []) log.warn(`coverage: ${w}`);
    }

    if (isDone(ledger)) {
      log.info('');
      log.info(`nothing left to fix. ${summaryLine(ledger)}`);
      return 0;
    }
    if (dryRun) {
      log.info(`dry run: ${summaryLine(ledger)}`);
      return 1;
    }
    if (stopped()) break;

    // Every assistant call this round: when none of them ran at all, the loop says so as an error.
    const calls = [];
    // Review items ("confirm each label describes its input") are reminders, not problems: ignored by
    // default (a person who meets one reports it), never triaged, fixed or counted. Ones an earlier
    // run opened or gave up on are ignored too; a committed fix stays as it is.
    if (cfg.reviews !== 'triage') {
      let n = 0;
      for (const e of Object.values(ledger.findings)) {
        if (e.level === 'review' && ['review', 'open', 'skipped'].includes(e.status)) {
          e.status = 'ignored';
          n++;
        }
      }
      if (n) save();
    }
    // Triage review items in batches.
    const review = byStatus(ledger, 'review');
    if (review.length) {
      log.info(`=== round ${round}: triage ${review.length} review item(s) ===`);
      const batches = Math.ceil(review.length / cfg.triageBatch);
      for (let i = 0; i < review.length && !stopped(); i += cfg.triageBatch) {
        // One step per assistant call, so the dashboard's timer and output pane start with the call.
        ev('step', { round, step: 'triage', count: review.length, batch: i / cfg.triageBatch + 1, batches, timeoutMs: cfg.agentTimeout, quietMs: cfg.quietAfter });
        const batch = review.slice(i, i + cfg.triageBatch).map((e, k) => ({ id: `r${round}-${i + k}`, entry: e }));
        const items = batch.map(({ id, entry }) => ({ id, test: entry.test, name: entry.name, wcag: entry.wcag, condition: testInfo(entry.test).condition, message: entry.message, selector: entry.selector, html: entry.html, pages: entry.pages }));
        const promptFile = join(taskFolder, `prompt-r${round}-triage-${i}.md`);
        const resultFile = join(taskFolder, `result-r${round}-triage-${i}.json`);
        writePrompt(promptFile, triagePrompt({ items, resultFile }));
        const res = await withOutput(`r${round}-triage-${i}`, { command: agentCommand, promptFile, resultFile, cwd, tasksDir: taskFolder, timeout: cfg.agentTimeout }, round, i / cfg.triageBatch + 1, 'triage', batch.length);
        calls.push(res);
        writeFileSync(join(work, `agent-r${round}-triage-${i}.log`), agentLog(res));
        const decisions = Array.isArray(res.result) ? res.result : Array.isArray(res.result && res.result.items) ? res.result.items : null;
        if (!decisions) {
          log.warn(`triage batch ${i / cfg.triageBatch + 1}: the agent did not return a decision list (exit ${res.code}${res.timedOut ? ', timed out' : ''}${res.quota ? `, refused for quota or rate limit after ${res.quotaRetries} retries` : ''}); items stay in review`);
          continue;
        }
        for (const { id, entry } of batch) {
          const d = decisions.find((x) => x && x.id === id);
          const decision = d && typeof d.decision === 'string' ? d.decision.toLowerCase() : 'unsure';
          // Never left for a person: what the assistant does not call adequate is a problem, and is fixed.
          if (decision === 'adequate') entry.status = 'adequate';
          else entry.status = 'open';
          entry.triage = { round, decision, reason: d && d.reason ? String(d.reason).slice(0, 300) : '' };
        }
        save();
      }
      ledgerEvent();
      const c = statusCounts(ledger);
      log.info(`triage done: ${byStatus(ledger, 'adequate').length} adequate, ${c.open || 0} open to fix, ${c['skipped'] || 0} given up on`);
    }

    // Fix open findings, one bounded prompt each; findings that are the same problem on different
    // elements (same test, same message once its element-specific parts are set aside) are one task.
    const open = openFindings(ledger);
    const groupOf = new Map();
    const tasks = [];
    const byKey = new Map();
    for (const e of open) {
      const key = `${e.test}|${messageTemplate(e.message)}`;
      if (byKey.has(key)) byKey.get(key).push(e);
      else {
        const g = [e];
        byKey.set(key, g);
        groupOf.set(e, g);
        tasks.push(e);
      }
    }
    const members = (e) => groupOf.get(e) || [e];
    log.info(`=== round ${round}: fix ${tasks.length} open finding(s)${tasks.length < open.length ? ` as ${tasks.length} task(s)` : ''} ===`);
    // findings: how many open findings the tasks cover (more than the tasks when some are grouped).
    ev('step', { round, step: 'fix', count: tasks.length, findings: open.length });
    // One row of the run's changes: the finding, the files the working tree shows changed, what
    // became of them, and how long the assistant and the check took.
    const attemptEvent = (n, entry, a, outcome) => ev('attempt', {
      round, n, m: tasks.length, test: entry.test, message: entry.message, elements: members(entry).length, files: a.files || [], outcome,
      commit: a.commit || null, note: a.note || null, agentMs: a.agentMs ?? null, gateMs: a.gateMs ?? null, gateCode: a.gateCode ?? null,
      gateTail: a.gateOutput ? a.gateOutput.split('\n').filter((l) => l.trim()).slice(-15).join('\n') : null,
      ...(a.gateReason ? { reason: a.gateReason } : {}),
    });
    const taskDone = (n, entry, outcome) => {
      ev('task', { round, n: n + 1, m: tasks.length, test: entry.test, impact: entry.impact, message: entry.message, state: 'done', outcome });
      const a = entry.attempts[entry.attempts.length - 1];
      attemptEvent(n + 1, entry, a, outcome === 'no-change' && a.note === 'agent timed out' ? 'timed-out' : outcome);
      ledgerEvent();
    };
    let committed = 0;
    const roundFixed = [];
    // Where the round's commits start: the tests' bisect and a whole-round rollback return here.
    const roundBase = git(cwd, ['rev-parse', 'HEAD']).out;
    for (const [n, entry] of tasks.entries()) {
      if (stopped()) break;
      const label = `${entry.test} ${entry.impact} "${entry.message.slice(0, 70)}"`;
      log.info(`[${n + 1}/${tasks.length}] ${label}`);
      ev('task', { round, n: n + 1, m: tasks.length, test: entry.test, name: entry.name, impact: entry.impact, message: entry.message, elements: members(entry).length, state: 'start', timeoutMs: cfg.agentTimeout, quietMs: cfg.quietAfter });
      const promptFile = join(taskFolder, `prompt-r${round}-fix-${n}.md`);
      const resultFile = join(taskFolder, `result-r${round}-fix-${n}.json`);
      // What the app is built with, and where its element most likely lives: the assistant starts there.
      const hints = { framework: frameworkLine(cwd), files: likelyFiles(cwd, sourceDirs, entry) };
      writePrompt(promptFile, fixPrompt({ finding: entry, group: members(entry), sourceDirs, protectedDirs, resultFile, condition: testInfo(entry.test).condition, hints }));
      // The attempt is on record before the assistant starts: one with no outcome is in progress, so
      // after an interruption its uncommitted changes are known to be the loop's (the dashboard's Continue).
      // The fallback assistant, once the first has failed twice on this finding (no change, an edit that
      // broke the build, a call that ran out of time): a different model may see what the first did not.
      const failedBefore = entry.attempts.filter((a) => a.outcome && a.outcome !== 'pending' && !a.commit).length;
      const useFallback = !!fallbackCommand && failedBefore >= 2;
      const attempt = { round, startedAt: new Date().toISOString(), ...(useFallback ? { assistant: cfg.fallback } : {}) };
      if (useFallback) {
        log.info(`  ${fallbackName} this time: ${(PRESET_INFO[cfg.agent] && PRESET_INFO[cfg.agent].label) || 'the assistant'} made no fix that held in ${failedBefore} tries`);
        ev('fallback', { round, n: n + 1, m: tasks.length, assistant: cfg.fallback, after: failedBefore });
      }
      // Every finding of the task gets the attempt (and so the same outcome and commit).
      for (const e of members(entry)) e.attempts.push(attempt);
      save();
      const res = await withOutput(`r${round}-fix-${n}`, { command: useFallback ? fallbackCommand : agentCommand, promptFile, resultFile, cwd, tasksDir: taskFolder, timeout: cfg.agentTimeout }, round, n + 1, 'fix');
      calls.push(res);
      writeFileSync(join(work, `agent-r${round}-fix-${n}.log`), agentLog(res));
      const changed = gitChanged(cwd, sourceDirs);
      const strayChanges = gitChanged(cwd).filter((f) => !changed.includes(f));
      if (strayChanges.length) {
        log.warn(`  agent changed files outside ${sourceDirs.join(', ')}; reverting them: ${strayChanges.join(', ')}`);
        git(cwd, ['checkout', '--', ...strayChanges]);
        git(cwd, ['clean', '-fdq', '--', ...strayChanges]);
      }
      const note = res.result && res.result.note ? String(res.result.note).slice(0, 300) : res.timedOut ? 'agent timed out' : res.circled ? 'the assistant repeated the same failing step over and over, so its call was ended' : res.quota ? `the assistant's provider refused the call for quota or rate limit (after ${res.quotaRetries} retries)` : `agent exit ${res.code}, no result file`;
      Object.assign(attempt, { n: n + 1, files: changed, note, outcome: 'pending', agentMs: res.durationMs ?? null });
      if (changed.length) ev('changes', { round, n: n + 1, m: tasks.length, files: changed });
      if (!changed.length) {
        attempt.outcome = 'no-change';
        log.info(`  no change (${note})`);
        for (const e of members(entry)) {
          if (e.attempts.length < cfg.maxAttempts) continue;
          e.status = 'skipped';
          e.reason = note;
        }
        if (entry.status === 'skipped') log.info(`  skipped after ${entry.attempts.length} attempts`);
        save();
        taskDone(n, entry, 'no-change');
        continue;
      }
      if (cfg.check && cfg.checkEvery === 'finding') {
        // The build part on every fix; the tests (when the check has them) once for the round.
        log.info(`  checking: ${parts.build}`);
        ev('step', { round, step: 'gate', n: n + 1, m: tasks.length, check: parts.build });
        const gate = await runGate(round, n + 1, tasks.length, parts.build, parts.test ? 'build' : 'check');
        attempt.gateMs = gate.durationMs;
        attempt.gateCode = gate.code;
        if (gate.code !== 0) {
          attempt.outcome = 'failed-gate';
          attempt.gateOutput = `${gate.reason ? `${gate.reason}\n` : ''}${gate.out.slice(-2000)}`;
          if (gate.reason) attempt.gateReason = gate.reason;
          log.warn(`  check failed (${gate.reason || `exit ${gate.code}`}); reverting ${changed.join(', ')}`);
          git(cwd, ['checkout', '--', ...sourceDirs]);
          git(cwd, ['clean', '-fdq', '--', ...sourceDirs]);
          for (const e of members(entry)) {
            if (e.attempts.length < cfg.maxAttempts) continue;
            e.status = 'skipped';
            e.reason = 'the fix broke the build or tests';
          }
          save();
          taskDone(n, entry, 'failed-gate');
          continue;
        }
      }
      ev('step', { round, step: 'commit', n: n + 1, m: tasks.length });
      git(cwd, ['add', '--', ...sourceDirs]);
      const msg = `a11y-508: ${entry.test} ${entry.name}: ${entry.message.slice(0, 72)}\n\nPages: ${entry.pages.slice(0, 5).join(', ')}\nSelector: ${entry.selector}${members(entry).length > 1 ? `\nElements: ${members(entry).length} (the same problem; ${members(entry).slice(1, 4).map((e) => e.selector).join(', ')}${members(entry).length > 4 ? ', …' : ''} too)` : ''}\n${note}`;
      const c = git(cwd, ['commit', '-q', '-m', msg]);
      if (c.code !== 0) {
        log.warn(`  commit failed: ${c.err}`);
        attempt.outcome = 'no-change';
        save();
        taskDone(n, entry, 'commit-failed');
        continue;
      }
      attempt.commit = git(cwd, ['rev-parse', '--short', 'HEAD']).out;
      attempt.commitFull = git(cwd, ['rev-parse', 'HEAD']).out;
      ev('commit', { round, n: n + 1, m: tasks.length, commit: attempt.commit, files: changed });
      for (const e of members(entry)) e.status = 'pending';
      committed++;
      roundFixed.push(entry);
      log.info(`  committed ${attempt.commit}: ${changed.join(', ')}`);
      save();
      taskDone(n, entry, 'committed');
    }

    // The tests once for the round's fixes. When they fail: the first fix that breaks them is found
    // (the round's commits, bisected; each run within checkTimeout), reverted, and the tests run
    // again; after 3 reverts the whole round is rolled back.
    if (committed && parts.test) {
      const failAttempt = (e, gate, why) => {
        const a = e.attempts[e.attempts.length - 1];
        a.outcome = 'failed-gate';
        a.gateOutput = `${why ? `${why}\n` : ''}${gate.reason ? `${gate.reason}\n` : ''}${gate.out.slice(-2000)}`;
        a.gateMs = gate.durationMs;
        a.gateCode = gate.code;
        if (gate.reason) a.gateReason = gate.reason;
        delete a.commit;
        for (const x of members(e)) {
          x.status = x.attempts.length >= cfg.maxAttempts ? 'skipped' : 'open';
          if (x.status === 'skipped') x.reason = 'the fix broke the tests';
        }
        attemptEvent(a.n ?? 0, e, a, 'failed-gate');
      };
      const last = (e) => e.attempts[e.attempts.length - 1];
      const fixes = roundFixed.map((e) => ({ entry: e, sha: last(e).commitFull, n: last(e).n, test: e.test, message: e.message }));
      await testRoundFixes({
        cwd, sourceDirs, roundBase, fixes, log, ev, round, stopped, checkTimeout: cfg.checkTimeout,
        runTests: (label) => {
          log.info(`  tests${label ? ` (${label})` : ''}: ${parts.test}`);
          ev('step', { round, step: 'gate', check: parts.test });
          return runGate(round, null, null, parts.test, 'test');
        },
        onFail: (f, gate, why) => {
          failAttempt(f.entry, gate, why);
          committed--;
        },
        onReapplied: (f) => {
          const a = last(f.entry);
          a.commitFull = f.sha;
          a.commit = git(cwd, ['rev-parse', '--short', f.sha]).out;
          attemptEvent(a.n ?? 0, f.entry, a, 'committed');
        },
        onChange: () => {
          save();
          ledgerEvent();
        },
      });
      roundFixed.splice(0, roundFixed.length, ...roundFixed.filter((e) => last(e).commit));
      save();
      ledgerEvent();
    }

    if (committed && cfg.check && cfg.checkEvery === 'round') {
      log.info(`checking the round's ${committed} fix(es): ${cfg.check}`);
      ev('step', { round, step: 'gate', check: cfg.check });
      const gate = await runGate(round);
      if (gate.code !== 0) {
        log.warn(`check failed (exit ${gate.code}); rolling back this round's ${committed} commit(s)`);
        git(cwd, ['reset', '--hard', `HEAD~${committed}`]);
        for (const e of roundFixed) {
          const a = e.attempts[e.attempts.length - 1];
          a.outcome = 'failed-gate';
          a.gateOutput = gate.out.slice(-2000);
          a.gateMs = gate.durationMs;
          a.gateCode = gate.code;
          delete a.commit;
          attemptEvent(a.n ?? 0, e, a, 'failed-gate');
          for (const x of members(e)) x.status = x.attempts.length >= cfg.maxAttempts ? 'skipped' : 'open';
        }
        committed = 0;
        save();
        ledgerEvent();
      }
    }

    if (!committed) {
      log.info(`round ${round}: nothing was fixed. ${summaryLine(ledger)}`);
      // Earlier fixes still wait for their deployment: the loop waits for it rather than stopping.
      const stillPending = byStatus(ledger, 'pending').length;
      if (!openFindings(ledger).length && !byStatus(ledger, 'review').length && !awaitingDeploy()) {
        // Fixes that still await verification: never left behind; the loop waits for the build with them.
        if (stillPending && cfg.deployed === 'bundle-change') {
          if (!ledger.deploy) {
            ledger.deploy = { round, signature: signatureBefore ?? null, branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out, remote: cfg.push ? 'origin' : null, pushed: !!cfg.push, host: hostOf(cfg.url), since: new Date().toISOString(), pushedAt: null, marker: null };
            save();
          }
          log.info(`${stillPending} fix${stillPending === 1 ? '' : 'es'} still await${stillPending === 1 ? 's' : ''} verification: waiting for the deployment`);
        } else {
          log.info('nothing left the agent can fix; stopping.');
          return isDone(ledger) ? 0 : 1;
        }
      }
      if (!byStatus(ledger, 'pending').length) {
        // An assistant that never ran (not installed, not signed in): every call failed without an answer.
        const failed = calls.filter((r) => !r.result && !r.timedOut && !r.quota && r.code !== 0);
        if (calls.length && failed.length === calls.length) {
          log.error(`${agentName} did not run: all ${calls.length} call${calls.length === 1 ? '' : 's'} this round ended without an answer (last exit code ${failed[failed.length - 1].code}). Check that it is installed and signed in (Test assistant on the Fix step), then try again.`);
          return 1;
        }
        // A fallback assistant that has not had its turn on a finding the first failed twice on: one more round.
        const fallbackDue = !!fallbackCommand && openFindings(ledger).some((e) => e.attempts.filter((a) => a.outcome && a.outcome !== 'pending' && !a.commit).length >= 2 && !e.attempts.some((a) => a.assistant));
        if (!fallbackDue) {
          log.warn('no fix was committed and nothing is pending, so another round would do the same work again; stopping.');
          return 1;
        }
        log.info(`${fallbackName} has not had its turn on the remaining findings: one more round`);
      }
    }

    // The round's build marker: a meta tag in the app's index.html, committed with the round, so the
    // wait knows the build it sees is the one made from this push (not one the pipeline finished late
    // from an earlier push). An app with no index.html under its source folders goes without: the
    // bundles' change decides, as before.
    let marker = null;
    if (committed && cfg.deployed === 'bundle-change') {
      const indexFile = findIndexHtml(cwd, sourceDirs);
      if (!indexFile) log.info('no index.html under the source folders: the wait goes by the bundles changing');
      else {
        const token = `r${round}-${Date.now().toString(36)}`;
        let stamped = false;
        try {
          stamped = stampBuildMarker(cwd, indexFile, token);
        } catch (e) {
          log.warn(`could not write the build marker into ${indexFile}: ${e.message}`);
        }
        if (stamped) {
          git(cwd, ['add', '--', indexFile]);
          const c = git(cwd, ['commit', '-q', '-m', `a11y-508: build marker ${token}\n\nThe fix loop verifies this round's fixes against a build that serves this marker, so a build made from an earlier push is not mistaken for it.`]);
          if (c.code === 0) {
            marker = token;
            log.info(`build marker ${token} committed in ${indexFile}: the fixes are verified against a build that serves it`);
            ev('marker', { round, token, file: indexFile });
          } else log.warn(`could not commit the build marker: ${c.err}`);
        }
      }
    }
    if (committed && cfg.push) {
      const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
      log.info(`pushing ${committed} commit(s) to origin/${branch}`);
      ev('step', { round, step: 'push', committed });
      const p = git(cwd, ['push', '-u', 'origin', branch]);
      if (p.code !== 0) {
        log.error(`push failed: ${p.err}`);
        save();
        return 2;
      }
      pushedAt = new Date().toISOString();
    }

    // What the round committed, where: the dashboard's "Where you are" reads it from the ledger.
    const roundEntry = ledger.rounds.find((r) => r.round === round);
    if (committed && roundEntry) {
      roundEntry.committed = (roundEntry.committed || 0) + committed;
      roundEntry.branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
      roundEntry.pushed = !!cfg.push;
      roundEntry.remote = cfg.push ? 'origin' : null;
    }
    // What the round leaves: open findings and fixes awaiting verification, as a running count.
    if (roundEntry) {
      roundEntry.openAfter = openFindings(ledger).length;
      roundEntry.pendingAfter = byStatus(ledger, 'pending').length;
      save();
    }
    // Earlier fixes still waiting for a deployment (fix the remaining without waiting) wait again.
    const waitAgain = !committed && awaitingDeploy();
    if (committed || waitAgain) {
      ev('step', { round, step: cfg.deployed === 'enter' ? 'await-deploy' : 'deploy', deployed: cfg.deployed, committed });
      if (cfg.deployed === 'command') {
        log.info(`deploying: ${cfg.deploy}`);
        const d = await sh(cwd, cfg.deploy, process.env);
        if (d.code !== 0) {
          log.error(`deploy command failed (exit ${d.code}):\n${d.out.slice(-1500)}`);
          save();
          return 2;
        }
      } else if (cfg.deployed === 'bundle-change') {
        // What the fixes wait for, kept in the ledger so a later run knows: the bundles from before the
        // first of them (an earlier wait's, while the site has not changed since), the branch, the push.
        const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
        const before = ledger.deploy;
        ledger.deploy = {
          // A build on record stays; one never read (null) is replaced by this round's, so the check can work next time.
          // A meanwhile round that committed waits for a build after its own push (see signatureBefore above).
          round, signature: meanwhile && committed > 0 && signatureBefore != null ? signatureBefore : before && before.signature != null ? before.signature : signatureBefore, branch, remote: cfg.push ? 'origin' : null,
          pushed: !!cfg.push && (committed > 0 || !!(before && before.pushed)), host: hostOf(cfg.url), since: before ? before.since : new Date().toISOString(),
          pushedAt: (committed > 0 && pushedAt) || (before && before.pushedAt) || null,
          // The marker the right build serves: this round's when it pushed, else the one still awaited.
          marker: committed > 0 ? marker : (before && before.marker) || null,
        };
        save();
        // No limit on the wait: what is still open is fixed first, from the ledger with no crawl, while
        // the new build is awaited (one such round, then the wait).
        if (forever && !fromTheLedger && openFindings(ledger).length) {
          log.info(`fixing the remaining ${openFindings(ledger).length} from the ledger while the new build is awaited`);
          noCrawlNext = true;
          meanwhileNext = true;
          log.info(`round ${round} done. ${summaryLine(ledger)}`);
          ledgerEvent();
          continue;
        }
        const w = await waitForDeploy(round);
        if (w === 'stopped') break;
        if (w === 'timeout' || w === 'unreachable' || w === 'stop-waiting') return endAwaiting(w === 'stop-waiting' ? 'stopped-waiting' : w, round);
        if (w === 'fix-remaining') {
          log.info('fixing the remaining findings without waiting; the committed fixes stay awaiting verification');
          noCrawlNext = true;
        } else if (w === 'verify') {
          log.info('told the new build is live (The site is updated — verify now)');
          await buildForVerify();
        }
        else {
          log.info('new build is live; giving it 10 seconds to settle');
          // Said at once (no limit on the wait, the dashboard's): the next crawl verifies the fixes.
          if (forever) ev('deployment', { state: 'arrived', round: ledger.rounds.length, ...deployFacts() });
          await sleep(10000);
        }
      } else if (cfg.deployed === 'enter') {
        await waitForEnter(`\nround ${round}: ${committed} fix(es) committed. Deploy them, then press Enter to start round ${round + 1} (Ctrl+C to stop)... `,
          events ? () => ev('await-deploy', { round, committed, nextRound: round + 1 }) : null);
      }
    }
    log.info(`round ${round} done. ${summaryLine(ledger)}`);
    ledgerEvent();
  }
  if (stopped()) log.warn(`stopped. ${summaryLine(ledger)} Rerun the same command to resume.`);
  else log.warn(`reached --max-rounds. ${summaryLine(ledger)} Rerun to continue.`);
  save();
  return isDone(ledger) ? 0 : 1;
}

export function summaryLine(ledger) {
  const c = statusCounts(ledger);
  const part = (k, label) => (c[k] ? `${c[k]} ${label}` : null);
  return [part('open', 'open'), part('review', 'undecided'), part('pending', 'fixed, awaiting verification'), part('verified', 'verified fixed'), part('adequate', 'judged fine'), part('gone', 'gone')].filter(Boolean).join(', ') + '.';
}

export function printStatus(cwd, out) {
  for (const l of migrationLines(migrateRepo(cwd))) out(l);
  const file = join(workDir(cwd), 'ledger.json');
  if (!existsSync(file)) {
    out(`no ledger at ${file}; run "a11y-508 loop <url>" first`);
    return 0;
  }
  const ledger = loadLedger(file);
  out(`a11y-508 loop status: ${ledger.rounds.length} round(s). ${summaryLine(ledger)}`);
  out(`  the tool's files for this repository: ${dirname(workDir(cwd))}`);
  for (const r of ledger.rounds.slice(-5)) out(`  round ${r.round} ${r.at || ''}: ${r.audited}/${r.pages} pages audited, ${r.violations} violations, ${r.reviews} review; +${r.diff.new} new, ${r.diff.verified} verified, ${r.diff.failed} did not hold${r.coverage && !r.coverage.complete ? ', coverage incomplete' : ''}`);
  const groups = [['open', 'OPEN'], ['pending', 'FIXED, AWAITING VERIFICATION'], ['review', 'AWAITING TRIAGE'], ['skipped', 'SKIPPED (THE ASSISTANT COULD NOT FIX THESE)']];
  for (const [status, title] of groups) {
    const list = byStatus(ledger, status);
    if (!list.length) continue;
    out(`\n${title} (${list.length})`);
    for (const e of list.slice(0, 40)) out(`  ${e.test} ${e.impact.padEnd(8)} ${e.message.slice(0, 90)}  [${e.pages.length} page(s), ${e.attempts.length} attempt(s)]${e.reason ? `  ${e.reason}` : ''}`);
    if (list.length > 40) out(`  ... and ${list.length - 40} more`);
  }
  return 0;
}
