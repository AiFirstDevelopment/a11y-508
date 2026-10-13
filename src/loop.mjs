// The autonomous fix loop: crawl, diff against the ledger, triage review
// items through the agent, fix open findings through the agent one at a
// time, gate each fix with the app's own build/test command, commit and push,
// wait for the deployment, and go round again until nothing is open or the
// person stops it. State lives in the ledger, so Ctrl+C and resume are safe.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyReport, byStatus, isDone, loadLedger, openFindings, saveLedger, statusCounts } from './ledger.mjs';
import { PRESET_INFO, QUOTA_DELAYS, agentLog, fixPrompt, resolveAgentCommand, runAgent, triagePrompt, writePrompt } from './agent.mjs';
import { testInfo } from './checks/catalog.mjs';
import { sleep } from './page.mjs';
import { killTree } from './chrome.mjs';

export const WORK_DIR = 'a11y-508-work';
const TOOL_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
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
export function normalizeConfig(c, overrides = {}, { interactive = !!process.stdin.isTTY } = {}) {
  const cfg = {
    url: overrides.url || c.url || null,
    args: Array.isArray(c.args) ? c.args : [],
    agent: overrides.agent || c.agent || null,
    source: Array.isArray(c.source) && c.source.length ? c.source : ['src'],
    check: c.check || null,
    checkEvery: c.checkEvery === 'round' ? 'round' : 'finding',
    branch: c.branch || null,
    push: c.push !== false,
    deployed: c.deployed || (c.deploy ? 'command' : 'enter'),
    deploy: c.deploy || null,
    deployTimeout: typeof c.deployTimeout === 'number' ? c.deployTimeout : 30 * 60 * 1000,
    maxAttempts: typeof c.maxAttempts === 'number' ? c.maxAttempts : 3,
    agentTimeout: typeof c.agentTimeout === 'number' ? c.agentTimeout : 15 * 60 * 1000,
    triageBatch: typeof c.triageBatch === 'number' ? c.triageBatch : 15,
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

const git = (cwd, args, opts = {}) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

// Changed paths under the given directories, from porcelain output (which
// must not be trimmed: the first two columns can be spaces).
const gitChanged = (cwd, paths = []) => {
  const r = spawnSync('git', ['status', '--porcelain', '--', ...paths], { cwd, encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter((l) => l.length > 3).map((l) => l.slice(3).replace(/^"(.*)"$/, '$1'));
};

// timeoutMs: past it the command and everything it started are ended (taskkill /T on Windows) and
// the result says timedOut.
const sh = (cwd, command, env, onData = null, timeoutMs = 0) =>
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
      killTree(child.pid);
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
  return build && test ? { build, test } : { build: t, test: null };
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

// Event types from a round's crawl that the loop passes on, tagged with the round.
const RELAYED = new Set(['page', 'coverage', 'summary', 'login-waiting', 'session-saved', 'progress']);

async function crawlOnce({ cfg, cwd, round, log, passthrough, events, session = [] }) {
  const out = join(cwd, WORK_DIR, `round-${round}`);
  mkdirSync(out, { recursive: true });
  const args = [BIN, cfg.url, ...cfg.args, ...passthrough, ...session, '--out', out, '--json', '--quiet'];
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

async function bundleSignature(url) {
  try {
    const headers = {};
    if (process.env.TOKEN) headers.authorization = /^\S+\s+\S/.test(process.env.TOKEN.trim()) ? process.env.TOKEN.trim() : `Bearer ${process.env.TOKEN.trim()}`;
    const res = await fetch(url, { headers, redirect: 'follow' });
    const html = await res.text();
    const refs = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']/gi)].map((m) => m[1]).sort();
    return refs.join('\n');
  } catch {
    return null;
  }
}

// With --events, the dashboard's "Deployed — continue" writes a newline to stdin. While the loop
// polls for a new build it also listens for that, so the button works whatever "deployed" says.
function enterFromDashboard() {
  const stdin = process.stdin;
  let onData;
  const promise = new Promise((resolve) => {
    onData = (chunk) => {
      if (/[\r\n]/.test(String(chunk))) resolve(true);
    };
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    if (stdin.ref) stdin.ref();
    stdin.resume();
  });
  const cancel = () => {
    stdin.off('data', onData);
    stdin.pause();
    if (stdin.unref) stdin.unref();
  };
  return { promise, cancel };
}

function waitForEnter(message, prompt) {
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
// lines of its output), in a11y-508-work/agent-calls.log: a call that hangs shows as a start with no
// end, while the loop is still running and afterwards.
async function callAgent(work, label, args, onOutput = null, onWait = null) {
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

export async function runLoop({ config, cwd, log, maxRounds = 20, dryRun = false, signInFirst = false, fromReport = null, resume = false, passthrough = [], stopSignal, events = false }) {
  const { cfg, errors } = normalizeConfig(config, { url: config._url, agent: config._agent }, { interactive: events || !!process.stdin.isTTY });
  const ev = (type, data) => log.event && log.event(type, data);
  const ledgerEvent = () => ev('ledger', { rounds: ledger.rounds.length, counts: statusCounts(ledger), line: summaryLine(ledger) });
  if (dryRun) errors.splice(0, errors.length, ...errors.filter((e) => !/agent|deploy|Enter/.test(e)));
  if (errors.length) {
    for (const e of errors) log.error(e);
    return 2;
  }
  const work = join(cwd, WORK_DIR);
  mkdirSync(work, { recursive: true });
  const ledgerFile = join(work, 'ledger.json');
  const ledger = loadLedger(ledgerFile);
  const save = () => saveLedger(ledgerFile, ledger);
  const protectedDirs = [relative(cwd, TOOL_DIR) || '.', WORK_DIR, 'a11y-508-report'];
  const agentCommand = resolveAgentCommand(cfg.agent);
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
    if (git(cwd, ['rev-parse', '--is-inside-work-tree']).out !== 'true') {
      return precondition('not-a-repo', `${cwd} is not a git repository; the loop commits each fix, so it needs one`,
        `Choose the folder that holds the app's git repository, or make this one a repository: git init && git add -A && git commit -m "Initial commit"`);
    }
    const dirty = gitChanged(cwd, sourceDirs);
    if (dirty.length) {
      return precondition('dirty-tree', `uncommitted changes under ${sourceDirs.join(', ')}: ${dirty.join(', ')}`,
        `Commit or stash them (git stash --include-untracked), then try again, so the loop's commits contain only its own fixes: ${dirty.join(', ')}`);
    }
    if (cfg.branch) {
      const current = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
      const target = resolveBranch(cwd, cfg.branch);
      if (current !== target.branch) {
        const sw = git(cwd, target.remote ? ['checkout', '-b', target.branch, '--track', `origin/${target.branch}`] : target.exists ? ['checkout', target.branch] : ['checkout', '-b', target.branch]);
        if (sw.code !== 0) return precondition('branch', `cannot switch to branch ${target.branch}: ${sw.err.split(/\r?\n/)[0]}`, branchRemedy(cwd, target, sw.err));
      }
      if (target.reason) log.info(`on branch ${target.branch}: ${target.reason}`);
      else if (current !== target.branch) log.info(`on branch ${target.branch}`);
    }
    if (!cfg.check) log.warn('no "check" command in the config: fixes are committed without a build or test gate');
  }

  // --sign-in-first: round 1 signs in, in a visible window, and crawls there (saving a fresh
  // session); the later rounds crawl headless with that session.
  // The session file: the one the crawl options name (the dashboard passes its own), else the config's.
  const named = passthrough.indexOf('--state');
  const stateFile = named >= 0 && passthrough[named + 1] ? passthrough[named + 1] : cfg.state;
  // --connect (the dashboard's own browser): round 1 signs in and crawls in a tab of that window;
  // no later round uses it.
  const ci = passthrough.indexOf('--connect');
  const connectArgs = ci >= 0 && passthrough[ci + 1] ? ['--connect', passthrough[ci + 1]] : [];
  if (ci >= 0) passthrough = passthrough.filter((a, i) => i !== ci && i !== ci + 1);
  const signInArgs = connectArgs.length ? [...connectArgs, '--login', '--state', stateFile] : ['--login', '--stay', '--state', stateFile];
  let session = sessionArgs(cfg, passthrough, cwd);
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
        ev('agent-output', { round, task, kind, stream, text: buf[stream].slice(-16384) });
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
    const what = kind === 'triage' ? `the ${count} review item${count === 1 ? ' stays' : 's stay'} in review` : 'this finding stays open';
    const message = ok ? null
      : res.timedOut ? `${agentName} did not answer within ${duration(cfg.agentTimeout)}; ${what} and the loop goes on`
      : res.quota ? `${agentName} was still rate-limited after ${res.quotaRetries} ${res.quotaRetries === 1 ? 'retry' : 'retries'}; ${what} and the loop goes on`
      : `${agentName} ended without an answer (exit code ${res.code}); ${what} and the loop goes on`;
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
  const given = resuming ? null : reportForFirstRound(fromReport, cfg, cwd, log);
  const firstCrawl = given || resuming ? startRound + 1 : startRound;
  log.info(`a11y-508 loop: ${cfg.url}  agent: ${cfg.agent}  ledger: ${relative(cwd, ledgerFile)}${ledger.rounds.length ? `  (resuming after round ${ledger.rounds.length})` : ''}`);

  for (let round = startRound; round < startRound + maxRounds; round++) {
    if (stopped()) break;
    log.info('');
    const resumed = resuming && round === startRound;
    let signatureBefore = null;
    if (resumed) {
      signatureBefore = cfg.deployed === 'bundle-change' ? await bundleSignature(cfg.url) : null;
      log.info(`=== round ${round}: continuing where it was interrupted (no crawl) ===`);
      ev('round', { round, resumed: true });
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
      // The round's report is that report (History lists rounds by their folder): copied, with its screenshots.
      const out = join(cwd, WORK_DIR, `round-${round}`);
      try {
        cpSync(dirname(resolve(cwd, fromReport)), out, { recursive: true });
      } catch (e) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, 'report.json'), JSON.stringify(given, null, 2));
      }
      crawl = { report: given };
    } else try {
      const first = signInFirst && round === firstCrawl;
      crawl = await crawlOnce({ cfg, cwd, round, log, passthrough: first ? passthrough.filter((a, i, all) => a !== '--state' && all[i - 1] !== '--state') : passthrough, events, session: first ? signInArgs : session });
      if (first) session = sessionArgs(cfg, passthrough, cwd);
    } catch (e) {
      log.error(`crawl failed: ${e.message}`);
      save();
      return 2;
    }
    const { report } = crawl;
    const s = report.summary;
    if (!s.audited) {
      log.error(`no page could be audited this round; the loop cannot continue. Run the crawl by hand with --troubleshoot.`);
      save();
      return 2;
    }
    const diff = applyReport(ledger, report, round, { maxAttempts: cfg.maxAttempts });
    if (fromGiven) Object.assign(ledger.rounds[ledger.rounds.length - 1], { source: 'report', reportFinishedAt: given.finishedAt });
    save();
    ledgerEvent();
    log.info(`pages: ${s.pages} crawled, ${s.audited} audited  violations: ${s.violations}  review items: ${s.reviews}`);
    if (round > 1 || diff.verified.length) log.info(`since last round: ${diff.verified.length} verified fixed, ${diff.failed.length} fix(es) did not hold, ${diff.new.length} new, ${diff.still.length} still open, ${diff.gone.length} gone on their own, ${diff.reopened.length} came back, ${diff.unchecked.length} on pages not audited this round`);
    else log.info(`${diff.new.length} finding(s) recorded`);
    for (const e of diff.gaveUp) log.warn(`giving up on ${e.test} "${e.message.slice(0, 80)}" after ${e.attempts.length} attempts; marked needs-human`);
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
        const promptFile = join(work, `prompt-r${round}-triage-${i}.md`);
        const resultFile = join(work, `result-r${round}-triage-${i}.json`);
        writePrompt(promptFile, triagePrompt({ items, resultFile }));
        const res = await withOutput(`r${round}-triage-${i}`, { command: agentCommand, promptFile, resultFile, cwd, timeout: cfg.agentTimeout }, round, i / cfg.triageBatch + 1, 'triage', batch.length);
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
          if (decision === 'adequate') entry.status = 'adequate';
          else if (decision === 'inadequate') entry.status = 'open';
          else entry.status = 'needs-human';
          entry.triage = { round, decision, reason: d && d.reason ? String(d.reason).slice(0, 300) : '' };
        }
        save();
      }
      ledgerEvent();
      const c = statusCounts(ledger);
      log.info(`triage done: ${byStatus(ledger, 'adequate').length} adequate, ${c.open || 0} open to fix, ${c['needs-human'] || 0} need a person`);
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
    log.info(`=== round ${round}: fix ${tasks.length} open finding(s)${tasks.length < tasks.length ? ` as ${tasks.length} task(s)` : ''} ===`);
    ev('step', { round, step: 'fix', count: tasks.length });
    // One row of the run's changes: the finding, the files the working tree shows changed, what
    // became of them, and how long the assistant and the check took.
    const attemptEvent = (n, entry, a, outcome) => ev('attempt', {
      round, n, m: tasks.length, test: entry.test, message: entry.message, elements: members(entry).length, files: a.files || [], outcome,
      commit: a.commit || null, agentMs: a.agentMs ?? null, gateMs: a.gateMs ?? null, gateCode: a.gateCode ?? null,
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
      const promptFile = join(work, `prompt-r${round}-fix-${n}.md`);
      const resultFile = join(work, `result-r${round}-fix-${n}.json`);
      writePrompt(promptFile, fixPrompt({ finding: entry, group: members(entry), sourceDirs, protectedDirs, resultFile, condition: testInfo(entry.test).condition }));
      // The attempt is on record before the assistant starts: one with no outcome is in progress, so
      // after an interruption its uncommitted changes are known to be the loop's (the dashboard's Continue).
      const attempt = { round, startedAt: new Date().toISOString() };
      // Every finding of the task gets the attempt (and so the same outcome and commit).
      for (const e of members(entry)) e.attempts.push(attempt);
      save();
      const res = await withOutput(`r${round}-fix-${n}`, { command: agentCommand, promptFile, resultFile, cwd, timeout: cfg.agentTimeout }, round, n + 1, 'fix');
      calls.push(res);
      writeFileSync(join(work, `agent-r${round}-fix-${n}.log`), agentLog(res));
      const changed = gitChanged(cwd, sourceDirs);
      const strayChanges = gitChanged(cwd).filter((f) => !changed.includes(f) && !f.startsWith(WORK_DIR) && !f.startsWith('a11y-508-report'));
      if (strayChanges.length) {
        log.warn(`  agent changed files outside ${sourceDirs.join(', ')}; reverting them: ${strayChanges.join(', ')}`);
        git(cwd, ['checkout', '--', ...strayChanges]);
        git(cwd, ['clean', '-fdq', '--', ...strayChanges]);
      }
      const note = res.result && res.result.note ? String(res.result.note).slice(0, 300) : res.timedOut ? 'agent timed out' : res.quota ? `the assistant's provider refused the call for quota or rate limit (after ${res.quotaRetries} retries)` : `agent exit ${res.code}, no result file`;
      Object.assign(attempt, { n: n + 1, files: changed, note, outcome: 'pending', agentMs: res.durationMs ?? null });
      if (changed.length) ev('changes', { round, n: n + 1, m: tasks.length, files: changed });
      if (!changed.length) {
        attempt.outcome = 'no-change';
        log.info(`  no change (${note})`);
        for (const e of members(entry)) {
          if (e.attempts.length < cfg.maxAttempts) continue;
          e.status = 'needs-human';
          e.reason = note;
        }
        if (entry.status === 'needs-human') log.warn(`  marked needs-human after ${entry.attempts.length} attempts`);
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
            e.status = 'needs-human';
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
          x.status = x.attempts.length >= cfg.maxAttempts ? 'needs-human' : 'open';
          if (x.status === 'needs-human') x.reason = 'the fix broke the tests';
        }
        attemptEvent(a.n ?? 0, e, a, 'failed-gate');
      };
      const live = () => roundFixed.filter((e) => e.attempts[e.attempts.length - 1].commit);
      const testsAt = async (label) => {
        log.info(`  tests${label ? ` (${label})` : ''}: ${parts.test}`);
        ev('step', { round, step: 'gate', check: parts.test });
        return runGate(round, null, null, parts.test, 'test');
      };
      log.info(`running the tests once for the round's ${committed} fix(es)`);
      let tests = await testsAt('');
      let reverts = 0;
      if (tests.code !== 0) {
        // Tests that fail without any of this round's fixes are not theirs to answer for.
        const tip = git(cwd, ['rev-parse', 'HEAD']).out;
        git(cwd, ['reset', '-q', '--hard', roundBase]);
        const before = await testsAt('without this round\'s fixes');
        git(cwd, ['reset', '-q', '--hard', tip]);
        if (before.code !== 0) {
          log.warn('the tests also fail without this round\'s fixes; keeping the fixes, which each passed the build');
          tests = { code: 0 };
        }
      }
      while (tests.code !== 0 && reverts < 3 && live().length) {
        const list = live();
        const tip = git(cwd, ['rev-parse', 'HEAD']).out;
        ev('bisect', { round, state: 'start', count: list.length });
        // The first commit whose state fails the tests: a binary search over the round's commits.
        let lo = 0;
        let hi = list.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          git(cwd, ['reset', '-q', '--hard', list[mid].attempts[list[mid].attempts.length - 1].commitFull]);
          const t = await testsAt(`with fixes up to ${list[mid].attempts[list[mid].attempts.length - 1].n}`);
          if (t.code !== 0) hi = mid;
          else lo = mid + 1;
        }
        const culprit = list[lo];
        const ca = culprit.attempts[culprit.attempts.length - 1];
        ev('bisect', { round, state: 'found', n: ca.n ?? 0, test: culprit.test, message: culprit.message, commit: ca.commit });
        log.warn(`  fix ${ca.n} (${culprit.test} "${culprit.message.slice(0, 60)}") breaks the tests; reverting it`);
        // Back to the commit before it, and the later fixes applied again on top.
        const base = lo > 0 ? list[lo - 1].attempts[list[lo - 1].attempts.length - 1].commitFull : roundBase;
        git(cwd, ['reset', '-q', '--hard', base]);
        failAttempt(culprit, tests, `fix ${ca.n} broke the tests`);
        committed--;
        for (const e of list.slice(lo + 1)) {
          const a = e.attempts[e.attempts.length - 1];
          const cp = git(cwd, ['cherry-pick', a.commitFull]);
          if (cp.code !== 0) {
            git(cwd, ['cherry-pick', '--abort']);
            failAttempt(e, tests, `fix ${a.n} could not be applied again after fix ${ca.n} was reverted`);
            committed--;
            continue;
          }
          a.commitFull = git(cwd, ['rev-parse', 'HEAD']).out;
          a.commit = git(cwd, ['rev-parse', '--short', 'HEAD']).out;
          attemptEvent(a.n ?? 0, e, a, 'committed');
        }
        void tip;
        reverts++;
        save();
        ledgerEvent();
        tests = live().length ? await testsAt('after the revert') : { code: 0 };
      }
      if (tests.code !== 0) {
        log.warn(`the tests still fail after ${reverts} revert(s); rolling back this round's fixes`);
        git(cwd, ['reset', '-q', '--hard', roundBase]);
        for (const e of live()) failAttempt(e, tests, 'the round\'s tests failed');
        committed = 0;
      }
      roundFixed.splice(0, roundFixed.length, ...live());
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
          for (const x of members(e)) x.status = x.attempts.length >= cfg.maxAttempts ? 'needs-human' : 'open';
        }
        committed = 0;
        save();
        ledgerEvent();
      }
    }

    if (!committed) {
      log.info(`round ${round}: nothing was fixed. ${summaryLine(ledger)}`);
      if (!openFindings(ledger).length && !byStatus(ledger, 'review').length) {
        log.info('nothing left the agent can fix; stopping.');
        return isDone(ledger) ? 0 : 1;
      }
      if (!byStatus(ledger, 'pending').length) {
        // An assistant that never ran (not installed, not signed in): every call failed without an answer.
        const failed = calls.filter((r) => !r.result && !r.timedOut && !r.quota && r.code !== 0);
        if (calls.length && failed.length === calls.length) {
          log.error(`${agentName} did not run: all ${calls.length} call${calls.length === 1 ? '' : 's'} this round ended without an answer (last exit code ${failed[failed.length - 1].code}). Check that it is installed and signed in (Test assistant on the Fix step), then try again.`);
          return 1;
        }
        log.warn('no fix was committed and nothing is pending, so another round would do the same work again; stopping.');
        return 1;
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
    }

    if (committed) {
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
        log.info('waiting for the deployment: polling the start page until its script bundles change');
        const until = Date.now() + cfg.deployTimeout;
        let live = false;
        const enter = events ? enterFromDashboard() : null;
        let pressed = false;
        if (enter) {
          enter.promise.then(() => (pressed = true));
          ev('await-deploy', { round, committed, nextRound: round + 1 });
        }
        try {
          while (Date.now() < until && !stopped()) {
            await Promise.race([sleep(15000), ...(enter ? [enter.promise] : [])]);
            if (pressed) {
              log.info('told the new build is live (Deployed — continue)');
              live = true;
              break;
            }
            const sig = await bundleSignature(cfg.url);
            if (sig && sig !== signatureBefore) {
              live = true;
              break;
            }
          }
        } finally {
          if (enter) enter.cancel();
        }
        if (!live) {
          if (stopped()) break;
          log.error(`the start page's bundles did not change within ${Math.round(cfg.deployTimeout / 60000)} minutes; stopping. Rerun the loop once the deployment is live.`);
          save();
          return 1;
        }
        log.info('new build is live; giving it 10 seconds to settle');
        await sleep(10000);
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
  return [part('open', 'open'), part('review', 'awaiting triage'), part('pending', 'fixed, awaiting verification'), part('verified', 'verified fixed'), part('needs-human', 'need a person'), part('wont-fix', "won't fix"), part('adequate', 'adequate'), part('gone', 'gone')].filter(Boolean).join(', ') + '.';
}

export function printStatus(cwd, out) {
  const file = join(cwd, WORK_DIR, 'ledger.json');
  if (!existsSync(file)) {
    out(`no ledger at ${relative(cwd, file)}; run "a11y-508 loop <url>" first`);
    return 0;
  }
  const ledger = loadLedger(file);
  out(`a11y-508 loop status: ${ledger.rounds.length} round(s). ${summaryLine(ledger)}`);
  for (const r of ledger.rounds.slice(-5)) out(`  round ${r.round} ${r.at || ''}: ${r.audited}/${r.pages} pages audited, ${r.violations} violations, ${r.reviews} review; +${r.diff.new} new, ${r.diff.verified} verified, ${r.diff.failed} did not hold${r.coverage && !r.coverage.complete ? ', coverage incomplete' : ''}`);
  const groups = [['open', 'OPEN'], ['pending', 'FIXED, AWAITING VERIFICATION'], ['review', 'AWAITING TRIAGE'], ['needs-human', 'NEEDS A PERSON']];
  for (const [status, title] of groups) {
    const list = byStatus(ledger, status);
    if (!list.length) continue;
    out(`\n${title} (${list.length})`);
    for (const e of list.slice(0, 40)) out(`  ${e.test} ${e.impact.padEnd(8)} ${e.message.slice(0, 90)}  [${e.pages.length} page(s), ${e.attempts.length} attempt(s)]${e.reason ? `  ${e.reason}` : ''}`);
    if (list.length > 40) out(`  ... and ${list.length - 40} more`);
  }
  return 0;
}
