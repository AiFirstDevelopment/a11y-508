// The dashboard's local server: plain node:http, no dependencies, Node 18+.
// Serves the built app from ui/dist, and an API on 127.0.0.1 guarded by a
// per-launch secret and a Host check. Drives the CLI as a child process.

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { findChrome } from '../../src/chrome.mjs';
import { PRESETS, installRemedies, runAgent, agentEnv, agentEnvFor, runnableCommand } from '../../src/agent.mjs';
import { loadConfig, normalizeConfig, summaryLine } from '../../src/loop.mjs';
import { migrateRepo, migrationLines, tasksDir } from '../../src/home.mjs';
import { readable } from '../../src/agent-stream.mjs';
import { loadLedger, statusCounts, byStatus } from '../../src/ledger.mjs';
import { BIN, BadRequest, DEFAULT_STATE_FILE, crawlArgs, loopArgs, commandLine } from './args.mjs';
import { detectPresets, detectShell, shellInvocation } from './detect.mjs';
import { Runs } from './runs.mjs';
import { JOURNALED, LOOP_KINDS, discardInterrupted, interruptedDetails, latestRun, resolveRun, runsDir, startJournaled } from './run-journal.mjs';
import { loopDefaults } from './loop-defaults.mjs';
import { readGlobal, writeGlobal, paths as statePaths, legacyFiles, moveLegacy, readSettings, writeJson, WRITTEN_BY, REPO_CONFIG } from './state-dir.mjs';
import { matchSource } from './loop-match.mjs';
import { recordDecision, reviewList } from './review.mjs';
import { carryAnalysis, listReports, readReport, confinedFile, moveLatestToHistory, deleteHistoryEntry, clearHistory, clearLoopHistory, loopTimeline, sameStartUrl, latestDir, ledgerPath } from './reports.mjs';
import { UI_DIR, freshness } from './build-info.mjs';
import { CONFIG_FILE, factsOf, inGitRepo, listDirs, realDir } from './dirs.mjs';

// The wizard's steps, as lastStep stores them.
const STEPS = ['/run', '/live', '/report', '/fix-loop', '/review', '/history'];
const pkg = JSON.parse(readFileSync(join(UI_DIR, '..', 'package.json'), 'utf8'));
export const SECRET_HEADER = 'x-a11y-508-secret';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

const AGENT_TEST_PROMPT = (resultFile) => `# Check that you can run

This is a connectivity check from the a11y-508 dashboard. Do not read, create, change or delete any file other than the one named below, and do not run any command.

Write a JSON file at ${resultFile} with exactly this content and nothing else:

\`\`\`json
{ "ok": true }
\`\`\`

Machine-readable copy:

\`\`\`json
${JSON.stringify({ kind: 'test', resultFile }, null, 2)}
\`\`\`
`;

export function createDashboard({ cwd: startDir = process.cwd(), launchDir = startDir, restored = false, env = process.env, platform = process.platform, distDir = join(UI_DIR, 'dist'), uiDir = UI_DIR, agentTestTimeout = 180000, onQuit = null, onOpen = null } = {}) {
  const secret = randomBytes(24).toString('hex');
  // Report files (<img>, a new tab) cannot send the header, so they take a
  // cookie instead: a separate value that opens report files and nothing else.
  const fileSecret = randomBytes(24).toString('hex');
  // cwd is the working directory every handler reads at the time of each
  // request. It is set in exactly two places: here at launch (--dir, else
  // process.cwd()), and by PUT /api/cwd. launchDir is where it started.
  const state = { browserPort: null, separateSignIn: false, cwd: resolve(startDir), launchDir: resolve(launchDir), restored, token: null, port: null, presets: null, detecting: null, lastTest: {}, shell: null, lastSeen: Date.now(), streams: 0 };
  // The shell the shown command line is written for; looked up once.
  const shellKind = () => (state.shell ||= detectShell(env, platform)).kind;
  const runs = new Runs({ onExit: () => {} });
  const build = freshness(uiDir);
  // The dashboard's own files for the working directory (state-dir.mjs).
  const sp = () => statePaths(state.cwd, env, platform);
  // The repository's own a11y-508.config.json (a team's, for CI): used as is, never written. One
  // the dashboard wrote before it kept its files elsewhere is moved out instead (see settle()).
  const repoConfig = () => {
    const f = join(state.cwd, REPO_CONFIG);
    if (!existsSync(f)) return null;
    try {
      const c = JSON.parse(readFileSync(f, 'utf8'));
      return c && c.writtenBy === WRITTEN_BY ? null : f;
    } catch {
      return f;
    }
  };
  const configPath = () => repoConfig() || sp().config;
  // A repository config is asked about (move it out?) only when it looks like one the dashboard
  // wrote before it marked its files: it names an "agent" and holds no "writtenBy". A team's
  // committed config is tracked by git and left alone.
  const repoConfigTeam = (cwd) => {
    const r = spawnSync('git', ['ls-files', '--error-unmatch', REPO_CONFIG], { cwd, encoding: 'utf8', windowsHide: true });
    return r.status === 0;
  };
  // On launch and on each switch: move the tool's old in-repository folders to its own folder for
  // the repository (src/home.mjs), and the dashboard's own marked files out of the repository.
  const settle = () => {
    try {
      for (const l of migrationLines(migrateRepo(state.cwd))) console.log(`a11y-508: ${l}`);
    } catch (e) {
      console.error(`a11y-508: could not move the tool's old folders out of ${state.cwd}: ${e.message}`);
    }
    const ours = legacyFiles(state.cwd).filter((f) => f.ours).map((f) => f.name);
    if (ours.length) moveLegacy(state.cwd, sp(), ours);
  };
  settle();

  // The newest run recorded for the folder: a live one is reattached (its whole log, then the rest
  // as it comes); a fix loop whose process is gone without finishing is offered as interrupted; and
  // a fix loop that ended stays the current run, so after a relaunch the Fix step shows its outcome
  // ("could not start", "stopped", "Loop finished") exactly as before.
  const reattach = () => {
    if (runs.active) return;
    let run = null;
    try {
      run = latestRun(state.cwd);
    } catch {}
    if (!run) return;
    if (run.status === 'running' || LOOP_KINDS.has(run.kind)) runs.adopt(run);
  };
  reattach();

  // A forced detection never reuses one that started before it was asked for. Tests can slow the
  // lookup down (A11Y_508_DETECT_DELAY_MS) to stand in for a slow machine.
  const detectDelay = Number(env.A11Y_508_DETECT_DELAY_MS) || 0;
  const detect = (force = false) => {
    if (state.detecting && !force) return state.detecting;
    if (state.presets && !force) return Promise.resolve(state.presets);
    const p = (state.detecting && force ? state.detecting.catch(() => {}) : Promise.resolve())
      .then(() => (detectDelay ? new Promise((r) => setTimeout(r, detectDelay)) : null))
      .then(() => detectPresets({ env, platform }))
      .then((d) => {
        state.presets = d;
        return d;
      })
      .finally(() => {
        if (state.detecting === p) state.detecting = null;
      });
    state.detecting = p;
    return p;
  };

  const global = () => readGlobal(env, platform);
  const setGlobal = (patch) => {
    try {
      return writeGlobal(patch, env, platform);
    } catch {
      return global();
    }
  };

  const tokens = () => [state.token, env.TOKEN].filter(Boolean);
  // Cookie and header values a run was given: kept out of its record and its events file.
  const credentialsIn = (body) => {
    const out = [];
    const auth = (body && body.auth) || {};
    const cookies = Array.isArray(auth.cookies) ? auth.cookies : String(auth.cookies || '').split('\n');
    for (const c of cookies.map((x) => String(x).trim()).filter(Boolean)) {
      out.push(c);
      const eq = c.indexOf('=');
      if (eq > 0) out.push(c.slice(eq + 1).trim());
    }
    const opts = (body && body.options) || {};
    const headers = [opts.header, opts['token-header']].flat().filter((h) => typeof h === 'string' && h.trim());
    for (const h of headers.flatMap((x) => x.split('\n')).map((x) => x.trim()).filter(Boolean)) {
      out.push(h);
      const colon = h.indexOf(':');
      if (colon > 0) {
        const v = h.slice(colon + 1).trim();
        out.push(v);
        for (const part of v.split(/\s+/)) if (part.length >= 8) out.push(part);
      }
    }
    return out.sort((a, b) => b.length - a.length);
  };

  // ---- helpers
  const send = (res, status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(text);
  };
  const readBody = (req) => new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new BadRequest('request body too large', 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new BadRequest('body is not JSON'));
      }
    });
    req.on('error', reject);
  });
  const sendFile = (res, file, extraHeaders = {}) => {
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'x-content-type-options': 'nosniff', ...extraHeaders });
    createReadStream(file).pipe(res);
  };
  const same = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && timingSafeEqual(x, y);
  };
  const cookieName = () => `a11y508_${state.port}`;
  const authorized = (req, allowCookie) => {
    const h = req.headers[SECRET_HEADER];
    if (typeof h === 'string' && same(h.replace(/^Bearer\s+/i, '').trim(), secret)) return true;
    if (allowCookie) {
      const m = new RegExp(`(?:^|;\\s*)${cookieName()}=([0-9a-f]+)`).exec(req.headers.cookie || '');
      if (m && same(m[1], fileSecret)) return true;
    }
    return false;
  };
  const hostOk = (req) => {
    const host = String(req.headers.host || '').toLowerCase();
    return host === `127.0.0.1:${state.port}` || host === `localhost:${state.port}`;
  };

  // ---- the run environment: TOKEN only when this run is meant to send it
  const childEnv = (tokenMode) => {
    const e = { ...env };
    // A crawl attached to the dashboard's browser brings the dashboard's tab back when it ends.
    if (state.browserPort && state.port) e.A11Y_508_RETURN_URL = `http://127.0.0.1:${state.port}/`;
    delete e.TOKEN;
    if (tokenMode === 'form') {
      if (!state.token) throw new BadRequest('enter a token, or choose another way to sign in');
      e.TOKEN = state.token;
    } else if (tokenMode === 'env') {
      if (!env.TOKEN) throw new BadRequest('TOKEN is not set in the environment the dashboard was started from');
      e.TOKEN = env.TOKEN;
    }
    return e;
  };

  const agentCommand = (spec) => {
    if (!spec) return null;
    if (PRESETS[spec]) {
      const p = state.presets && state.presets.presets.find((x) => x.name === spec);
      return p && p.found ? p.command : PRESETS[spec];
    }
    return spec;
  };

  async function startRun(body) {
    const kind = body.kind;
    const cwd = state.cwd;
    if (!['crawl', 'troubleshoot', 'login', 'loop', 'dry-run'].includes(kind)) throw new BadRequest(`unknown run kind "${kind}"`);
    if (runs.active) throw new BadRequest(`a ${runs.current.kind} run is already active`, 409);
    // The sign-in session lives in the dashboard's own directory, never in the repository.
    let auth = body.auth || { mode: 'none' };
    if (['state', 'signin'].includes(auth.mode) || kind === 'login') auth = { ...auth, file: sp().state };
    // In the dashboard's own browser, the sign-in and the crawl are tabs in its window (--connect).
    if (auth.mode === 'signin' && state.browserPort) auth = { ...auth, connect: state.browserPort };
    if (auth.mode === 'token' && typeof auth.token === 'string' && auth.token.trim()) state.token = auth.token.trim();
    let built;
    let meta;
    if (kind === 'loop' || kind === 'dry-run') {
      if (kind === 'loop') await detect();
      const cfg = loadConfig(configPath(), cwd);
      const chosen = body.agent || cfg.agent || null;
      const resolved = kind === 'loop' ? agentCommand(chosen) : null;
      // A preset found off PATH runs by its absolute path; otherwise the
      // config's "agent" stands unless the request names another.
      let agentArg = null;
      if (resolved && PRESETS[chosen] && resolved !== PRESETS[chosen]) agentArg = resolved;
      else if (resolved && body.agent) agentArg = body.agent;
      // The config and the session from the dashboard's directory (or the repository's own config).
      const signIn = body.signIn === true;
      // Fix the violations starts from the latest report when it is for the loop's URL.
      const latest = kind === 'loop' ? readReport(cwd, 'latest') : null;
      const loopUrl = body.url || cfg.url;
      const sameUrl = (a, b) => {
        try {
          const x = new URL(a);
          const y = new URL(b);
          return x.origin === y.origin && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '');
        } catch {
          return false;
        }
      };
      const fromReport = latest && loopUrl && sameUrl(latest.baseUrl, loopUrl) ? join(latestDir(cwd), 'report.json') : null;
      built = loopArgs({ kind, url: body.url, options: body.options, auth, maxRounds: body.maxRounds, agent: agentArg, signIn, config: configPath(), stateFile: signIn || existsSync(sp().state) ? sp().state : null, connect: signIn ? state.browserPort : null, fromReport, resume: body.resume === true });
      meta = { agent: resolved };
    } else {
      built = crawlArgs({ kind, url: body.url, options: body.options, auth });
      if (kind === 'crawl' && typeof body.url === 'string' && body.url) setGlobal({ lastUrl: body.url });
    }
    const runEnv = childEnv(built.token);
    // A switch that landed while this request waited must not start a run in the old directory.
    if (cwd !== state.cwd) throw new BadRequest('the working directory changed while the run was starting; start it again', 409);
    let moved = null;
    if (kind === 'crawl') moved = moveLatestToHistory(cwd);
    // The request as it can be made again (Continue), without its credentials (a token, cookies,
    // extra headers): those are never written to the run's record.
    const { preface, ...asked } = body;
    const request = { ...asked, auth: asked.auth && typeof asked.auth === 'object' ? { ...asked.auth, token: undefined, cookies: undefined } : asked.auth };
    if (request.options && typeof request.options === 'object') request.options = { ...request.options, header: undefined, 'token-header': undefined };
    const spec = {
      // A crawl's report goes to the tool's own folder for the repository, never into it.
      kind, file: process.execPath, args: [BIN, ...built.args, ...(kind === 'crawl' ? ['--out', latestDir(cwd)] : []), '--events'], env: runEnv, cwd, events: true, secrets: [...tokens(), ...credentialsIn(body)],
      meta: { ...meta, command: commandLine({ cwd, args: built.args, token: built.token, shell: shellKind() }), url: body.url || null, movedToHistory: moved },
      request, preface: Array.isArray(preface) ? preface : [],
    };
    // Detached and recorded on disk, so it outlives this server (run-journal.mjs).
    if (JOURNALED.has(kind)) return runs.adopt(startJournaled(spec));
    return runs.start(spec);
  }

  async function startInstall(body) {
    const keys = Object.keys(body || {});
    if (keys.length !== 1 || keys[0] !== 'agent' || typeof body.agent !== 'string' || !PRESETS[body.agent]) throw new BadRequest('body must be exactly { "agent": "claude" | "gemini" | "codex" }');
    if (runs.active) throw new BadRequest(`a ${runs.current.kind} run is already active`, 409);
    const d = await detect();
    const preset = d.presets.find((p) => p.name === body.agent);
    const command = preset.install;
    const [file, args] = shellInvocation(d.shell, command);
    return runs.start({
      kind: 'install', file, args, env: agentEnv(env), cwd: state.cwd, events: false, secrets: tokens(),
      meta: { agent: body.agent, command, shell: d.shell.name },
      finish: async ({ code, output }) => {
        const again = await detect(true);
        const now = again.presets.find((p) => p.name === body.agent);
        return { agent: body.agent, found: now.found, remedies: installRemedies({ code, output, shell: again.shell.path, platform, found: now.found, npmPrefix: again.npmPrefix }) };
      },
    });
  }

  async function testAgent(body) {
    const spec = body && body.agent;
    if (typeof spec !== 'string' || !spec.trim()) throw new BadRequest('agent is required');
    if (!PRESETS[spec] && !spec.includes('{promptFile}')) throw new BadRequest('a custom command must contain {promptFile}');
    await detect();
    const command = agentCommand(spec);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'a11y-508-agent-test-')));
    const promptFile = join(dir, 'prompt.md');
    const resultFile = join(dir, 'result.json');
    writeFileSync(promptFile, AGENT_TEST_PROMPT(resultFile));
    try {
      const r = await runAgent({ command, promptFile, resultFile, cwd: dir, timeout: agentTestTimeout, env: agentEnvFor(command, agentEnv(env)), quotaDelays: [] });
      const ok = !!(r.result && r.result.ok === true);
      // A streaming assistant's events as the readable lines the Fix step's pane shows.
      const out = redactorFor()(`${readable(r.stdout, { cwd: dir }).lines.join('\n')}\n${r.stderr}`).split('\n').filter((l) => l.trim()).slice(-30);
      const result = { agent: spec, command, status: r.timedOut ? 'timed-out' : ok ? 'ready' : 'failed', code: r.code, durationMs: r.durationMs, output: out, at: new Date().toISOString() };
      state.lastTest[spec] = result;
      return result;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const redactorFor = () => (t) => tokens().reduce((s, tok) => s.split(tok).join('[redacted]'), t);

  function envInfo(d) {
    const cwd = state.cwd;
    let browser;
    try {
      browser = { found: true, path: findChrome() };
    } catch (e) {
      browser = { found: false, path: null, error: e.message };
    }
    const sessionFile = sp().state;
    let session = { exists: false, file: sessionFile };
    if (existsSync(sessionFile)) {
      const st = statSync(sessionFile);
      let capturedAt = null;
      let origins = [];
      try {
        const j = JSON.parse(readFileSync(sessionFile, 'utf8'));
        capturedAt = j.capturedAt || null;
        // The origins the session covers (origins only; never cookies or storage values).
        origins = [...new Set([...(Array.isArray(j.origins) ? j.origins : []), ...Object.keys(j.storage || {})].filter((o) => typeof o === 'string'))];
      } catch {}
      session = { exists: true, file: sessionFile, ageMs: Date.now() - st.mtimeMs, capturedAt, origins };
    }
    const latest = readReport(cwd, 'latest');
    return {
      cwd, cwdFacts: factsOf(cwd), inGitRepo: inGitRepo(cwd), launchDir: state.launchDir, version: pkg.version, platform, browser,
      config: { exists: existsSync(configPath()), file: configPath(), repository: !!repoConfig() },
      stateDir: sp().dir,
      // Files the dashboard may have left in the repository before; asked about once.
      legacy: readSettings(sp().settings).migrationDeclined ? [] : legacyFiles(cwd).filter((f) => !f.ours && (f.name !== REPO_CONFIG || !repoConfigTeam(cwd))).map((f) => f.name),
      session,
      report: latest ? { exists: true, finishedAt: latest.finishedAt, baseUrl: latest.baseUrl } : { exists: false },
      // Crawls and fix rounds on record (History has something to show).
      pastRuns: listReports(cwd).length,
      tokenInEnv: !!env.TOKEN, tokenHeld: !!state.token,
      // Where a sign-in opens: a tab in the dashboard's own window, or a separate window.
      signIn: state.browserPort ? 'tab' : state.separateSignIn ? 'separate-window' : 'window',
      // The assistants are detected in the background (on Windows this can take tens of seconds):
      // until then presets is null and detecting true, and the Fix step asks again.
      detecting: !d, last: { cwd: global().lastCwd || null, url: global().lastUrl || null }, restored: state.restored,
      shell: d ? d.shell : null, npmPrefix: d ? d.npmPrefix : null, detectedAt: d ? d.detectedAt : null,
      // runCommand: what a person can paste into their shell to run the assistant by hand, on the
      // prompt file the loop writes (<tasks folder>/prompt.md stands for the next task's file).
      presets: !d ? null : d.presets.map((p) => ({ ...p, runCommand: p.found ? runnableCommand({ name: p.name, exePath: p.path, promptFile: join(tasksDir(cwd), 'prompt.md'), shell: d.shell.kind === 'powershell' || d.shell.kind === 'cmd' ? d.shell.kind : d.shell.path, platform }) : null })),
      lastTest: state.lastTest,
      build: { fresh: build.fresh, reason: build.reason },
      run: runs.current ? runSummary(runs.current) : null,
      // The wizard step the person was on, for the next time the dashboard opens.
      lastStep: readSettings(sp().settings).lastStep || null,
    };
  }
  const runSummary = (r) => ({ id: r.id, kind: r.kind, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt || null, code: r.code, meta: r.meta });

  function ledgerInfo() {
    const file = ledgerPath(state.cwd);
    if (!existsSync(file)) return { exists: false };
    const ledger = loadLedger(file);
    const pick = (status) => byStatus(ledger, status).map((e) => ({ test: e.test, impact: e.impact, message: e.message, pages: e.pages.length, attempts: e.attempts.length, reason: e.reason || null, selector: e.selector }));
    return {
      exists: true, rounds: ledger.rounds, counts: statusCounts(ledger), line: summaryLine(ledger),
      lists: { open: pick('open'), pending: pick('pending'), review: pick('review'), 'needs-human': pick('needs-human') },
    };
  }

  function readConfig() {
    const file = configPath();
    const c = loadConfig(file, state.cwd);
    const { _path, _missing, writtenBy, ...config } = c;
    return { exists: !_missing, file, repository: !!repoConfig(), config: _missing ? {} : config };
  }

  // The core's own validation. A missing agent is a warning, not an error:
  // a dry run needs none, exactly as `a11y-508 loop --dry-run` accepts it.
  function writeConfig(body) {
    const config = body && body.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new BadRequest('body must be { "config": { ... } }');
    const { errors } = normalizeConfig(config, {}, { interactive: true });
    const hard = errors.filter((e) => !/^no agent/.test(e));
    if (hard.length) {
      const err = new BadRequest(hard.join('; '));
      err.errors = hard;
      throw err;
    }
    // The repository's own config is used as is; the dashboard never changes it.
    if (repoConfig()) throw new BadRequest(`the repository's ${REPO_CONFIG} is used as is; the dashboard does not change it`, 409);
    // Whole or not at all, in the dashboard's own directory, marked as the dashboard's.
    writeJson(sp().config, { ...config, writtenBy: WRITTEN_BY });
    return { ...readConfig(), warnings: errors.filter((e) => /^no agent/.test(e)) };
  }

  // PUT /api/cwd: switch the working directory, never during a run, and only
  // to a readable directory; on any error state.cwd is unchanged.
  async function switchCwd(body) {
    const keys = Object.keys(body || {});
    const okKeys = keys.every((k) => k === 'path' || k === 'carry');
    if (!okKeys || typeof body.path !== 'string' || (body.carry !== undefined && typeof body.carry !== 'string')) throw new BadRequest('body must be { "path": "<absolute path>", "carry"?: "<start URL>" }');
    if (runs.active) throw new BadRequest(`a ${runs.current.kind} run is active; switch when it has finished`, 409);
    const dir = realDir(body.path);
    // The analysis belongs to the URL: with the URL unchanged it comes along to the new folder.
    let carried = null;
    if (body.carry) {
      try {
        carried = carryAnalysis(state.cwd, dir, body.carry, { inGit: inGitRepo });
      } catch (e) {
        carried = { error: e.message };
      }
    }
    state.cwd = dir;
    settle();
    // A finished run belongs to the directory it ran in.
    runs.forget();
    reattach();
    state.restored = false;
    // Remembered for the next launch (the dashboard's own browser profile may forget it).
    setGlobal({ lastCwd: dir });
    // Cached detection (the assistants, the shell, npm's prefix) does not
    // depend on the directory, so nothing else is invalidated today.
    return { ...envInfo(state.presets), carried };
  }

  // The folders the loop edits (the config's, or what the dashboard inferred).
  const sourceDirs = () => {
    const c = readConfig();
    const d = loopDefaults(state.cwd, c.exists ? c.config : null).effective;
    return (Array.isArray(d.source) ? d.source : [d.source]).filter((x) => typeof x === 'string' && x);
  };

  // Continue after an interruption: the attempt that was in progress is marked interrupted and its
  // uncommitted changes under the source folders reverted (listed in the new run's pane); then the
  // loop goes on from the ledger, with no crawl.
  async function resume() {
    const r = runs.current;
    if (!r || r.status !== 'interrupted' || !LOOP_KINDS.has(r.kind)) throw new BadRequest('there is no interrupted fix loop to continue', 409);
    const request = (r.record && r.record.request) || {};
    const where = interruptedDetails(state.cwd, r, []);
    const discarded = discardInterrupted(state.cwd, sourceDirs());
    resolveRun(r, 'continued');
    runs.forget();
    const preface = [{ type: 'resume', discarded, n: where.n, m: where.m, round: where.round, interruptedAt: where.at, at: new Date().toISOString() }];
    try {
      return await startRun({ ...request, kind: r.kind, resume: r.kind === 'loop', signIn: request.signIn === true && !existsSync(sp().state), preface });
    } catch (e) {
      // Not started: the interruption is offered again.
      reattach();
      throw e;
    }
  }

  // Start over: what it discards, named in its confirmation.
  function startOverInfo() {
    const file = ledgerPath(state.cwd);
    let attempts = 0;
    let rounds = 0;
    if (existsSync(file)) {
      const l = loadLedger(file);
      rounds = l.rounds.length;
      for (const e of Object.values(l.findings || {})) attempts += (e.attempts || []).length;
    }
    const latest = readReport(state.cwd, 'latest');
    const url = (latest && latest.baseUrl) || readSettings(sp().settings).url || global().lastUrl || null;
    const history = listReports(state.cwd).filter((x) => x.source === 'history' && (!url || !x.baseUrl || sameStartUrl(x.baseUrl, url))).length;
    return { report: !!latest, ledger: existsSync(file), rounds, attempts, history, url };
  }
  // Clears the report, the ledger and its rounds, the history for the URL, the run records and the
  // stored step: the wizard starts at Set up. Only with { confirm: true }, and never during a run.
  function startOver(body) {
    if (!body || body.confirm !== true) throw new BadRequest('body must be { "confirm": true }');
    if (runs.active) throw new BadRequest(`a ${runs.current.kind} run is active; start over when it has finished`, 409);
    const info = startOverInfo();
    if (runs.current) {
      if (runs.current.journal) resolveRun(runs.current, 'start-over');
      runs.forget();
    }
    clearLoopHistory(state.cwd);
    for (const x of listReports(state.cwd)) {
      if (x.source === 'history' && (!info.url || !x.baseUrl || sameStartUrl(x.baseUrl, info.url))) deleteHistoryEntry(state.cwd, x.id);
    }
    rmSync(latestDir(state.cwd), { recursive: true, force: true, maxRetries: 5 });
    rmSync(runsDir(state.cwd), { recursive: true, force: true, maxRetries: 5 });
    const { lastStep, ...rest } = readSettings(sp().settings);
    writeJson(sp().settings, rest);
    return { ...info, cleared: true };
  }

  // ---- routing
  async function api(req, res, url) {
    const path = url.pathname;
    const m = req.method;
    const reportFile = /^\/api\/reports\/([^/]+)\/(screenshots\/.+|report\.html)$/.exec(path);
    if (!authorized(req, m === 'GET' && !!reportFile)) return send(res, 401, { error: 'missing or wrong session secret' });

    if (reportFile) {
      let rel;
      try {
        rel = decodeURIComponent(reportFile[2]);
      } catch {
        return send(res, 404, { error: 'not found' });
      }
      const file = confinedFile(state.cwd, decodeURIComponent(reportFile[1]), rel);
      if (!file) return send(res, 404, { error: 'not found' });
      return sendFile(res, file, { 'cache-control': 'no-store' });
    }
    if (m === 'GET' && path === '/api/env') {
      // Never waits for the assistants: the Set up dialog and the Crawl step need only the folder.
      const refresh = url.searchParams.get('refresh') === '1';
      const pending = detect(refresh);
      pending.catch(() => {});
      const d = refresh || url.searchParams.get('wait') === '1' ? await pending : state.presets;
      return send(res, 200, envInfo(d), { 'set-cookie': `${cookieName()}=${fileSecret}; Path=/api/reports; HttpOnly; SameSite=Strict` });
    }
    if (m === 'GET' && path === '/api/dirs') return send(res, 200, listDirs(url.searchParams.get('path'), platform));
    if (m === 'PUT' && path === '/api/cwd') return send(res, 200, await switchCwd(await readBody(req)));
    if (m === 'POST' && path === '/api/agent/install') return send(res, 202, runSummary(await startInstall(await readBody(req))));
    if (m === 'POST' && path === '/api/agent/test') return send(res, 200, await testAgent(await readBody(req)));
    if (m === 'POST' && path === '/api/runs') return send(res, 202, runSummary(await startRun(await readBody(req))));
    if (m === 'GET' && path === '/api/runs/current') return send(res, 200, runs.current ? runSummary(runs.current) : null);
    if (m === 'GET' && path === '/api/runs/current/events') {
      if (!runs.current) return send(res, 404, { error: 'no run yet' });
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': stream\n\n');
      state.streams++;
      const unsubscribe = runs.subscribe((e) => {
        if (e === null) return res.end();
        res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
      });
      req.on('close', () => {
        state.streams--;
        if (unsubscribe) unsubscribe();
      });
      return;
    }
    if (m === 'POST' && path === '/api/runs/current/stop') return send(res, 200, { signal: runs.stop() });
    if (m === 'POST' && path === '/api/runs/current/continue') {
      runs.continue();
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && path === '/api/runs/interrupted') {
      const r = runs.current;
      if (!r || r.status !== 'interrupted') return send(res, 200, null);
      return send(res, 200, interruptedDetails(state.cwd, r, sourceDirs()));
    }
    if (m === 'POST' && path === '/api/runs/resume') return send(res, 202, runSummary(await resume()));
    if (m === 'GET' && path === '/api/ping') return send(res, 200, { ok: true, pid: process.pid, cwd: state.cwd });
    // The dashboard's Quit: with a run active, only once the person confirmed stopping it.
    if (m === 'POST' && path === '/api/quit') {
      const body = await readBody(req);
      if (!onQuit) return send(res, 501, { error: 'this dashboard cannot be quit from the page' });
      if (runs.active && body.stopRun !== true) return send(res, 409, { error: `a ${runs.current.kind} run is active`, kind: runs.current.kind });
      send(res, 200, { ok: true });
      setTimeout(() => onQuit(), 50);
      return;
    }
    // A second launch of the dashboard asks this one to open its window again.
    if (m === 'POST' && path === '/api/open') {
      if (!onOpen) return send(res, 501, { error: 'no browser to open' });
      await onOpen();
      return send(res, 200, { ok: true, cwd: state.cwd });
    }
    if (m === 'GET' && path === '/api/start-over') return send(res, 200, startOverInfo());
    if (m === 'POST' && path === '/api/start-over') return send(res, 200, startOver(await readBody(req)));
    if (m === 'GET' && path === '/api/reports') return send(res, 200, listReports(state.cwd));
    if (m === 'GET' && path === '/api/loop/timeline') {
      const file = ledgerPath(state.cwd);
      if (!existsSync(file)) return send(res, 200, null);
      const ledger = loadLedger(file);
      return send(res, 200, loopTimeline(ledger, statusCounts(ledger)));
    }
    if (m === 'DELETE' && path === '/api/loop/history') {
      if (runs.active) return send(res, 409, { error: `a ${runs.current.kind} run is active; clear the fix loop's history when it has finished` });
      return send(res, 200, clearLoopHistory(state.cwd));
    }
    if (m === 'DELETE' && (path === '/api/reports/history' || /^\/api\/reports\/[^/]+$/.test(path))) {
      if (runs.active) return send(res, 409, { error: `a ${runs.current.kind} run is active; delete reports when it has finished` });
      if (path === '/api/reports/history') return send(res, 200, clearHistory(state.cwd));
      let id;
      try {
        id = decodeURIComponent(path.slice('/api/reports/'.length));
      } catch {
        return send(res, 400, { error: 'bad report id' });
      }
      const r = deleteHistoryEntry(state.cwd, id);
      return send(res, r.status, r.body);
    }
    const rm = /^\/api\/reports\/([^/]+)$/.exec(path);
    if (m === 'GET' && rm) {
      const r = readReport(state.cwd, decodeURIComponent(rm[1]));
      return r ? send(res, 200, r) : send(res, 404, { error: 'no such report' });
    }
    if (m === 'GET' && path === '/api/ledger') return send(res, 200, ledgerInfo());
    if (m === 'GET' && path === '/api/config') return send(res, 200, readConfig());
    // The dashboard's remembered choices for this directory (start URL, assistant), server-side.
    // The last start URL, for the next launch (PUT { url }).
    if (m === 'PUT' && path === '/api/last') {
      const body = await readBody(req);
      if (!body || typeof body.url !== 'string' || body.url.length > 4096) throw new BadRequest('body must be { "url": "<start URL>" }');
      return send(res, 200, setGlobal({ lastUrl: body.url.trim() }));
    }
    if (m === 'GET' && path === '/api/settings') return send(res, 200, readSettings(sp().settings));
    if (m === 'PUT' && path === '/api/settings') {
      const body = await readBody(req);
      const allowed = ['url', 'agent', 'migrationDeclined', 'rounds', 'lastStep'];
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !allowed.includes(k))) throw new BadRequest(`body may hold only ${allowed.join(', ')}`);
      if ('lastStep' in body && body.lastStep !== null && !STEPS.includes(body.lastStep)) throw new BadRequest(`lastStep must be one of ${STEPS.join(', ')}`);
      const next = { ...readSettings(sp().settings), ...body };
      writeJson(sp().settings, next);
      return send(res, 200, next);
    }
    // The answer to "Move the dashboard's files out of this repository?": { move: true | false }.
    if (m === 'POST' && path === '/api/migrate') {
      const body = await readBody(req);
      if (!body || typeof body.move !== 'boolean') throw new BadRequest('body must be { "move": true | false }');
      if (runs.active) throw new BadRequest(`a ${runs.current.kind} run is active; move the files when it has finished`, 409);
      // Never a config the repository tracks (a team's): only what the dashboard left behind.
      const names = legacyFiles(state.cwd).filter((f) => !f.ours && (f.name !== REPO_CONFIG || !repoConfigTeam(state.cwd))).map((f) => f.name);
      const moved = body.move ? moveLegacy(state.cwd, sp(), names) : [];
      writeJson(sp().settings, { ...readSettings(sp().settings), migrationDeclined: true });
      return send(res, 200, { moved });
    }
    if (m === 'GET' && path === '/api/loop/defaults') {
      const c = readConfig();
      return send(res, 200, loopDefaults(state.cwd, c.exists ? c.config : null));
    }
    // Whether the folders the loop would edit hold the markup of the latest report's findings.
    if (m === 'GET' && path === '/api/loop/match') {
      const c = readConfig();
      const eff = loopDefaults(state.cwd, c.exists ? c.config : null).effective.source;
      const source = (Array.isArray(eff) ? eff : [eff]).filter((d) => typeof d === 'string' && d);
      const latest = readReport(state.cwd, 'latest');
      if (!latest) return send(res, 200, { report: false, source, checked: 0, found: 0, examples: [] });
      return send(res, 200, { report: true, source, ...matchSource(state.cwd, latest, source) });
    }
    // The Needs a person screen: the findings waiting for a person, and their decisions (review.mjs).
    if (m === 'GET' && path === '/api/review') {
      const c = readConfig();
      const d = loopDefaults(state.cwd, c.exists ? c.config : null).effective;
      const source = (Array.isArray(d.source) ? d.source : [d.source]).filter((x) => typeof x === 'string' && x);
      return send(res, 200, reviewList(state.cwd, { sourceDirs: source, url: (c.exists && c.config.url) || null }));
    }
    if (m === 'POST' && path === '/api/ledger/decision') {
      const body = await readBody(req);
      // The running loop holds the ledger and would write over the decision.
      if (runs.active && ['loop', 'dry-run'].includes(runs.current.kind)) throw new BadRequest('the fix loop is running; record the decision when it has finished', 409);
      return send(res, 200, recordDecision(state.cwd, body));
    }
    if (m === 'PUT' && path === '/api/config') return send(res, 200, writeConfig(await readBody(req)));
    if (m === 'GET' && path === '/api/command') {
      let form;
      try {
        form = JSON.parse(url.searchParams.get('form') || '{}');
      } catch {
        throw new BadRequest('form must be JSON');
      }
      if (form.auth && ['state', 'signin'].includes(form.auth.mode)) form.auth = { ...form.auth, file: sp().state };
      const built = form.kind === 'loop' || form.kind === 'dry-run' ? loopArgs(form) : crawlArgs(form);
      return send(res, 200, { command: commandLine({ cwd: state.cwd, args: built.args, token: built.token, shell: shellKind() }) });
    }
    return send(res, 404, { error: 'not found' });
  }

  function staticFile(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    const root = resolve(distDir);
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, 'bad path');
    }
    const file = resolve(root, '.' + rel);
    const inside = file === root || file.startsWith(root + sep);
    if (inside && extname(file) && existsSync(file) && statSync(file).isFile()) {
      return sendFile(res, file, { 'cache-control': /\.(js|css|woff2)$/.test(file) && /-[A-Z0-9]{8,}\./.test(file) ? 'public, max-age=31536000, immutable' : 'no-store' });
    }
    if (extname(rel) && rel !== '/') return send(res, 404, 'not found');
    const index = join(root, 'index.html');
    if (!existsSync(index)) return send(res, 500, 'The dashboard has not been built: run npm --prefix ui ci && npm --prefix ui run build');
    return sendFile(res, index, { 'cache-control': 'no-store' });
  }

  const server = createServer(async (req, res) => {
    if (!hostOk(req)) return send(res, 403, { error: 'forbidden host' });
    state.lastSeen = Date.now();
    const url = new URL(req.url, `http://127.0.0.1:${state.port}`);
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else staticFile(req, res, url);
    } catch (e) {
      if (res.headersSent) return res.end();
      const status = e.status || 500;
      send(res, status, { error: e.message, ...(e.errors ? { errors: e.errors } : {}) });
    }
  });

  async function listen(port = 5508, { tries = 20 } = {}) {
    for (let i = 0; i <= tries; i++) {
      const p = port === 0 ? 0 : port + i;
      try {
        await new Promise((ok, fail) => {
          server.once('error', fail);
          server.listen(p, '127.0.0.1', () => {
            server.off('error', fail);
            ok();
          });
        });
        state.port = server.address().port;
        return state.port;
      } catch (e) {
        if (e.code !== 'EADDRINUSE' || port === 0) throw e;
      }
    }
    throw new Error(`no free port from ${port} to ${port + tries}`);
  }

  async function close() {
    await runs.killAll();
    server.closeAllConnections?.();
    return new Promise((r) => server.close(() => r()));
  }

  // For the idle shutdown (main.mjs): when anything last asked, whether a page holds a run's stream
  // open, and whether a run is active.
  const activity = () => ({ lastSeen: state.lastSeen, streams: state.streams, running: runs.active });

  // The dashboard's own browser (main.mjs): its DevTools port, for --connect; or none, with
  // { separate: true } when it was looked for and not found.
  function useBrowser(port, { separate = false } = {}) {
    state.browserPort = port || null;
    state.separateSignIn = !port && separate;
  }

  return { server, secret, listen, close, runs, build, detect, useBrowser, activity, get cwd() { return state.cwd; }, get port() { return state.port; }, get url() { return `http://127.0.0.1:${state.port}/#secret=${secret}`; } };
}

